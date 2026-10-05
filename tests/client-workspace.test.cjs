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

async function clientContentPage(record, draftKeys = []) {
  const rules = await limits, helpers = await workspace;
  const drafts = new helpers.SectionDrafts();
  for (const key of draftKeys) drafts.keep(key, [{ key, value: 'Local draft', listener: () => key }], 'saved', 'edited');
  const fields = new Map(), groups = new Map();
  for (const id of ['nxProfileBlocks', 'nxSpecializedBlocks', 'nxProfessionalBlocks', 'nxBusinessBlocks']) {
    const group = { hidden: false, style: {} };
    groups.set(id, group);
    fields.set(id, { innerHTML: '', closest: () => group });
  }
  for (const id of ['nxFeaturedSummary', 'nxFeaturedState', 'nxContentPercent', 'nxContentProgressBar']) {
    fields.set(id, { textContent: '', className: '', style: {} });
  }
  const featuredGroup = { hidden: false, style: {} }, featuredEdit = { disabled: false, textContent: 'Edit' };
  const featuredBlock = { hidden: false, closest: () => featuredGroup, querySelector: () => featuredEdit };
  const editor = { hidden: true, dataset: {}, style: {} };
  fields.set('nxContentEditor', editor);
  let captured = 0;
  const captureEvents = [];
  const window = {
    __nxClient: record,
    nxProfileModuleDefs: rules.SPECIAL_BLOCKS.map(key => [key]),
    NextapContentLimits: rules,
    NextapClientWorkspace: {
      hasDraft: key => drafts.has(key),
      capture: () => { captured++; captureEvents.push({ key: editor.dataset.contentKey, hidden: editor.hidden }); }
    }
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: id => fields.get(id),
      querySelector: selector => selector.includes('data-block') && selector.includes('featured') ? featuredBlock : null
    },
    $: id => fields.get(id)
  });
  // Execute the actual catalog, availability, summaries, grouping and render
  // pipeline. The stub only records the resulting HTML and wrapper visibility.
  const rendering = between(html, 'const groups={', 'function escapeHtml(v)');
  const visibility = between(html, 'function getProfileModule(', 'function openEditor(');
  vm.runInContext(visibility + '\n' + rendering, context);
  const render = () => window.nxRenderClientContent();
  const rows = id => [...fields.get(id).innerHTML.matchAll(/data-block="([^"]+)"/g)].map(match => match[1]);
  return {
    render, rows, fields, groups, featuredGroup, featuredBlock, featuredEdit, editor, drafts, window, captureEvents,
    get captured() { return captured; },
    allHTML: () => [...fields.values()].map(field => field.innerHTML || '').join('')
  };
}

test('client Content omits admin-disabled saved rows and drafts without altering their data', async () => {
  const rules = await limits;
  const record = {
    card_type: 'gold', quick_info_enabled: true,
    ...Object.fromEntries(rules.QUICK_BLOCKS.map(key => ['show_' + key, false])),
    services: JSON.stringify([{ name: 'Retained service', details: { keep: 'original' } }]),
    education: JSON.stringify([{ name: 'Retained school', degree: 'Retained degree' }]),
    profile_modules: JSON.stringify({ media: [{ title: 'Retained video', metadata: { keep: true } }] }),
    profile_module_visibility: JSON.stringify(Object.fromEntries(rules.SPECIAL_BLOCKS.map(key => [key, false]))),
    featured_enabled: false, featured_title: 'Retained featured title'
  };
  const snapshot = JSON.stringify(record);
  const page = await clientContentPage(record, ['services', 'education', 'media', 'featured']);
  const storedDraft = page.drafts.get('services');
  page.render();
  assert.deepEqual(page.rows('nxProfileBlocks'), ['contact']);
  for (const id of ['nxBusinessBlocks', 'nxProfessionalBlocks', 'nxSpecializedBlocks']) {
    assert.deepEqual(page.rows(id), []);
    assert.equal(page.groups.get(id).hidden, true, id + ' must not leave an empty category heading');
  }
  assert.equal(page.featuredGroup.hidden, true);
  assert.doesNotMatch(page.allHTML(), /Hidden by admin|Retained service|Retained school|Retained video/);
  assert.equal(JSON.stringify(record), snapshot, 'Visibility must not delete private stored content');
  assert.equal(page.drafts.get('services'), storedDraft, 'Visibility must not discard cached draft nodes');
  assert.equal(storedDraft.nodes[0].listener(), 'services');
  for (const key of ['education', 'media', 'featured']) assert.equal(page.drafts.has(key), true);
});

test('client Content retains enabled configured entries and local drafts while filtering disabled neighbors', async () => {
  const rules = await limits;
  const record = {
    card_type: 'basic', quick_info_enabled: true,
    ...Object.fromEntries(rules.QUICK_BLOCKS.map(key => ['show_' + key, false])),
    show_services: true, services: 'Design and consulting',
    show_education: true, education: JSON.stringify([{ name: 'Design school', degree: 'BA' }]),
    show_pricing: true, pricing: '',
    booking: 'Retained disabled booking',
    profile_modules: JSON.stringify({ media: [{ title: 'Portfolio film' }], games: { name: 'Retained hidden game' } }),
    profile_module_visibility: { media: true, games: false },
    featured_enabled: false, featured_title: 'Retained hidden featured title'
  };
  const page = await clientContentPage(record, ['pricing', 'booking', 'games']);
  page.render();
  assert.deepEqual(page.rows('nxBusinessBlocks'), ['services', 'pricing']);
  assert.deepEqual(page.rows('nxProfessionalBlocks'), ['education']);
  assert.deepEqual(page.rows('nxSpecializedBlocks'), ['media']);
  assert.equal(page.groups.get('nxBusinessBlocks').hidden, false);
  assert.equal(page.groups.get('nxProfessionalBlocks').hidden, false);
  assert.equal(page.groups.get('nxSpecializedBlocks').hidden, false);
  assert.match(page.fields.get('nxBusinessBlocks').innerHTML, /Continue draft/);
  assert.match(page.fields.get('nxBusinessBlocks').innerHTML, /UNSAVED DRAFT/);
  assert.match(page.fields.get('nxSpecializedBlocks').innerHTML, /Portfolio film/);
  assert.doesNotMatch(page.allHTML(), /Retained disabled booking|Retained hidden game|Hidden by admin/);
  assert.equal(page.drafts.has('booking'), true);
  assert.equal(page.drafts.has('games'), true);
  assert.equal(record.pricing, '');
});

test('the Quick Info master gate removes regular and specialized categories while Contact and enabled Featured remain', async () => {
  for (const off of [false, 0, '0']) {
    const record = {
      card_type: 'gold', quick_info_enabled: off,
      services: 'Stored service', show_services: true,
      education: 'Stored school', show_education: true,
      profile_modules: '{"media":[{"title":"Stored video"}]}', profile_module_visibility: '{"media":true}',
      featured_enabled: true, featured_title: 'Independent featured content'
    };
    const snapshot = JSON.stringify(record);
    const page = await clientContentPage(record, ['services', 'media']);
    page.render();
    assert.deepEqual(page.rows('nxProfileBlocks'), ['contact'], String(off));
    for (const id of ['nxBusinessBlocks', 'nxProfessionalBlocks', 'nxSpecializedBlocks']) {
      assert.deepEqual(page.rows(id), [], String(off) + ': ' + id);
      assert.equal(page.groups.get(id).hidden, true);
    }
    assert.equal(page.featuredGroup.hidden, false);
    assert.equal(page.featuredEdit.disabled, false);
    assert.equal(JSON.stringify(record), snapshot);
  }
});

test('enabled empty sections remain Add choices, and an enabled local draft can reappear after admin permission returns', async () => {
  const rules = await limits;
  const record = {
    card_type: 'basic', quick_info_enabled: true,
    ...Object.fromEntries(rules.QUICK_BLOCKS.map(key => ['show_' + key, false])),
    show_services: true, services: '',
    profile_modules: '{}', profile_module_visibility: JSON.stringify(Object.fromEntries(rules.SPECIAL_BLOCKS.map(key => [key, false]))),
    featured_enabled: false
  };
  const page = await clientContentPage(record);
  page.render();
  assert.deepEqual(page.rows('nxBusinessBlocks'), []);
  assert.equal(page.groups.get('nxBusinessBlocks').hidden, true);
  assert.equal(page.window.nxClientCanAddContent('services', record), true, 'An empty enabled section stays available in Add content');
  assert.equal(page.window.nxClientCanAddContent('booking', record), false);
  const nodes = [{ value: 'New unsaved service', original: { id: 'own-row' } }];
  page.drafts.keep('services', nodes, 'saved', 'changed');
  page.render();
  assert.deepEqual(page.rows('nxBusinessBlocks'), ['services']);
  assert.equal(page.groups.get('nxBusinessBlocks').hidden, false);
  page.window.__nxClient = { ...record, show_services: false };
  page.render();
  assert.deepEqual(page.rows('nxBusinessBlocks'), []);
  assert.equal(page.drafts.get('services').nodes[0], nodes[0]);
  page.window.__nxClient = record;
  page.render();
  assert.deepEqual(page.rows('nxBusinessBlocks'), ['services']);
  assert.equal(record.services, '');
});

test('Featured permission hides saved and local content without removing it, including when every other group is empty', async () => {
  const record = {
    card_type: 'gold', quick_info_enabled: false,
    featured_enabled: false, featured_description: 'Stored description', featured_image: 'https://example.test/retained.webp'
  };
  const page = await clientContentPage(record, ['featured']);
  const snapshot = JSON.stringify(record);
  page.render();
  assert.equal(page.featuredGroup.hidden, true);
  assert.equal(page.drafts.has('featured'), true);
  for (const on of [true, 1, '1']) {
    page.window.__nxClient = { ...record, featured_enabled: on };
    page.render();
    assert.equal(page.featuredGroup.hidden, false, String(on));
    assert.equal(page.featuredEdit.disabled, false);
    assert.match(page.featuredEdit.textContent, /Continue draft/);
  }
  assert.equal(JSON.stringify(record), snapshot);
});

test('a disabled open section captures its draft before closing, while permitted editors stay open', async () => {
  for (const key of ['services', 'media', 'featured']) {
    const record = {
      card_type: 'gold', quick_info_enabled: true,
      show_services: true, services: 'Saved service',
      profile_modules: '{"media":[{"title":"Saved video","metadata":{"keep":true}}]}',
      profile_module_visibility: '{"media":true}', featured_enabled: true, featured_title: 'Saved highlight'
    };
    const page = await clientContentPage(record, [key]);
    const draft = page.drafts.get(key);
    page.editor.dataset.contentKey = key;
    page.editor.hidden = false;
    page.editor.childNodes = draft.nodes;
    page.render();
    assert.equal(page.editor.hidden, false, key + ': permission must not close a valid active editor');
    assert.equal(page.captured, 0);
    page.window.__nxClient = key === 'services' ? { ...record, show_services: false }
      : key === 'media' ? { ...record, profile_module_visibility: '{"media":false}' }
      : { ...record, featured_enabled: false };
    const stored = JSON.stringify(page.window.__nxClient);
    page.render();
    assert.equal(page.editor.hidden, true, key + ': disabled editing must no longer remain visible');
    assert.deepEqual(page.captureEvents, [{ key, hidden: false }], 'Capture must precede hiding');
    assert.equal(page.drafts.get(key), draft);
    assert.equal(page.editor.childNodes[0], draft.nodes[0]);
    assert.equal(JSON.stringify(page.window.__nxClient), stored);
  }
});

test('regular visibility off values filter saved content and local drafts before building rows', async () => {
  for (const off of [false, 0, '0']) {
    const page = await clientContentPage({
      card_type: 'gold', quick_info_enabled: true, show_services: off,
      services: 'Private retained service', profile_modules: '{}', featured_enabled: false
    }, ['services']);
    page.render();
    assert.equal(page.rows('nxBusinessBlocks').includes('services'), false, String(off));
    assert.doesNotMatch(page.allHTML(), /Private retained service|Hidden by admin/);
    assert.equal(page.drafts.has('services'), true);
  }
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
