const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'public', 'profile.html'), 'utf8');
function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Actual public renderer source missing: ${start}`);
  return source.slice(from, to);
}
const hoursSource = sourceBetween('function parseTimePart(', 'function normalizeList(');
const contentSource = sourceBetween('function parseStructuredList(', 'function quickCardStep(');
const cardSource = sourceBetween('let quickInfoReturnFocus=', 'function parseStructuredList(');
const modalSource = sourceBetween('const quickInfoModal=document.getElementById(', 'async function load(');
const escapeSource = source.match(/function escapeHtml[^\n]+/)[0];
const plain = value => JSON.parse(JSON.stringify(value));

function hoursAt(day = 2, hour = 1, minute = 0) {
  class Clock extends Date {
    getDay() { return day; }
    getHours() { return hour; }
    getMinutes() { return minute; }
  }
  return vm.runInNewContext(hoursSource + ';({parseHoursText,todayHours})', { Date: Clock });
}

function weekly(overnightDay) {
  return JSON.stringify(Array.from({ length: 7 }, (_, day) => ({
    day, enabled: day === overnightDay, open: day === overnightDay ? 1320 : null, close: day === overnightDay ? 120 : null
  })));
}

test('public hours honor explicit days in sparse or reordered legacy arrays', () => {
  const parser = hoursAt();
  const parsed = plain(parser.parseHoursText(JSON.stringify([
    { day: 5, enabled: true, open: 780, close: 1020 },
    { day: 1, enabled: true, open: 540, close: 720 }
  ])));
  assert.deepEqual(parsed.filter(item => item.enabled).map(item => item.day), [1, 5]);
  assert.deepEqual(parsed[1].periods, [{ open: 540, close: 720 }]);
  assert.deepEqual(parsed[5].periods, [{ open: 780, close: 1020 }]);
  assert.equal(parsed[0].enabled, false);
});

test('legacy named-day objects with string hours keep their day and schedule', () => {
  const parser = hoursAt();
  const parsed = plain(parser.parseHoursText(JSON.stringify({ Monday: '09:00 AM - 05:00 PM', Tuesday: 'Closed' })));
  assert.equal(parsed[1].enabled, true);
  assert.deepEqual(parsed[1].periods, [{ open: 540, close: 1020 }]);
  assert.equal(parsed[2].enabled, false);
});

test('Monday overnight hours remain open on Tuesday morning even when Tuesday is otherwise closed', () => {
  const parser = hoursAt(2, 1, 0);
  assert.equal(parser.todayHours({ business_hours: weekly(1) }).state, 'open');
  assert.equal(hoursAt(2, 2, 0).todayHours({ business_hours: weekly(1) }).state, 'closed');
});

test('Tuesday overnight hours start Tuesday evening and do not open early on Tuesday morning', () => {
  assert.equal(hoursAt(2, 1, 0).todayHours({ business_hours: weekly(2) }).state, 'closed');
  assert.equal(hoursAt(2, 21, 59).todayHours({ business_hours: weekly(2) }).state, 'closed');
  assert.equal(hoursAt(2, 22, 0).todayHours({ business_hours: weekly(2) }).state, 'open');
  assert.equal(hoursAt(3, 1, 59).todayHours({ business_hours: weekly(2) }).state, 'open');
  assert.equal(hoursAt(3, 2, 0).todayHours({ business_hours: weekly(2) }).state, 'closed');
});

test('v2 multiple periods preserve the lunch closure and each opening boundary', () => {
  const business_hours = JSON.stringify([{ day: 2, enabled: true, mode: 'regular', periods: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }] }]);
  const parsed = plain(hoursAt().parseHoursText(business_hours));
  assert.deepEqual(parsed[2].periods, [{ open: 540, close: 720 }, { open: 780, close: 1020 }]);
  for (const [hour, minute, state] of [[8, 59, 'closed'], [9, 0, 'open'], [12, 0, 'closed'], [12, 30, 'closed'], [13, 0, 'open'], [17, 0, 'closed']]) {
    assert.equal(hoursAt(2, hour, minute).todayHours({ business_hours }).state, state, `Tuesday ${hour}:${minute}`);
  }
});

test('24-hour v2 schedules remain open at midnight without manufacturing regular periods', () => {
  for (const mode of ['24h', '24/7']) {
    const business_hours = JSON.stringify([{ day: 2, enabled: true, mode, periods: [] }]);
    const parser = hoursAt(2, 0, 0);
    const parsed = plain(parser.parseHoursText(business_hours));
    assert.equal(parsed[2].mode, '24h');
    assert.deepEqual(parsed[2].periods, []);
    assert.equal(parser.todayHours({ business_hours }).state, 'open');
    assert.equal(parser.todayHours({ business_hours }).today, 'Open 24 hours');
  }
});

test('malformed and empty hour values fail safely without inventing an open period', () => {
  for (const value of ['', '[]', '{}', 'null', 'not a schedule', '[broken JSON', '[null,{},false]']) {
    const parsed = plain(hoursAt().parseHoursText(value));
    assert.equal(parsed.length, 7);
    assert.equal(parsed.some(item => item.enabled), false, value);
    assert.equal(parsed.some(item => item.periods.length), false, value);
  }
});

// This small DOM supports element/text creation, matching, cloning and focus.
// The content, compact limits and modal event logic execute from profile.html.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.className = ''; this._text = '';
    this.attributes = {}; this.listeners = {}; this.ownerDocument = null;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  get lastElementChild() { return this.children.at(-1) || null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
    child.parentNode = this; this.children.push(child); return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  set innerHTML(value) {
    this.children = []; this._text = '';
    if (!value) return;
    this.ownerDocument?.htmlWrites.push(String(value));
    // Only quickCard's fixed icon/title/placeholder template is parsed here.
    assert.match(value, /^<span class="quick-icon">/);
    const icon = this.ownerDocument.createElement('span'); icon.className = 'quick-icon';
    const label = this.ownerDocument.createElement('div'); label.className = 'quick-label';
    label.textContent = /class="quick-label">([^<]*)<\/div>/.exec(value)?.[1] || '';
    const empty = this.ownerDocument.createElement('div'); empty.className = 'quick-value';
    this.append(icon, label, empty);
  }
  get innerHTML() { return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      if (value === '[tabindex="0"]') return this.getAttribute('tabindex') === '0';
      if (value === 'a[href]') return this.tagName === 'A' && Boolean(this.href);
      return this.tagName === value.toUpperCase();
    });
  }
  closest(selector) { for (let item = this; item; item = item.parentNode) if (item.matches(selector)) return item; return null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  cloneNode(deep) {
    const clone = this.ownerDocument.createElement(this.tagName);
    Object.assign(clone, { className: this.className, _text: this._text, dataset: { ...this.dataset }, attributes: { ...this.attributes } });
    for (const key of ['href', 'target', 'rel', 'id']) if (this[key]) clone[key] = this[key];
    if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  fire(type, options = {}) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...options };
    for (const listener of this.listeners[type] || []) listener(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return [{}]; }
}

function contentRenderer() {
  const quickTrack = new Element();
  const quickDots = new Element();
  const quickInfo = new Element();
  const document = {
    htmlWrites: [], listeners: {}, activeElement: null,
    createElement(tag) { const element = new Element(tag); element.ownerDocument = document; return element; },
    getElementById(id) { return elements[id] || null; },
    addEventListener(type, listener) { (document.listeners[type] ||= []).push(listener); },
    fire(type, options) { const event = { prevented: false, preventDefault() { this.prevented = true; }, ...options }; for (const listener of document.listeners[type] || []) listener(event); return event; }
  };
  for (const element of [quickTrack, quickDots, quickInfo]) element.ownerDocument = document;
  document.body = document.createElement('body');
  const modal = document.createElement('div'); modal.classList.add('hidden');
  const modalContent = document.createElement('div');
  const close = document.createElement('button');
  modal.append(close, modalContent);
  const elements = { quickInfoModal: modal, quickInfoModalContent: modalContent, quickInfoModalClose: close };
  const context = {
    quickTrack, quickDots, quickInfo, document, quickIcon: () => '',
    quickPrev: document.createElement('button'), quickNext: document.createElement('button'), window: { addEventListener() {} }
  };
  const render = vm.runInNewContext(escapeSource + '\n' + hoursSource + cardSource + contentSource + modalSource + ';renderQuickInfo', context);
  return { render, quickTrack, quickInfo, document, modal, modalContent, close, cards() { return quickTrack.children.flatMap(page => page.children); } };
}

test('malformed visibility shapes do not crash an otherwise published specialized section', () => {
  for (const visibility of ['null', '[]', 'true', '"false"', '{broken JSON']) {
    const display = contentRenderer();
    assert.doesNotThrow(() => display.render({ quick_info_enabled: true, profile_modules: JSON.stringify({ games: 'Chess' }), profile_module_visibility: visibility }));
    assert.equal(display.cards().length, 1, visibility);
    assert.ok(display.quickTrack.textContent.includes('Chess'));
    assert.equal(display.quickInfo.classList.contains('hidden'), false);
  }
});

test('typed specialized rows preserve their actual content instead of rendering object coercion text', () => {
  const display = contentRenderer();
  display.render({
    quick_info_enabled: true, profile_modules: { games: [{ title: 'Chess club', description: 'Weekend tournament' }] }, profile_module_visibility: {}
  });
  assert.equal(display.cards().length, 1);
  assert.ok(display.quickTrack.textContent.includes('Chess club'));
  assert.ok(display.quickTrack.textContent.includes('Weekend tournament'));
  assert.equal(display.quickTrack.textContent.includes('[object Object]'), false);
  assert.equal(display.quickTrack.textContent.includes('"title"'), false);
});

test('malformed module shapes remain empty and explicit specialized visibility still hides drafts', () => {
  for (const modules of ['null', '[]', 'true', '{broken JSON']) {
    const display = contentRenderer();
    assert.doesNotThrow(() => display.render({ quick_info_enabled: true, profile_modules: modules, profile_module_visibility: '{}' }));
    assert.equal(display.cards().length, 0);
    assert.equal(display.quickInfo.classList.contains('hidden'), true);
  }
  const hidden = contentRenderer();
  hidden.render({ quick_info_enabled: true, profile_modules: JSON.stringify({ games: 'Private games draft' }), profile_module_visibility: '{"games":false}' });
  assert.equal(hidden.cards().length, 0);
  assert.equal(hidden.quickTrack.textContent.includes('Private games draft'), false);
});

test('structured education displays school, degree and year metadata without raw JSON', () => {
  const display = contentRenderer();
  display.render({ quick_info_enabled: true, show_education: true, education: JSON.stringify([{ school: 'Synthetic University', degree: 'BS Architecture', year: '2024' }]) });
  const card = display.cards()[0];
  assert.equal(card.querySelectorAll('.quick-item').length, 1);
  assert.ok(card.textContent.includes('Synthetic University'));
  assert.ok(card.textContent.includes('BS Architecture'));
  assert.ok(card.textContent.includes('2024'));
  assert.equal(card.textContent.includes('"degree"'), false);
});

test('specialized structured rows keep names, detail text and safe destination links', () => {
  const display = contentRenderer();
  display.render({ quick_info_enabled: true, profile_modules: { collaborations: { name: 'Synthetic partner', description: 'Design collaboration', link: 'https://example.test/partner' } } });
  const card = display.cards()[0];
  const links = card.querySelectorAll('a');
  assert.ok(card.textContent.includes('Synthetic partner'));
  assert.ok(card.textContent.includes('Design collaboration'));
  assert.equal(card.textContent.includes('[object Object]'), false);
  assert.equal(card.textContent.includes('"description"'), false);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.test/partner');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener');
});

test('compact generic cards show four rows while keyboard-opened details retain all seven and restore focus', () => {
  const display = contentRenderer();
  const entries = Array.from({ length: 7 }, (_, i) => ({ school: `School ${i + 1}`, degree: `Degree ${i + 1}`, link: `https://example.test/school/${i + 1}` }));
  display.render({ quick_info_enabled: true, show_education: true, education: JSON.stringify(entries) });
  const card = display.cards()[0];
  assert.equal(card.querySelectorAll('.quick-item').length, 4);
  assert.equal(card.textContent.includes('School 7'), false);
  card.focus();
  assert.equal(card.fire('keydown', { key: 'Enter' }).prevented, true);
  assert.equal(display.modal.classList.contains('hidden'), false);
  assert.equal(display.modalContent.querySelectorAll('.quick-item').length, 7);
  assert.ok(display.modalContent.textContent.includes('School 7'));
  assert.equal(display.document.activeElement, display.close);
  const last = display.modalContent.querySelectorAll('a').at(-1);
  last.focus();
  assert.equal(display.document.fire('keydown', { key: 'Tab', shiftKey: false }).prevented, true);
  assert.equal(display.document.activeElement, display.close);
  assert.equal(display.document.fire('keydown', { key: 'Tab', shiftKey: true }).prevented, true);
  assert.equal(display.document.activeElement, last);
  display.document.fire('keydown', { key: 'Escape' });
  assert.equal(display.modal.classList.contains('hidden'), true);
  assert.equal(display.document.activeElement, card);
  assert.equal(card.getAttribute('aria-expanded'), 'false');
});

test('malicious structured HTML stays text and unsafe URLs never produce action links', () => {
  const display = contentRenderer();
  const malicious = '<img src=x onerror=alert(1)>';
  display.render({ quick_info_enabled: true, show_education: true, education: JSON.stringify([
    { name: malicious, degree: '<script>alert(2)</script>', link: 'javascript:alert(3)' },
    { name: 'Unsafe data link', link: 'data:text/html,<script>alert(4)</script>' },
    { name: 'Unsafe relative link', link: '//example.test/path' }
  ]) });
  const card = display.cards()[0];
  assert.ok(card.textContent.includes(malicious));
  assert.ok(card.textContent.includes('<script>alert(2)</script>'));
  assert.equal(card.querySelectorAll('a').length, 0);
  assert.equal(card.querySelectorAll('img,script').length, 0);
  assert.equal(display.document.htmlWrites.some(value => value.includes(malicious) || value.includes('alert(2)')), false);
});
