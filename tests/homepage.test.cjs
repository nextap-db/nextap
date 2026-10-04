const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/homepage.js');
const approvedCatalog = JSON.parse(read('public/card-designs/catalog.json'));
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const visibleIds = harness => [...harness.elements.homeDesignGrid.innerHTML.matchAll(/data-home-design="([^"]+)"/g)].map(match => match[1]);

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.value = '';
    this.textContent = '';
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; }
    };
  }
  set innerHTML(value) { this._html = value; for (const child of this.children) { child.isConnected = false; child.parentNode = null; } this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  contains(target) { for (let node = target; node; node = node.parentNode) if (node === this) return true; return false; }
  closest(selector) {
    if ((selector === '[data-home-design]' && this.dataset.homeDesign !== undefined) || (selector === 'a' && this.tagName === 'A')) return this;
    return this.parentNode?.closest(selector) || null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  emit(type, values = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    event.results = (this.listeners[type] || []).map(handler => handler(event));
    return event;
  }
  focus() { this.focusCount = (this.focusCount || 0) + 1; this.onFocus?.(); }
}

function homepage(options = {}) {
  const ids = ['homeMenuToggle', 'homeNavigation', 'homeDesignGrid', 'homeDesignStatus', 'homeDesignSearch', 'homeDesignMore', 'homeDesignRetry',
    'homeDesignDialog', 'homePreviewTitle', 'homePreviewImage', 'homePreviewFront', 'homePreviewBack', 'homePreviewOrder', 'homePreviewClose', 'homePreviewDescription'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const categories = Object.fromEntries(['nextap', 'animated', 'customized', 'all'].map(category => {
    const button = new Element('button'); button.dataset.homeCategory = category; return [category, button];
  }));
  const document = new Element('document');
  document.documentElement = new Element('html');
  document.activeElement = null;
  document.getElementById = id => elements[id] || null;
  document.querySelectorAll = selector => selector === '[data-home-category]' ? Object.values(categories) : [];
  for (const element of [...Object.values(elements), ...Object.values(categories)]) element.onFocus = () => { document.activeElement = element; };
  const fallback = '<a class="home-design-card" data-home-design="N1" href="/order?design=N1">Choose design N1</a>';
  elements.homeDesignGrid.innerHTML = fallback;
  const dialog = elements.homeDesignDialog;
  dialog.open = false;
  if (options.nativeDialog !== false) dialog.showModal = () => {
    if (options.dialogError) throw new Error('Dialog unavailable');
    dialog.open = true;
  };
  dialog.close = () => { dialog.open = false; dialog.emit('close'); };
  dialog.escape = () => { const event = dialog.emit('cancel'); if (!event.defaultPrevented) dialog.close(); return event; };
  const requests = [];
  const context = vm.createContext({
    document, AbortSignal, encodeURIComponent,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(url, '/card-designs/catalog.json', 'Homepage must not make order, analytics or external requests');
      assert.ok(options.method === undefined || options.method === 'GET');
      return optionsFromHarness.catalogFetch ? optionsFromHarness.catalogFetch(url, options) : { ok: true, json: async () => copy(optionsFromHarness.catalog || approvedCatalog) };
    }
  });
  const optionsFromHarness = options;
  Object.defineProperty(context, 'localStorage', { get() { assert.fail('Homepage must not read or modify the order cart'); } });
  vm.runInContext(source, context, { filename: 'homepage.js' });
  return {
    elements, categories, document, requests, fallback,
    card(id) {
      assert.ok(visibleIds(this).includes(id), `Design ${id} must be visible before previewing`);
      const card = new Element('button'); card.dataset.homeDesign = id; card.onFocus = () => { document.activeElement = card; };
      elements.homeDesignGrid.appendChild(card); return card;
    }
  };
}

test('homepage markup provides progressive gallery, navigation, native dialog and accurate current pricing', () => {
  const html = read('public/index.html');
  for (const id of ['homeMenuToggle', 'homeNavigation', 'homeDesignSearch', 'homeDesignStatus', 'homeDesignGrid', 'homeDesignMore', 'homeDesignRetry',
    'homeDesignDialog', 'homePreviewTitle', 'homePreviewImage', 'homePreviewFront', 'homePreviewBack', 'homePreviewOrder', 'homePreviewClose', 'homePreviewDescription']) {
    assert.equal([...html.matchAll(new RegExp(`\\bid=["']${id}["']`, 'g'))].length, 1, `Unique required element ${id}`);
  }
  assert.match(html, /<button\b[^>]*\bid=["']homeMenuToggle["'][^>]*\baria-controls=["']homeNavigation["']/);
  assert.match(html, /<dialog\b[^>]*\bid=["']homeDesignDialog["']/);
  assert.match(html, /\baria-labelledby=["']homePreviewTitle["']/);
  assert.match(html, /\baria-describedby=["']homePreviewDescription["']/);
  assert.match(html, /<script\b[^>]*\bsrc=["']\/?homepage\.js["'][^>]*\bdefer\b/);
  const categoryButtons = [...html.matchAll(/<button\b[^>]*\bdata-home-category=["']([^"']+)["'][^>]*>/g)];
  assert.deepEqual(categoryButtons.map(match => match[1]), ['nextap', 'animated', 'customized', 'all']);
  for (const button of categoryButtons) assert.match(button[0], /\baria-pressed=["'](?:true|false)["']/);
  const fallbackIds = [...html.matchAll(/data-home-design=["']([^"']+)["']/g)].map(match => match[1]);
  const fallbackLinks = [...html.matchAll(/href=["']\/order\?design=([^"'&]+)["']/g)].map(match => match[1]);
  assert.ok(fallbackIds.length > 0, 'Initial gallery must contain approved static designs');
  for (const id of fallbackIds) {
    assert.ok(approvedCatalog.some(design => design.id === id && design.category === 'nextap'));
    assert.ok(fallbackLinks.includes(id), `Static design ${id} needs a working checkout link without JavaScript`);
  }
  for (const button of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (/data-home-design/.test(button[1])) {
      assert.match(button[1], /\bdisabled\b/, 'A static preview button must be disabled until the catalog can load');
      assert.doesNotMatch(button[2], /<a\b/, 'Static order links must be outside the preview button');
    }
  }
  assert.match(html, /<details\b[\s\S]*?<summary\b/);
  const text = html.replace(/<[^>]*>/g, ' ');
  for (const price of [199, 299, 499, 49, 70, 99]) assert.match(text, new RegExp(`₱\\s*${price}\\b`), `Current price ${price}`);
  assert.doesNotMatch(text, /₱\s*69\b/);
  assert.match(read('public/homepage.css'), /prefers-reduced-motion\s*:\s*reduce/);
});

test('catalog defaults to all twelve Nextap designs in natural N then PN order', async () => {
  const harness = homepage({ catalog: copy(approvedCatalog).reverse() });
  await settle();
  assert.deepEqual(visibleIds(harness), ['N1', 'N2', 'N3', 'N4', 'N5', 'PN1', 'PN2', 'PN3', 'PN4', 'PN5', 'PN6', 'PN7']);
  assert.equal(harness.categories.nextap.getAttribute('aria-pressed'), 'true');
  assert.equal(harness.elements.homeDesignMore.hidden, true);
  assert.equal(harness.elements.homeDesignRetry.hidden, true);
  assert.match(harness.elements.homeDesignStatus.textContent, /Showing 12 of 12/);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.credentials, 'same-origin');
});

test('category and code search filter before twelve-item pagination without losing other designs', async () => {
  const harness = homepage(); await settle();
  harness.categories.animated.emit('click');
  assert.equal(visibleIds(harness).length, 12);
  assert.equal(harness.elements.homeDesignMore.hidden, false);
  harness.elements.homeDesignMore.emit('click');
  assert.equal(visibleIds(harness).length, 20);
  assert.equal(harness.elements.homeDesignMore.hidden, true);
  harness.elements.homeDesignSearch.value = 'q3'; harness.elements.homeDesignSearch.emit('input');
  assert.deepEqual(visibleIds(harness), ['Q3']);
  harness.categories.customized.emit('click');
  assert.deepEqual(visibleIds(harness), []);
  assert.match(harness.elements.homeDesignStatus.textContent, /No designs match/);
  harness.elements.homeDesignSearch.value = ''; harness.elements.homeDesignSearch.emit('input');
  assert.deepEqual(visibleIds(harness), ['C1', 'C2', 'C3', 'C4']);
  harness.categories.all.emit('click');
  assert.equal(visibleIds(harness).length, 12);
  harness.elements.homeDesignMore.emit('click'); assert.equal(visibleIds(harness).length, 24);
  harness.elements.homeDesignMore.emit('click'); assert.equal(visibleIds(harness).length, 36);
  assert.equal(harness.elements.homeDesignMore.hidden, true);
  assert.deepEqual(new Set(visibleIds(harness)), new Set(approvedCatalog.map(design => design.id)));
});

test('native preview shows the matching pair, hands only a validated design to checkout and returns focus on close or Escape', async () => {
  const harness = homepage(); await settle();
  const design = approvedCatalog.find(item => item.id === 'N2');
  const card = harness.card('N2');
  const opened = harness.elements.homeDesignGrid.emit('click', { target: card });
  assert.equal(opened.defaultPrevented, true);
  assert.equal(harness.elements.homeDesignDialog.open, true);
  assert.equal(harness.elements.homePreviewImage.src, design.front);
  assert.equal(harness.elements.homePreviewImage.alt, 'Design N2 front');
  assert.equal(harness.elements.homePreviewOrder.getAttribute('href'), '/order?design=N2');
  assert.equal(harness.document.activeElement, harness.elements.homePreviewClose);
  harness.elements.homePreviewBack.emit('click');
  assert.equal(harness.elements.homePreviewImage.src, design.back);
  assert.equal(harness.elements.homePreviewBack.getAttribute('aria-pressed'), 'true');
  assert.equal(harness.elements.homePreviewFront.getAttribute('aria-pressed'), 'false');
  harness.elements.homePreviewFront.emit('click'); assert.equal(harness.elements.homePreviewImage.src, design.front);
  harness.elements.homePreviewClose.emit('click');
  assert.equal(harness.elements.homeDesignDialog.open, false);
  assert.equal(harness.document.activeElement, card);
  harness.elements.homeDesignGrid.emit('click', { target: card });
  const cancelled = harness.elements.homeDesignDialog.escape();
  assert.equal(cancelled.defaultPrevented, false, 'Native Escape must remain responsible for cancelling the dialog');
  assert.equal(harness.document.activeElement, card);
  assert.equal(harness.requests.length, 1, 'Preview/order handoff must not place orders or record analytics');
});

test('preview handles missing images, backdrop close and disconnected opener without losing the checkout link', async () => {
  const harness = homepage(); await settle();
  const card = harness.card('N1'); harness.elements.homeDesignGrid.emit('click', { target: card });
  harness.elements.homePreviewImage.emit('error');
  assert.equal(harness.elements.homePreviewImage.hidden, true);
  assert.match(harness.elements.homePreviewDescription.textContent, /could not load/);
  assert.equal(harness.elements.homePreviewOrder.getAttribute('href'), '/order?design=N1');
  harness.elements.homePreviewBack.emit('click'); assert.equal(harness.elements.homePreviewImage.hidden, false);
  card.isConnected = false;
  harness.elements.homeDesignDialog.emit('click');
  assert.equal(harness.elements.homeDesignDialog.open, false);
  assert.equal(harness.document.activeElement, harness.elements.homeDesignSearch);
});

test('unavailable native dialogs leave validated checkout links and do not intercept navigation', async () => {
  for (const options of [{ nativeDialog: false }, { dialogError: true }]) {
    const harness = homepage(options); await settle();
    if (options.dialogError) {
      const card = harness.card('N1'); harness.elements.homeDesignGrid.emit('click', { target: card });
      assert.match(harness.elements.homeDesignStatus.textContent, /could not open/);
    }
    assert.match(harness.elements.homeDesignGrid.innerHTML, /<a\b[^>]*href="\/order\?design=N1"/);
    const card = harness.card('N1');
    const event = harness.elements.homeDesignGrid.emit('click', { target: card });
    assert.equal(event.defaultPrevented, false);
    assert.equal(harness.elements.homeDesignDialog.open, false);
  }
});

test('catalog rejection preserves static checkout links and does not expose unsafe paths or response errors', async () => {
  const valid = copy(approvedCatalog[0]);
  const cases = [
    {}, [], [valid, valid], [{ ...valid, category: undefined }], [{ ...valid, category: 'animated' }],
    [{ ...valid, category: 'unknown' }], [{ ...valid, id: 'N1" onclick="unsafe' }], [{ ...valid, version: '../unsafe' }],
    [{ ...valid, front: 'https://untrusted.example.test/front.webp' }], [{ ...valid, back: '//untrusted.example.test/back.webp' }],
    [{ ...valid, thumbnail: '/card-designs/../unsafe.webp' }], [{ ...valid, back: valid.front }],
    [{ ...valid, front: valid.front + '?unsafe=1' }], [{ ...valid, label: {} }]
  ];
  for (const catalog of cases) {
    const harness = homepage({ catalog }); await settle();
    assert.equal(harness.elements.homeDesignGrid.innerHTML, harness.fallback);
    assert.equal(harness.elements.homeDesignRetry.hidden, false);
    assert.equal(harness.elements.homeDesignMore.hidden, true);
    assert.equal(harness.categories.nextap.disabled, true);
    assert.match(harness.elements.homeDesignStatus.textContent, /could not load/);
    assert.doesNotMatch(harness.elements.homeDesignStatus.textContent, /unsafe|untrusted/);
  }
});

test('network, HTTP and JSON failures keep fallback links usable and retry recovers the complete gallery', async () => {
  for (const failure of [
    () => { throw new Error('Internal response detail'); },
    () => ({ ok: false, json() { assert.fail('An HTTP error body must not be read'); } }),
    () => ({ ok: true, json() { throw new Error('Internal parse detail'); } })
  ]) {
    let calls = 0;
    const harness = homepage({ catalogFetch: () => ++calls === 1 ? failure() : { ok: true, json: async () => copy(approvedCatalog) } });
    await settle();
    assert.equal(harness.elements.homeDesignGrid.innerHTML, harness.fallback);
    assert.match(harness.elements.homeDesignStatus.textContent, /links below/);
    assert.doesNotMatch(harness.elements.homeDesignStatus.textContent, /Internal/);
    assert.equal(harness.elements.homeDesignRetry.disabled, false);
    const retry = harness.elements.homeDesignRetry.emit('click'); await Promise.all(retry.results);
    assert.equal(visibleIds(harness).length, 12);
    assert.equal(harness.elements.homeDesignRetry.hidden, true);
    assert.equal(harness.categories.nextap.disabled, false);
  }
});

test('labels are escaped in cards and assigned as plain preview text', async () => {
  const label = '<script>unsafe()</script>" & test';
  const harness = homepage({ catalog: [{ ...approvedCatalog[0], label }] }); await settle();
  assert.doesNotMatch(harness.elements.homeDesignGrid.innerHTML, /<script>/);
  assert.match(harness.elements.homeDesignGrid.innerHTML, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;&quot; &amp; test/);
  const card = harness.card('N1'); harness.elements.homeDesignGrid.emit('click', { target: card });
  assert.equal(harness.elements.homePreviewTitle.textContent, 'Design ' + label);
  assert.equal(harness.elements.homePreviewTitle.innerHTML, '');
  assert.equal(harness.elements.homePreviewOrder.getAttribute('href'), '/order?design=N1');
});

test('static links remain available while loading and an earlier failed request cannot replace a successful retry', async () => {
  let finishEarlier;
  let calls = 0;
  const harness = homepage({ catalogFetch: () => ++calls === 1 ? new Promise(resolve => { finishEarlier = resolve; }) :
    { ok: true, json: async () => copy(approvedCatalog) } });
  assert.equal(harness.elements.homeDesignGrid.innerHTML, harness.fallback);
  assert.match(harness.elements.homeDesignStatus.textContent, /links below/);
  const staticLink = harness.elements.homeDesignGrid.appendChild(new Element('a'));
  staticLink.dataset.homeDesign = 'N1';
  staticLink.setAttribute('href', '/order?design=N1');
  const fallbackClick = harness.elements.homeDesignGrid.emit('click', { target: staticLink });
  assert.equal(fallbackClick.defaultPrevented, false, 'A pending catalog must preserve native fallback checkout navigation');
  assert.equal(harness.elements.homeDesignDialog.open, false);
  const retry = harness.elements.homeDesignRetry.emit('click'); await Promise.all(retry.results);
  assert.equal(visibleIds(harness).length, 12);
  finishEarlier({ ok: false, json() { assert.fail('Stale HTTP error bodies must not be read'); } });
  await settle();
  assert.equal(visibleIds(harness).length, 12);
  assert.equal(harness.elements.homeDesignRetry.hidden, true);
  assert.match(harness.elements.homeDesignStatus.textContent, /Showing 12 of 12/);
});

test('unknown or tampered card IDs cannot create a preview or checkout handoff', async () => {
  const harness = homepage(); await settle();
  for (const id of ['A6', 'N1&cart=unsafe', 'javascript:unsafe']) {
    const card = new Element('button'); card.dataset.homeDesign = id; harness.elements.homeDesignGrid.appendChild(card);
    harness.elements.homeDesignGrid.emit('click', { target: card });
    assert.equal(harness.elements.homeDesignDialog.open, false);
    assert.equal(harness.elements.homePreviewOrder.getAttribute('href'), null);
  }
});

test('menu uses native button state, closes on Escape/outside/link clicks and preserves native anchor and FAQ behavior', async () => {
  const harness = homepage({ catalogFetch: () => { throw new Error('Offline'); } }); await settle();
  const menu = harness.elements.homeMenuToggle, navigation = harness.elements.homeNavigation;
  assert.equal(harness.document.documentElement.classList.contains('home-js'), true);
  assert.equal(menu.hidden, false);
  assert.equal(menu.getAttribute('aria-controls'), 'homeNavigation');
  menu.emit('click'); assert.equal(menu.getAttribute('aria-expanded'), 'true'); assert.equal(navigation.classList.contains('is-open'), true);
  const escape = harness.document.emit('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true); assert.equal(menu.getAttribute('aria-expanded'), 'false'); assert.equal(harness.document.activeElement, menu);
  assert.equal(harness.document.emit('keydown', { key: 'Escape' }).defaultPrevented, false, 'Escape outside an open menu belongs to native controls');
  menu.emit('click'); const link = navigation.appendChild(new Element('a'));
  const anchor = navigation.emit('click', { target: link });
  assert.equal(anchor.defaultPrevented, false, 'Hash navigation must keep native scrolling and reduced-motion behavior');
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  menu.emit('click'); const summary = new Element('summary');
  const faq = harness.document.emit('click', { target: summary });
  assert.equal(faq.defaultPrevented, false); assert.equal(menu.getAttribute('aria-expanded'), 'false');
});
