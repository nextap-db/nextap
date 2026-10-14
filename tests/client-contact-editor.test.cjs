const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/client-dashboard.html'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(root, 'public/client-workspace.js'), 'utf8');
const limits = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'public/content-limits.js'), 'utf8')).toString('base64'));
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
const mainScript = scripts.find(source => source.includes('const mainBaselines='));
const viewScript = scripts.find(source => source.includes('NEX TAP DASHBOARD VIEW CONTROLLER'));
const contentScript = scripts.find(source => source.includes('NEX TAP CONTENT MANAGER CONTROLLER'));
assert.ok(mainScript && viewScript && contentScript, 'Execute the actual dashboard loaders, navigation and editor controller');

const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const plain = value => JSON.parse(JSON.stringify(value));

// This DOM only parses the inputs/buttons needed by the actual Contact editor.
// Saving, draft capture, revision adoption and navigation come from app code.
class Element {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.dataset = {}; this.attributes = {};
    this.style = {}; this.childNodes = []; this.listeners = {}; this.value = ''; this.type = 'text';
    this.checked = false; this.disabled = false; this.hidden = false; this.readOnly = false; this.textContent = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...(this.className || '').split(/\s+/), ...names])].filter(Boolean).join(' '); },
      remove: (...names) => { this.className = (this.className || '').split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      contains: name => (this.className || '').split(/\s+/).includes(name),
      toggle: (name, value) => value ? this.classList.add(name) : this.classList.remove(name)
    };
  }
  get children() { return this.childNodes; }
  appendChild(child) {
    if (child.parentElement) child.parentElement.childNodes = child.parentElement.childNodes.filter(node => node !== child);
    child.parentElement = this; this.childNodes.push(child); return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  prepend(child) { this.appendChild(child); this.childNodes = [child, ...this.childNodes.filter(node => node !== child)]; }
  replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentElement = null; }); this.childNodes = []; this.append(...nodes); }
  set innerHTML(value) {
    this._html = String(value); this.replaceChildren();
    // Dynamic IDs are registered from the rendered controls, not fabricated
    // from the helper's implementation or from its expected result.
    for (const match of this._html.matchAll(/<(input|textarea|button)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\s*\/?>)/gi)) {
      const node = new Element(this.ownerDocument, match[1]);
      for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], decode(attribute[2]));
      node.textContent = decode((match[3] || '').replace(/<[^>]*>/g, ''));
      if (node.tagName === 'TEXTAREA') node.value = decode(match[3]);
      this.appendChild(node);
      if (node.id) this.ownerDocument.ids.set(node.id, node);
    }
    if (this._html.includes('class="nx-editor-actions"')) {
      const actions = new Element(this.ownerDocument); actions.className = 'nx-editor-actions'; this.appendChild(actions);
    }
  }
  get innerHTML() { return this._html || ''; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = String(value);
    else if (name === 'class') this.className = String(value);
    else if (['id', 'type', 'value'].includes(name)) this[name] = String(value);
  }
  getAttribute(name) { return this.attributes[name] || null; }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    return selector.split(',').some(part => {
      let value = part.trim();
      if (!value) return false;
      if (value.includes(':not([disabled])')) { if (this.disabled) return false; value = value.replace(':not([disabled])', ''); }
      const tag = /^[a-z]+/i.exec(value)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const id = /#([\w-]+)/.exec(value)?.[1];
      if (id && id !== this.id) return false;
      for (const [, name] of value.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, expected] of value.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!(name in this.attributes)) return false;
        if (expected !== undefined && this.attributes[name] !== expected) return false;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.childNodes.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type) { for (const listener of this.listeners[type] || []) await listener({ target: this, preventDefault() {}, stopPropagation() {} }); }
  click() { if (!this.disabled) return this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  reportValidity() {}
  checkValidity() {
    if (this.required && !this.value.trim()) return false;
    if (this.type === 'url' && this.value) { try { return ['http:', 'https:'].includes(new URL(this.value).protocol); } catch { return false; } }
    return this.type !== 'email' || !this.value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value);
  }
  insertAdjacentElement(_position, node) { this.parentElement?.appendChild(node); }
}

async function contactPage(options = {}) {
  const rules = await limits;
  let stored = {
    id: 'fictional-owner', slug: 'fictional-owner', name: 'Saved Owner', email: 'owner@example.test',
    phone: '09171234567', facebook: 'saved.owner', instagram: '@saved.owner', website: 'https://example.test/saved',
    card_type: 'basic', services: 'Design', education: 'College', skills: 'Drawing', content_revision: 4,
    profile_modules: '{}', ...options.record
  };
  const requests = [], windowListeners = {}, timers = [];
  const document = {
    ids: new Map(), listeners: {},
    createElement: tag => new Element(document, tag),
    getElementById(id) {
      if (!document.ids.has(id)) { const node = new Element(document); node.id = id; node.setAttribute('id', id); if (id === 'email') node.type = 'email'; if (id === 'featured_image') node.readOnly = true; document.ids.set(id, node); }
      return document.ids.get(id);
    },
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    querySelector: selector => document.body.querySelector(selector),
    addEventListener(type, callback) { (document.listeners[type] ||= []).push(callback); },
    fire(type, target) { for (const callback of document.listeners[type] || []) callback({ target }); }
  };
  document.body = new Element(document, 'body'); document.body.dataset.nxView = 'contact-social';
  const form = document.getElementById('profileForm'); form.tagName = 'FORM'; document.body.appendChild(form);
  const editor = document.getElementById('nxContactEditor'); form.appendChild(editor);
  form.appendChild(document.getElementById('nxContentEditor'));
  const location = { origin: 'https://example.test', replace() { assert.fail('Fictional owner must remain authenticated'); } };
  let hash = '#contact-social';
  Object.defineProperty(location, 'hash', { get: () => hash, set: value => { hash = String(value).startsWith('#') ? String(value) : '#' + value; for (const callback of windowListeners.hashchange || []) callback(); } });
  const window = {
    location, NextapContentLimits: rules, scrollTo() {},
    addEventListener(type, callback) { (windowListeners[type] ||= []).push(callback); },
    dispatchEvent(event) { for (const callback of windowListeners[event.type] || []) callback(event); }
  };
  const context = vm.createContext({
    window, document, location, navigator: {}, URL, queueMicrotask,
    setTimeout(callback) { timers.push(callback); }, clearTimeout() {},
    history: { replaceState(_state, _title, next) { hash = String(next); } },
    MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    fetch: async (url, init) => {
      if (url === '/api/client-auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: true, client: stored }) };
      assert.equal(url, '/api/client/profile');
      const body = JSON.parse(init.body); requests.push({ url, init, body });
      const custom = await options.respond?.(url, body, stored);
      if (custom) return custom;
      if (body.expected_revision !== stored.content_revision) return { ok: false, status: 409, json: async () => ({ code: 'PROFILE_CHANGED', error: 'Reload the latest profile.' }) };
      const { expected_revision, ...patch } = body;
      stored = { ...stored, ...patch, content_revision: stored.content_revision + 1 };
      return { ok: true, status: 200, json: async () => stored };
    }
  });
  await vm.runInContext(mainScript, context);
  // Execute the same module's browser initialization, with its actual limits
  // module already loaded, rather than replacing its draft logic with a stub.
  const browserWorkspace = workspaceSource.replace(/^import \* as limits from [^\n]+\r?\n/, 'const limits=window.NextapContentLimits;\n').replace(/\bexport /g, '');
  vm.runInContext('(function(){' + browserWorkspace + '})()', context);
  vm.runInContext(viewScript, context);
  vm.runInContext(contentScript, context);
  const flush = () => { while (timers.length) timers.shift()(); };
  flush();
  const field = key => editor.querySelector('[data-key="' + key + '"]');
  const type = (key, value) => { const input = field(key); assert.ok(input, 'Actual visible contact field: ' + key); input.value = value; document.fire('input', input); return input; };
  const submit = entry => entry === 'main' ? document.getElementById('profileForm').fire('submit') : editor.querySelector('.nx-editor-save').click();
  return {
    context, document, window, editor, requests, field, type, submit, flush,
    get stored() { return plain(stored); },
    get mainSave() { return document.getElementById('save'); },
    get sectionSave() { return editor.querySelector('.nx-editor-save'); },
    get inlineError() { return editor.querySelector('#nxContactSaveError'); },
    navigate(view) { location.hash = view; flush(); }
  };
}

test('standalone Contact editor captures the visible fields as a draft and warns before leaving', async () => {
  const page = await contactPage();
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), false);
  page.type('facebook', 'new.owner');
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), true);
  assert.equal(page.document.getElementById('facebook').value, 'saved.owner', 'The hidden legacy field is not the visible editor');
  const event = { type: 'beforeunload', prevented: false, preventDefault() { this.prevented = true; } };
  page.window.dispatchEvent(event);
  assert.equal(event.prevented, true);
  assert.equal(page.field('facebook').value, 'new.owner');
});

for (const entry of ['section', 'main']) {
  test('Contact ' + entry + ' Save sends visible social edits, adopts the saved revision and stays usable', async () => {
    const page = await contactPage();
    page.type('facebook', 'https://www.facebook.com/fictional.owner?sk=about');
    page.type('instagram', '@fictional.owner');
    page.type('messenger', 'fictional.owner');
    page.type('website', 'https://example.test/new-profile?source=card#contact');
    page.document.getElementById('name').value = 'Unrelated profile draft';
    await page.submit(entry);
    assert.equal(page.requests.length, 1);
    const body = page.requests[0].body;
    assert.equal(body.facebook, 'https://www.facebook.com/fictional.owner?sk=about');
    assert.equal(body.instagram, '@fictional.owner'); assert.equal(body.messenger, 'fictional.owner');
    assert.equal(body.website, 'https://example.test/new-profile?source=card#contact');
    assert.equal(body.expected_revision, 4);
    assert.equal(body.name, undefined); assert.equal(body.services, undefined);
    assert.equal(page.requests[0].init.credentials, 'same-origin');
    assert.equal(page.window.__nxClient.content_revision, 5);
    assert.equal(page.stored.facebook, body.facebook);
    assert.equal(page.document.getElementById('facebook').value, body.facebook);
    assert.equal(page.field('facebook').value, body.facebook);
    assert.equal(page.document.getElementById('name').value, 'Unrelated profile draft');
    assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), false);
    assert.equal(page.editor.hidden, false);
    assert.equal(page.document.body.dataset.nxView, 'contact-social');
    assert.equal(page.sectionSave.disabled, false); assert.equal(page.mainSave.disabled, false);
    assert.equal(page.window.NextapContentLimits.contentUsage(page.window.__nxClient).used, 3, 'Free contact edits do not consume another plan slot');
    await page.submit(entry);
    assert.equal(page.requests.length, 1, 'An unchanged contact editor does not resubmit the hidden legacy form');
  });

  test('Contact ' + entry + ' Save retains the draft and enables retry on network and revision errors', async () => {
    for (const failure of ['network', 'conflict']) {
      const page = await contactPage({ respond() {
        if (failure === 'network') throw new Error('Network unavailable');
        return { ok: false, status: 409, json: async () => ({ code: 'PROFILE_CHANGED', error: 'Reload the latest profile.' }) };
      } });
      page.type('facebook', 'unsaved.owner');
      await page.submit(entry);
      assert.equal(page.requests.length, 1, failure);
      assert.equal(page.field('facebook').value, 'unsaved.owner', failure);
      assert.equal(page.window.__nxClient.content_revision, 4, failure);
      assert.equal(page.stored.facebook, 'saved.owner', failure);
      assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), true, failure);
      assert.equal(page.editor.hidden, false, failure);
      assert.equal(page.sectionSave.disabled, false, failure); assert.equal(page.mainSave.disabled, false, failure);
      assert.equal(page.inlineError?.getAttribute('role'), 'alert', failure);
      assert.equal(page.inlineError?.hidden, false, failure);
      assert.match(page.inlineError.textContent, failure === 'network' ? /Network unavailable/ : /Reload/);
    }
  });
}

test('typing during a Contact save remains a new draft and the next save uses the returned revision', async () => {
  let release, announce;
  const arrived = new Promise(resolve => { announce = resolve; });
  let paused = true;
  const page = await contactPage({ respond: async () => {
    if (paused) { paused = false; announce(); await new Promise(resolve => { release = resolve; }); }
  } });
  page.type('facebook', 'submitted.owner');
  const pending = page.submit('main');
  await arrived;
  const sameInput = page.type('facebook', 'later.owner');
  page.type('telegram', '@later_owner');
  release(); await pending;
  assert.equal(page.stored.facebook, 'submitted.owner');
  assert.equal(page.window.__nxClient.content_revision, 5);
  assert.equal(page.field('facebook'), sameInput, 'Saving must retain the live input node and its later value');
  assert.equal(page.field('facebook').value, 'later.owner');
  assert.equal(page.field('telegram').value, '@later_owner');
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), true);
  assert.equal(page.editor.hidden, false);
  await page.submit('section');
  assert.equal(page.requests[1].body.expected_revision, 5);
  assert.equal(page.stored.facebook, 'later.owner'); assert.equal(page.stored.telegram, '@later_owner');
  assert.equal(page.window.__nxClient.content_revision, 6);
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), false);
});

test('closing Contact returns to Overview and reopening retains the same unsaved field nodes', async () => {
  const page = await contactPage();
  const input = page.type('facebook', 'kept.owner');
  await page.editor.querySelector('.nx-editor-close').click();
  page.flush();
  assert.equal(page.document.body.dataset.nxView, 'overview');
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), true);
  page.navigate('contact-social');
  assert.equal(page.document.body.dataset.nxView, 'contact-social');
  assert.equal(page.editor.hidden, false);
  assert.equal(page.field('facebook'), input);
  assert.equal(page.field('facebook').value, 'kept.owner');
  assert.equal(page.requests.length, 0);
});

test('Discard Contact restores the saved editor without blanking the page or losing an unrelated profile draft', async () => {
  const page = await contactPage();
  page.document.getElementById('name').value = 'Unrelated profile draft';
  page.type('facebook', 'discarded.owner');
  const discard = page.editor.querySelectorAll('button').find(button => button.textContent === 'Discard draft');
  assert.ok(discard, 'Use the actual workspace discard button');
  await discard.click();
  assert.equal(page.document.body.dataset.nxView, 'contact-social');
  assert.equal(page.editor.hidden, false);
  assert.equal(page.field('facebook')?.value, 'saved.owner');
  assert.equal(page.window.NextapClientWorkspace.hasDraft('contact'), false);
  assert.equal(page.document.getElementById('name').value, 'Unrelated profile draft');
  assert.equal(page.requests.length, 0);
});
