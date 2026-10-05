const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/client-dashboard.html');
const workspaceSource = read('public/client-workspace.js');
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const limitsUrl = dataUrl(read('public/content-limits.js'));
const workspace = import(dataUrl(workspaceSource.replace("'./content-limits.js'", JSON.stringify(limitsUrl))));
const limits = import(limitsUrl);
const firstScript = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(match => !/\bsrc\s*=/.test(match[1]))[2];
const between = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};

class Field {
  constructor(id) {
    this.id = id; this.value = ''; this.checked = false; this.type = id === 'featured_enabled' || id.startsWith('vis_') ? 'checkbox' : id === 'email' ? 'email' : 'text';
    this.dataset = {}; this.style = {}; this.listeners = {}; this.files = []; this.readOnly = id === 'featured_image'; this.disabled = false;
    this.attributes = {}; this.nativeValid = true; this.validityChecks = 0;
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() { this.focused = true; }
  checkValidity() {
    this.validityChecks++;
    return this.nativeValid && (!this.required || Boolean(this.value.trim())) &&
      (this.type !== 'email' || !this.value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value));
  }
}

async function mainPage(options = {}) {
  const rules = await limits, helpers = await workspace;
  let record = { id: 'fictional', slug: 'fictional', name: 'Saved Name', email: 'owner@example.test', phone: '09171234567', website: 'https://example.test/old', card_type: 'gold', content_revision: 4, photo: 'data:image/png;base64,fictional', ...options.record };
  const fields = new Map();
  const field = id => { if (!fields.has(id)) fields.set(id, new Field(id)); return fields.get(id); };
  const conflicts = [], requests = [];
  const window = { location: { replace() { assert.fail('Valid fictional session should load'); } }, NextapContentLimits: rules, NextapClientWorkspace: { ...helpers, showConflict: error => { if (error.conflict) conflicts.push(error); } }, dispatchEvent() {} };
  const context = vm.createContext({
    window, document: { getElementById: field, querySelectorAll: () => [] },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    fetch: async (url, init) => {
      if (url === '/api/client-auth/me') return { ok: true, json: async () => ({ authenticated: true, client: record }) };
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      requests.push({ url, init, body });
      if (options.respond) {
        const custom = await options.respond(url, init, body, record);
        if (custom) return custom;
      }
      const latest = window.__nxClient || record;
      const next = { ...record, ...latest, content_revision: latest.content_revision + 1 };
      if (url === '/api/client/profile') { const { expected_revision, ...fields } = body; Object.assign(next, fields); }
      if (url === '/api/client/photo') next.photo = init.method === 'DELETE' ? '' : 'data:image/webp;base64,new-fictional-photo';
      record = next;
      return { ok: true, status: 200, json: async () => url === '/api/client/password' ? { ok: true, client: next } : next };
    },
    nxCropOpen: (_source, callback) => callback({ size: 100, type: 'image/webp' }),
    URL: class extends URL { static createObjectURL() { return 'blob:fictional-crop'; } },
    FormData: class { constructor() { this.fields = []; } append(...values) { this.fields.push(values); } },
    navigator: {}, location: { origin: 'https://example.test' }
  });
  await vm.runInContext(firstScript, context);
  const save = () => field('profileForm').listeners.submit({ preventDefault() {} });
  const submitThroughBrowser = () => {
    // Interactive form submission checks every associated control before the
    // submit event unless the actual page opts into scoped validation.
    const form = html.match(/<form\b[^>]*\bid="profileForm"[^>]*>/)[0];
    if (!/\bnovalidate\b/i.test(form) && [...fields.values()].some(control => !control.checkValidity())) return false;
    return save();
  };
  return { field, window, requests, conflicts, save, submitThroughBrowser };
}

test('main Save sends only changed fields after a section save and retains unrelated profile drafts', async () => {
  const page = await mainPage();
  page.field('name').value = 'Unsaved New Name';
  page.window.__nxSetClient({ ...page.window.__nxClient, website: 'https://example.test/new-contact', content_revision: 5 });
  assert.equal(page.field('website').value, 'https://example.test/new-contact');
  assert.equal(page.field('name').value, 'Unsaved New Name');
  await page.save();
  assert.deepEqual(page.requests[0].body, { name: 'Unsaved New Name', expected_revision: 5 });
  assert.equal(page.field('website').value, 'https://example.test/new-contact');
  assert.equal(page.field('save').disabled, false);
  await page.save();
  assert.equal(page.requests.length, 1, 'An unchanged main form must not resubmit stale content');
});

test('browser Profile Save ignores an invalid retained content URL without losing that draft', async () => {
  const page = await mainPage();
  const content = page.field('nxRetainedContentLink');
  content.type = 'url'; content.value = 'unfinished content link'; content.nativeValid = false;
  page.field('name').value = 'Edited Profile Name';
  await page.submitThroughBrowser();
  assert.deepEqual(page.requests[0]?.body, { name: 'Edited Profile Name', expected_revision: 4 });
  assert.equal(content.value, 'unfinished content link');
  assert.equal(content.validityChecks, 0, 'The main patch must not validate unrelated content controls');
  assert.equal(page.field('save').disabled, false);
  assert.match(page.field('status').textContent, /Saved successfully/);
});

test('scoped Profile Save still rejects edited name and email inline', async () => {
  const page = await mainPage();
  page.field('name').value = '   ';
  await page.submitThroughBrowser();
  assert.equal(page.requests.length, 0);
  assert.match(page.field('status').textContent, /Name is required/);
  assert.equal(page.field('name').attributes['aria-invalid'], 'true');
  page.field('name').value = 'Edited Name';
  page.field('email').value = 'not-an-email';
  await page.submitThroughBrowser();
  assert.equal(page.requests.length, 0);
  assert.match(page.field('status').textContent, /valid email/);
  assert.equal(page.field('email').value, 'not-an-email');
  assert.equal(page.field('save').disabled, false);
  page.field('email').value = 'owner@example.test';
  await page.submitThroughBrowser();
  assert.deepEqual(page.requests[0].body, { name: 'Edited Name', expected_revision: 4 });
});

test('Profile Save retains accepted Messenger usernames and bare website domains in text controls', async () => {
  const page = await mainPage();
  for (const key of ['messenger', 'website']) {
    const markup = html.match(new RegExp('<input\\b[^>]*\\bid="' + key + '"[^>]*>'))[0];
    assert.doesNotMatch(markup, /\btype="url"/);
    assert.equal(page.field(key).type, 'text');
  }
  page.field('messenger').value = 'fictional.owner';
  page.field('website').value = 'www.example.test';
  await page.submitThroughBrowser();
  assert.deepEqual(page.requests[0].body, { messenger: 'fictional.owner', website: 'www.example.test', expected_revision: 4 });
  assert.equal(page.field('messenger').value, 'fictional.owner');
  assert.equal(page.field('website').value, 'www.example.test');
  assert.match(page.field('status').textContent, /Saved successfully/);
});

test('profile photo removal preserves unsaved text and sends the current revision header', async () => {
  const page = await mainPage();
  page.field('about').value = 'Unsaved biography';
  await page.field('removePhoto').listeners.click();
  assert.equal(page.requests[0].init.headers['X-Expected-Revision'], '4');
  assert.equal(page.field('about').value, 'Unsaved biography');
  assert.equal(page.window.__nxClient.content_revision, 5);
  assert.equal(page.field('removePhoto').disabled, false);
});

test('cropped profile upload preserves text drafts and uses the same guarded photo route', async () => {
  const page = await mainPage();
  page.field('name').value = 'Local Name';
  page.field('photoFile').files = [{ type: 'image/png', size: 100 }];
  page.field('photoFile').listeners.change();
  await page.field('uploadPhoto').listeners.click();
  assert.equal(page.requests[0].url, '/api/client/photo');
  assert.equal(page.requests[0].init.headers['X-Expected-Revision'], '4');
  assert.equal(page.requests[0].body.fields[0][0], 'photo');
  assert.equal(page.field('name').value, 'Local Name');
  assert.equal(page.window.__nxClient.content_revision, 5);
});

test('typing while a main save is in flight retains the later local value', async () => {
  let complete;
  const page = await mainPage({ respond: (url, _init, body, record) => url === '/api/client/profile' ? new Promise(resolve => {
    complete = () => resolve({ ok: true, status: 200, json: async () => ({ ...record, ...body, content_revision: 5 }) });
  }) : null });
  page.field('name').value = 'First Edit';
  const pending = page.save();
  page.field('name').value = 'Second Edit';
  complete();
  await pending;
  assert.equal(page.field('name').value, 'Second Edit');
  assert.equal(page.window.__nxClient.name, 'First Edit');
  assert.equal(page.window.nxHasMainDraft(), true);
});

test('a revision conflict retains the main draft and makes conflict reload available', async () => {
  const page = await mainPage({ respond: url => url === '/api/client/profile' ? { ok: false, status: 409, json: async () => ({ code: 'PROFILE_CHANGED', error: 'Reload the latest profile.' }) } : null });
  page.field('company').value = 'Unsaved Company';
  await page.save();
  assert.equal(page.field('company').value, 'Unsaved Company');
  assert.equal(page.conflicts.length, 1);
  assert.equal(page.field('save').disabled, false);
  assert.match(page.field('status').textContent, /Reload/);
});

test('an existing phone-only owner can edit other fields without creating an email', async () => {
  const page = await mainPage({ record: { email: '' } });
  assert.equal(page.field('email').required, false);
  page.field('job_title').value = 'Designer';
  await page.save();
  assert.deepEqual(page.requests[0].body, { job_title: 'Designer', expected_revision: 4 });
  assert.equal(page.field('email').value, '');
});

test('password success refreshes the full record and revision without clearing unrelated drafts', async () => {
  const page = await mainPage();
  page.field('company').value = 'Unsaved Company';
  page.field('current_password').value = 'old-fictional-pass';
  page.field('new_password').value = page.field('confirm_password').value = 'new-fictional-pass';
  await page.field('changePassword').listeners.click();
  assert.equal(page.requests[0].body.expected_revision, 4);
  assert.equal(page.window.__nxClient.content_revision, 5);
  assert.equal(page.field('company').value, 'Unsaved Company');
  assert.equal(page.field('new_password').value, '');
});

test('repeatable row identity keeps the surviving school metadata and deliberately clears edited details', async () => {
  const helpers = await workspace;
  const source = JSON.stringify([{ name: 'School A', degree: 'Degree A', custom: { keep: 1 } }, { name: 'School B', degree: 'Degree B', issuerId: 'B' }]);
  const entries = helpers.repeatableEntries(source);
  const saved = JSON.parse(helpers.mergeRepeatableItems('education', [{ ...entries[1], value: 'School B Updated', details: { degree: '', course: 'Design' } }]));
  assert.deepEqual(saved, [{ name: 'School B Updated', degree: '', issuerId: 'B', course: 'Design' }]);
  assert.equal(entries[1].original.degree, 'Degree B', 'Editing must not mutate the original record');
  const fields = helpers.repeatableDetailSchema('education', entries[1].original).map(field => field[0]);
  assert.ok(fields.includes('degree') && fields.includes('course') && fields.includes('start_date') && fields.includes('end_date'));
  assert.deepEqual(helpers.repeatableDetailSchema('skills', null), []);
  assert.equal(helpers.repeatableDetailSchema('skills', { name: 'Design', level: 'Advanced' })[0][0], 'level');
  const certificate = { name: 'Certificate', organization: 'Original Issuer', url: 'https://example.test/certificate', unknown: 7 };
  const schema = helpers.repeatableDetailSchema('certifications', certificate);
  assert.ok(schema.some(field => field[0] === 'organization') && schema.some(field => field[0] === 'url'));
  const cleared = JSON.parse(helpers.mergeRepeatableItems('certifications', [{ value: 'Certificate', original: certificate, details: { organization: '', url: '' } }]))[0];
  assert.equal(cleared.organization, ''); assert.equal(cleared.url, ''); assert.equal(cleared.unknown, 7);
});

test('legacy structured rows keep useful aliases and unknown metadata instead of becoming empty', async () => {
  const helpers = await workspace;
  assert.deepEqual(helpers.structuredItems('services', 'Design\nConsulting'), [{ name: 'Design' }, { name: 'Consulting' }]);
  const source = { title: 'Original Service', url: 'https://example.test/service', custom: { keep: true } };
  const row = helpers.structuredItems('services', JSON.stringify([source]))[0];
  assert.equal(row.name, 'Original Service');
  assert.equal(row.link, source.url);
  assert.deepEqual(row.custom, source.custom);
});

test('cached section drafts retain the same rows/listeners through switches and can be discarded', async () => {
  const { SectionDrafts } = await workspace;
  const store = new SectionDrafts(), node = { value: 'draft', listener: () => 'still attached', original: { id: 'B' } };
  store.keep('education', [node], 'saved', 'edited');
  store.keep('skills', [{ value: 'another draft' }], 'before', 'after');
  assert.equal(store.get('education').nodes[0], node);
  assert.equal(store.get('education').nodes[0].listener(), 'still attached');
  store.clear('skills');
  assert.equal(store.has('education'), true);
  store.keep('education', [node], 'saved', 'saved');
  assert.equal(store.has('education'), false);
});

test('client hours parse legacy ranges, object strings and named day entries without silent closing', async () => {
  const source = between(html, 'function parseDashboardHours(', 'function minutesToTimeInput(');
  const context = vm.createContext({}); vm.runInContext(source, context);
  context.raw = 'Mon-Fri — 9:00 AM - 6:00 PM';
  let result = vm.runInContext('parseDashboardHours(raw)', context);
  assert.equal(result.filter(day => day.enabled).length, 5);
  assert.equal(result[1].open, 540); assert.equal(result[1].close, 1080);
  context.raw = JSON.stringify({ monday: '9:00 AM - 6:00 PM', sunday: 'Closed' });
  result = vm.runInContext('parseDashboardHours(raw)', context);
  assert.equal(result[1].enabled, true); assert.equal(result[0].enabled, false);
  context.raw = JSON.stringify([{ day: 'friday', enabled: true, open: 600, close: 900 }]);
  result = vm.runInContext('parseDashboardHours(raw)', context);
  assert.equal(result[5].open, 600); assert.equal(result[0].enabled, false);
  const helpers = await workspace;
  assert.match(helpers.hoursEditorWarning('[{"day":1,"periods":[{"open":540,"close":720},{"open":780,"close":1020}]}]', result), /stays unchanged until you edit/);
});

test('specialized array/object summaries display saved titles rather than object coercion', () => {
  const context = vm.createContext({ window: { __nxClient: { profile_modules: JSON.stringify({ media: [{ title: 'Showreel', url: 'https://example.test/video', metadata: { keep: 1 } }], games: { name: 'Chess', rank: 'Gold' } }) } } });
  vm.runInContext(between(html, 'function contentSummary(', 'function isContentEnabled('), context);
  assert.equal(vm.runInContext('value(["module:media"])', context), 'Showreel');
  assert.equal(vm.runInContext('value(["module:games"])', context), 'Chess');
});

test('Add content availability follows admin global, regular, featured and specialized flags', () => {
  const context = vm.createContext({ window: {}, getProfileModule: key => ['media', 'games'].includes(key) });
  vm.runInContext(between(html, 'function getClientModuleVisibility(', 'function isClientContentEditable('), context);
  vm.runInContext(between(html, 'window.nxClientCanAddContent=', 'function contentSummary('), context);
  const allowed = context.window.nxClientCanAddContent;
  assert.equal(allowed('contact', { quick_info_enabled: false }), true);
  assert.equal(allowed('services', { quick_info_enabled: false }), false);
  assert.equal(allowed('services', { show_services: false }), false);
  assert.equal(allowed('media', { profile_module_visibility: '{"media":false}' }), false);
  assert.equal(allowed('featured', { featured_enabled: false }), false);
  assert.equal(allowed('featured', { featured_enabled: true }), true);
  assert.equal(allowed('skills', { show_skills: true }), true);
});

test('revision helpers accept revision zero and only offer reload for revision conflicts', async () => {
  const helpers = await workspace;
  assert.deepEqual(helpers.withRevision({ name: 'Name' }, { content_revision: 0 }), { name: 'Name', expected_revision: 0 });
  assert.deepEqual(helpers.revisionHeaders({ content_revision: 12 }), { 'X-Expected-Revision': '12' });
  assert.deepEqual(helpers.revisionHeaders({ content_revision: -1 }), {});
  assert.equal(helpers.responseError({ status: 409 }, { code: 'PROFILE_CHANGED', error: 'Reload' }).conflict, true);
  assert.equal(helpers.responseError({ status: 409 }, { error: 'Duplicate email' }).conflict, false);
});

test('editor validation rejects unsafe URL protocols, opens optional details and focuses the field', () => {
  const details = { open: false }, attributes = {};
  let focused = 0, reported = 0;
  const field = {
    type: 'url', value: 'ftp://example.test/file', disabled: false,
    checkValidity: () => true, removeAttribute: name => delete attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; }, getAttribute: name => attributes[name] || '',
    labels: [{ textContent: 'Certificate link' }], closest: () => details,
    focus: () => focused++, reportValidity: () => reported++, matches: () => false
  };
  const editor = { querySelectorAll: () => [field], querySelector: () => null };
  const context = vm.createContext({ associateLabels() {}, URL, editor });
  vm.runInContext(between(workspaceSource, '  function validateEditor(', '  function showConflict('), context);
  assert.throws(() => vm.runInContext('validateEditor(editor)', context), /complete http:\/\/ or https:\/\/ link/);
  assert.equal(details.open, true);
  assert.equal(attributes['aria-invalid'], 'true');
  assert.match(attributes['aria-describedby'], /nxContentSaveError/);
  assert.equal(focused, 1); assert.equal(reported, 1);
  field.type = 'text'; field.value = '@social-user';
  assert.doesNotThrow(() => vm.runInContext('validateEditor(editor)', context));
});

test('structured specialized rows preserve the surviving object and string shape on save', async () => {
  const rules = await limits;
  const survivor = { __nxOriginalItem: { title: 'Item B', url: 'https://example.test/b', metadata: { own: 'B' } }, querySelectorAll: () => [{ dataset: { moduleField: 'title' }, value: 'Item B Updated' }, { dataset: { moduleField: 'url' }, value: 'https://example.test/new-b' }] };
  const editor = { dataset: { moduleShape: 'array' }, querySelectorAll: () => [survivor] };
  const context = vm.createContext({ limits: rules, originalRow: row => ({ ...row.__nxOriginalItem }), editor });
  vm.runInContext(between(workspaceSource, '  function collectModuleRows(', '  function associateLabels('), context);
  const saved = JSON.parse(JSON.stringify(vm.runInContext('collectModuleRows(editor)', context)));
  assert.deepEqual(saved, [{ title: 'Item B Updated', url: 'https://example.test/new-b', metadata: { own: 'B' } }]);
  survivor.__nxOriginalItem = null; survivor.__nxOriginalString = true;
  survivor.querySelectorAll = () => [{ dataset: { moduleField: 'name' }, value: 'Chess' }, { dataset: { moduleField: 'description' }, value: '' }, { dataset: { moduleField: 'link' }, value: '' }];
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('collectModuleRows(editor)', context))), ['Chess']);
});

test('Add picker offers only admin-permitted sections and permits continuing drafts at a full plan', async () => {
  const rules = await limits;
  class Node {
    constructor() { this.children = []; this.listeners = {}; this.dataset = {}; }
    replaceChildren() { this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    focus() {}
  }
  const nodes = new Map(['nxContentPicker', 'nxContentPickerList', 'nxContentPickerClose'].map(id => [id, new Node()]));
  const drafts = new Set(['services']); let opened;
  const context = vm.createContext({
    limits: rules, capture() {}, drafts: { has: key => drafts.has(key) },
    byId: id => nodes.get(id), document: { activeElement: new Node(), createElement: () => new Node() },
    window: { __nxClient: { card_type: 'basic', pricing: 'Rates', education: 'School', resume: 'https://example.test/cv', show_services: true, show_skills: false, featured_enabled: false },
      nxClientContentCatalog: [['contact', '', 'Contact', 'Social links'], ['services', '', 'Services', 'Offers'], ['skills', '', 'Skills', 'Skills'], ['featured', '', 'Featured', 'Highlight']],
      nxClientCanAddContent: (key, current) => key === 'contact' || (key === 'featured' ? current.featured_enabled : current['show_' + key] === true),
      openEditor: key => { opened = key; } }
  });
  vm.runInContext('let pickerFocus=null;\n' + between(workspaceSource, '  function openPicker(', '  window.NextapClientWorkspace ='), context);
  vm.runInContext('openPicker()', context);
  const choices = nodes.get('nxContentPickerList').children;
  assert.equal(choices.length, 2);
  assert.match(choices[1].children[0].textContent, /Services/);
  assert.equal(choices[1].disabled, false, 'A local draft can be reviewed even when publication slots are full');
  choices[1].listeners.click();
  assert.equal(opened, 'services');
  assert.equal(nodes.get('nxContentPicker').hidden, true);
  drafts.clear(); vm.runInContext('openPicker()', context);
  assert.equal(nodes.get('nxContentPickerList').children[1].disabled, true, 'A new published block needs an available slot');
});
