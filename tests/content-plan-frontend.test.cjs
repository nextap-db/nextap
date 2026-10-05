const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const admin = read('public/admin/index.html');
const client = read('public/client-dashboard.html');
const limits = import('data:text/javascript;base64,' + Buffer.from(read('public/content-limits.js')).toString('base64'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing page source: ${start}`);
  return source.slice(from, to);
}

// Run the dashboard's serializers and event handler, with only DOM controls stubbed.
const hoursSource = between(admin, 'const HOURS_DAYS', 'const PROFILE_TYPES');
const touchHoursSource = admin.match(/function touchAdminBusinessHours\(target\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(touchHoursSource, 'Missing hours input handler');

function hoursEditor() {
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, {
      id, value: '', checked: false, disabled: false,
      matches: () => /^hours_[a-z]+_(enabled|open|close)$/.test(id)
    });
    return fields.get(id);
  };
  let dirty = false;
  const context = vm.createContext({ $: field, setDirty: value => { dirty = value; } });
  vm.runInContext(hoursSource + '\n' + touchHoursSource, context);
  return {
    field,
    get dirty() { return dirty; },
    run: source => vm.runInContext(source, context),
    load: value => { context.savedHours = value; vm.runInContext('loadBusinessHoursEditor(savedHours)', context); },
    touch: id => { context.target = field(id); vm.runInContext('touchAdminBusinessHours(target)', context); },
    serialize: () => vm.runInContext('serializeBusinessHours()', context)
  };
}

const editorSaveSource = between(client,
  '  const saveButton=editor.querySelector(".nx-editor-save");',
  '  editor.scrollIntoView');

async function contentEditor({ key = 'resume', fieldKey = key, previous, value, fail } = {}) {
  const rules = await limits;
  const draftField = { dataset: { key: fieldKey }, value };
  const save = { disabled: false, textContent: 'Save changes', listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; } };
  const status = { textContent: '' };
  let error;
  const actions = { insertAdjacentElement(_position, node) { error = node; } };
  const editor = {
    hidden: false,
    querySelector: selector => selector === '.nx-editor-save' ? save : actions,
    querySelectorAll: selector => selector === '[data-key]' ? [draftField] : []
  };
  const requests = [];
  const window = { __nxClient: previous, NextapContentLimits: rules };
  window.__nxSetClient = next => { window.__nxClient = next; };
  const context = vm.createContext({
    editor, moduleDef: null, key, label: key, keys: [fieldKey], repeatableKeys: new Set(),
    isClientContentEditable: () => true,
    window,
    document: {
      createElement: () => ({ attributes: {}, setAttribute(name, text) { this.attributes[name] = text; } }),
      getElementById: id => id === 'status' ? status : null
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (fail) throw new Error(fail);
      return { ok: true, json: async () => ({ ...previous, ...body }) };
    },
    render() {}, setTimeout() {}
  });
  vm.runInContext('(function(){' + editorSaveSource + '})()', context);
  return { editor, save, draftField, requests, window, get error() { return error; }, submit: () => save.listeners.click() };
}

test('untouched blank hours stay blank when an unrelated edit saves a full Basic profile', async () => {
  const rules = await limits;
  const editor = hoursEditor();
  const previous = { card_type: 'basic', services: 'Design', skills: 'Art', pricing: 'Package', business_hours: '' };
  editor.load(previous.business_hours);
  editor.field('name').value = 'Updated name';
  editor.touch('name');
  const candidate = { ...previous, name: editor.field('name').value, business_hours: editor.serialize() };
  assert.equal(candidate.business_hours, '');
  assert.equal(editor.field('business_hours').value, '');
  assert.equal(editor.dirty, false, 'An unrelated input must not mark the hours section touched');
  assert.equal(rules.contentUsage(candidate).used, 3);
  assert.equal(rules.contentLimitViolation(candidate, previous), null);
});

test('hours controls and presets deliberately publish a fourth block and mark the draft dirty', async () => {
  const rules = await limits;
  const previous = { card_type: 'basic', services: 'Design', skills: 'Art', pricing: 'Package', business_hours: '' };
  for (const action of ['time', 'checkbox', 'preset']) {
    const editor = hoursEditor();
    editor.load('');
    if (action === 'time') {
      editor.field('hours_monday_open').value = '10:00';
      editor.touch('hours_monday_open');
      assert.equal(JSON.parse(editor.serialize()).find(row => row.day === 1).open, 600);
    } else if (action === 'checkbox') {
      editor.field('hours_monday_enabled').checked = false;
      editor.touch('hours_monday_enabled');
      assert.equal(editor.field('hours_monday_open').disabled, true);
      assert.equal(JSON.parse(editor.serialize()).find(row => row.day === 1).enabled, false);
    } else editor.run('setQuickHours("weekdays")');
    assert.equal(editor.dirty, true, action);
    const candidate = { ...previous, business_hours: editor.serialize() };
    assert.equal(rules.contentUsage(candidate).used, 4, action);
    assert.equal(rules.contentLimitViolation(candidate, previous)?.code, 'CONTENT_BLOCK_LIMIT', action);
  }
});

test('loading saved hours preserves the original until edited and reset starts a blank new draft', () => {
  const editor = hoursEditor();
  editor.run('setQuickHours("247")');
  const original = '  [{"day":1,"enabled":true,"open":540,"close":1020}]  ';
  editor.load(original);
  assert.equal(editor.serialize(), original);
  assert.equal(editor.field('business_hours').value, original);
  editor.field('hours_monday_close').value = '18:00';
  editor.touch('hours_monday_close');
  assert.equal(JSON.parse(editor.serialize()).find(row => row.day === 1).close, 1080);
  editor.run('resetBusinessHoursEditor()');
  assert.equal(editor.serialize(), '');
  assert.equal(editor.field('business_hours').value, '');
});

test('quota rejection stays inline, retains the draft, unlocks Save and sends no request', async () => {
  const editor = await contentEditor({ previous: { card_type: 'basic', services: 'Design', pricing: 'Package', education: 'College' }, value: 'https://example.test/resume' });
  await editor.submit();
  assert.equal(editor.requests.length, 0);
  assert.equal(editor.error.attributes.role, 'alert');
  assert.equal(editor.error.hidden, false);
  assert.match(editor.error.textContent, /would publish 4/);
  assert.equal(editor.draftField.value, 'https://example.test/resume');
  assert.equal(editor.editor.hidden, false);
  assert.equal(editor.save.disabled, false);
  assert.equal(editor.save.textContent, 'Save changes');
});

test('existing full-cap block edits and free contact links still save', async () => {
  const rules = await limits;
  const existing = await contentEditor({ previous: { card_type: 'basic', resume: 'https://example.test/old', services: 'Design', pricing: 'Package' }, value: 'https://example.test/new' });
  await existing.submit();
  assert.equal(existing.requests.length, 1);
  assert.equal(existing.requests[0].body.resume, 'https://example.test/new');
  assert.equal(rules.contentUsage(existing.window.__nxClient).used, 3);
  assert.equal(existing.editor.hidden, true);
  assert.equal(existing.save.disabled, false);
  assert.equal(existing.error.hidden, true);
  const contact = await contentEditor({ key: 'contact', fieldKey: 'website', previous: { card_type: 'basic', services: 'Design', pricing: 'Package', education: 'College' }, value: 'https://example.test/contact' });
  await contact.submit();
  assert.equal(contact.requests.length, 1);
  assert.equal(contact.requests[0].body.website, 'https://example.test/contact');
  assert.equal(rules.contentUsage(contact.window.__nxClient).used, 3);
  assert.equal(contact.editor.hidden, true);
});

test('network save errors retain content and use the same inline alert with Save unlocked', async () => {
  const editor = await contentEditor({ previous: { card_type: 'basic', resume: 'https://example.test/old' }, value: 'https://example.test/new', fail: 'Network unavailable' });
  await editor.submit();
  assert.equal(editor.requests.length, 1);
  assert.equal(editor.error.attributes.role, 'alert');
  assert.equal(editor.error.textContent, 'Network unavailable');
  assert.equal(editor.error.hidden, false);
  assert.equal(editor.editor.hidden, false);
  assert.equal(editor.draftField.value, 'https://example.test/new');
  assert.equal(editor.save.disabled, false);
});
