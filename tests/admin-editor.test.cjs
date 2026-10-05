const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin/index.html'), 'utf8');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const limitsURL = 'data:text/javascript;base64,' + Buffer.from(read('public/content-limits.js')).toString('base64');
const helpers = import('data:text/javascript;base64,' + Buffer.from(read('public/admin/editor.js').replace("'../content-limits.js'", JSON.stringify(limitsURL))).toString('base64'));
function between(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
const saveSource = between('async function saveClient(){', 'window.editClient =');
const dirtySource = between('function setDirty(', 'function confirmLeaveEditor(){');
const leaveSource = between('function confirmLeaveEditor(){', 'function openNewClient(){');
const linkSource = between('const adminSavedLinks=', 'function openNewClient(){');
const editSource = between('window.editClient =', 'window.toggleClientStatus =');
const wrapperSource = between('const originalEditClient =', 'document.getElementById("openPreview")');
const defer = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

async function saveHarness({ create = false, responseStatus = 200, responseBody, uploadGate, saveGate, listRevision } = {}) {
  const limits = await import(limitsURL);
  const fields = new Map(), field = id => {
    if (!fields.has(id)) fields.set(id, { id, value: '', checked: true, files: [], disabled: false, style: {}, className: '', textContent: '' });
    return fields.get(id);
  };
  field('name').value = 'Original name';
  field('featured_enabled').checked = false;
  const previous = { id: 'client-1', name: 'Original name', slug: 'original-name', card_type: 'basic', content_revision: 7, featured_image: 'https://example.test/saved.webp' };
  const requests = [], uploads = [], conflicts = [], previewCalls = [], moduleRenders = [];
  const context = vm.createContext({
    $, console, JSON, Date,
    document: { querySelectorAll: () => [] },
    editingId: create ? null : previous.id, editingSlug: create ? null : previous.slug,
    editingRevision: create ? null : 7, adminEditingBaseline: create ? null : previous,
    clientEditorOpen: true, formDirty: true, suppressDirty: false, savingClient: false,
    editorDraftVersion: 0, legacyCardTypeForSave: 'basic', activeAdminSection: 'quickinfo',
    profilePhotoBlob: null, profilePhotoSourceUrl: previous.photo || '', adminOriginalContent: {},
    ADMIN_STRUCTURED_FIELDS: new Set(['products', 'pricing', 'services']),
    window: {
      clients: create ? [] : [previous], NextapContentLimits: limits,
      nxCollectAdminModules: () => JSON.stringify({ media: field('media').value }),
      nxCollectAdminModuleVisibility: () => '{}',
      nxRenderAdminModules: (...args) => moduleRenders.push(args),
      NextapAdminEditor: { refresh() {}, setConflict: value => conflicts.push(value), captureRows: () => [], acceptRows() {}, isReloading: () => false },
      NextapContentPlanUI: { refreshAdmin() {} }
    },
    slug: value => value.toLowerCase().replaceAll(' ', '-'),
    getProfileType: () => 'personal', getBusinessLocationsAdmin: () => [],
    serializeBusinessHours: () => '', syncAdminServicesEditor: () => '', syncAdminPortfolioEditor: () => '',
    syncAdminBookingEditor: () => '', syncAdminReviewsEditor: () => '', adminSerializeContent: (_key, value) => value,
    releaseAdminPhotoPreview() {}, renderAdminPhotoPreview(value) { field('photoPreview').value = value; },
    showProfilePreview: value => previewCalls.push(value), setAdminSection() {}, openNewClient() {},
    loadClients: async () => { if (listRevision != null) context.window.clients = [{ ...previous, content_revision: listRevision }]; },
    uploadFile: async file => { uploads.push(file); if (uploads.length === 1 && uploadGate) await uploadGate.promise; return 'https://example.test/' + file.name; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); requests.push({ url, body, method: init.method });
      if (saveGate) await saveGate.promise;
      return { ok: responseStatus === 200, status: responseStatus, json: async () => responseBody || { ...previous, ...body, id: previous.id, content_revision: create ? 0 : 8 } };
    }
  });
  function $(id) { return field(id); }
  vm.runInContext(dirtySource + '\n' + linkSource + '\n' + saveSource, context);
  return { context, field, requests, uploads, conflicts, previewCalls, moduleRenders,
    save: () => vm.runInContext('saveClient()', context),
    dirty: () => vm.runInContext('setDirty(true)', context) };
}

test('admin save keeps edits typed during the request and captures its original revision', async () => {
  const gate = defer(), editor = await saveHarness({ saveGate: gate, listRevision: 99 });
  editor.field('media').value = 'Submitted media';
  const saving = editor.save();
  assert.equal(editor.requests.length, 1);
  assert.equal(editor.requests[0].body.expected_revision, 7);
  assert.equal(editor.field('saveBtn').disabled, true);
  editor.field('name').value = 'Newer local name'; editor.field('media').value = 'Newer media draft'; editor.dirty();
  assert.equal(editor.field('saveBtn').disabled, true, 'Typing must not unlock a second save');
  gate.resolve(); assert.equal(await saving, true);
  assert.equal(editor.field('name').value, 'Newer local name');
  assert.equal(editor.field('media').value, 'Newer media draft');
  assert.equal(editor.context.formDirty, true);
  assert.equal(editor.context.editingRevision, 8, 'A later list refresh must not rebase the editor to revision 99');
  assert.equal(editor.context.adminEditingBaseline.name, 'Original name');
  assert.equal(JSON.parse(editor.context.adminEditingBaseline.profile_modules).media, 'Submitted media');
  assert.equal(editor.moduleRenders.length, 0, 'A response must not rebuild specialized fields');
  assert.equal(editor.field('saveBtn').disabled, false);
  assert.match(editor.field('msg').textContent, /Newer edits are still unsaved/);
});

test('duplicate create clicks send one POST and unchanged successful drafts become saved', async () => {
  const gate = defer(), editor = await saveHarness({ create: true, saveGate: gate });
  const saving = editor.save();
  assert.equal(await editor.save(), false);
  assert.equal(editor.requests.length, 1); assert.equal(editor.requests[0].method, 'POST');
  assert.equal(editor.requests[0].body.expected_revision, undefined);
  gate.resolve(); await saving;
  assert.equal(editor.context.editingId, 'client-1'); assert.equal(editor.context.formDirty, false);
  assert.equal(editor.field('saveBtn').disabled, true);
});

test('uploads use the submitted image snapshot and preserve replacement photos/files', async () => {
  const gate = defer(), editor = await saveHarness({ uploadGate: gate });
  const firstPhoto = { name: 'first-photo.webp' }, nextPhoto = { name: 'new-photo.webp' };
  const firstFeatured = { name: 'first-featured.webp' }, nextFeatured = { name: 'new-featured.webp' };
  editor.context.profilePhotoBlob = firstPhoto;
  editor.field('featured_image_file').files = [firstFeatured];
  const saving = editor.save();
  editor.context.profilePhotoBlob = nextPhoto; editor.field('featured_image_file').files = [nextFeatured]; editor.dirty();
  gate.resolve(); await saving;
  assert.deepEqual(editor.uploads, [firstPhoto, firstFeatured]);
  assert.equal(editor.requests[0].body.photo_key, 'https://example.test/first-photo.webp');
  assert.equal(editor.requests[0].body.featured_image, 'https://example.test/first-featured.webp');
  assert.equal(editor.context.profilePhotoBlob, nextPhoto);
  assert.equal(editor.field('featured_image_file').files[0], nextFeatured);
  assert.equal(editor.context.formDirty, true);
});

test('stale-profile conflicts retain drafts/revision, show reload and unlock Save', async () => {
  const editor = await saveHarness({ responseStatus: 409, responseBody: { code: 'PROFILE_CHANGED', error: 'Changed' } });
  editor.field('name').value = 'Kept draft';
  assert.equal(await editor.save(), false);
  assert.equal(editor.field('name').value, 'Kept draft'); assert.equal(editor.context.editingRevision, 7);
  assert.equal(editor.context.formDirty, true); assert.equal(editor.context.savingClient, false);
  assert.equal(editor.field('saveBtn').disabled, false); assert.equal(editor.conflicts.at(-1), true);
  assert.match(editor.field('msg').textContent, /draft is kept/);
});

test('ordinary validation conflicts retain their actual message and do not offer stale reload', async () => {
  const editor = await saveHarness({ responseStatus: 409, responseBody: { error: 'Email is already assigned to another client' } });
  assert.equal(await editor.save(), false);
  assert.equal(editor.field('msg').textContent, 'Email is already assigned to another client');
  assert.equal(editor.conflicts.includes(true), false); assert.equal(editor.context.formDirty, true);
});

test('network failures keep the draft and release the in-flight lock', async () => {
  const gate = defer(), editor = await saveHarness({ saveGate: gate });
  const saving = editor.save(); gate.reject(Error('Network unavailable'));
  assert.equal(await saving, false);
  assert.equal(editor.field('msg').textContent, 'Network unavailable');
  assert.equal(editor.context.savingClient, false); assert.equal(editor.context.formDirty, true);
  assert.equal(editor.field('saveBtn').disabled, false);
});

test('client switches respect canceled dirty confirmation and in-flight saves', async () => {
  for (const saving of [false, true]) {
    let confirmations = 0;
    const context = vm.createContext({ editingId: 'current', savingClient: saving, formDirty: true,
      window: { clients: [{ id: 'other', name: 'Other' }] },
      $: () => ({ textContent: '' }), confirm: () => { confirmations++; return false; } });
    vm.runInContext(leaveSource + '\n' + editSource, context);
    assert.equal(await context.window.editClient('other'), false);
    assert.equal(context.editingId, 'current'); assert.equal(confirmations, saving ? 0 : 1);
  }
});

test('canceled client switches do not change sections or public preview', async () => {
  const calls = [];
  const context = vm.createContext({ window: { editClient: async () => false, clients: [{ id: 'other', slug: 'other' }] },
    showProfilePreview: () => calls.push('preview'), setAdminSection: () => calls.push('section') });
  vm.runInContext(wrapperSource, context);
  assert.equal(await context.window.editClient('other'), false); assert.deepEqual(calls, []);
});

test('preview remains closed when an edited or saved profile is selected', () => {
  const context = vm.createContext({ previewOpen: false, previewSlug: '', previewFrame: { style: {} }, previewEmpty: { style: {} }, setPreviewOpen() { throw Error('Preview opened automatically'); } });
  vm.runInContext(between('function showProfilePreview(slug){', 'const originalEditClient ='), context);
  vm.runInContext('showProfilePreview("sample-profile")', context);
  assert.equal(context.previewSlug, 'sample-profile'); assert.equal(context.previewFrame.src, undefined);
});

test('Weekdays preset enables Monday through Friday only', () => {
  const fields = new Map(), field = id => { if (!fields.has(id)) fields.set(id, { value: '', checked: false, disabled: false }); return fields.get(id); };
  const context = vm.createContext({ $: field, setDirty() {} });
  vm.runInContext(between('const HOURS_DAYS', 'const PROFILE_TYPES'), context);
  vm.runInContext('setQuickHours("weekdays")', context);
  assert.deepEqual(JSON.parse(vm.runInContext('serializeBusinessHours()', context)).filter(row => row.enabled).map(row => row.day), [1, 2, 3, 4, 5]);
});

test('structured services keep surviving row metadata after removing the first row', () => {
  const row = (name, extra) => ({ _nextapOriginal: extra, querySelector: selector => ({ value: selector.includes('=name') ? name : '' }) });
  const rows = [row('First', { id: 'first', image: 'first.webp' }), row('Second edited', { id: 'second', image: 'second.webp', custom: { preserved: true } })];
  rows.shift();
  const target = {}, context = vm.createContext({ $: id => id === 'services' ? target : { querySelectorAll: () => rows } });
  vm.runInContext(between('function syncAdminServicesEditor(){', 'function renderAdminPortfolioEditor('), context);
  const saved = JSON.parse(vm.runInContext('syncAdminServicesEditor()', context));
  assert.equal(saved[0].id, 'second'); assert.equal(saved[0].image, 'second.webp');
  assert.equal(saved[0].name, 'Second edited'); assert.equal(saved[0].custom.preserved, true);
});

test('repeatable line edits preserve metadata from their own surviving row and allow clearing price', async () => {
  const { mergeLineItem } = await helpers;
  const original = { id: 'second', name: 'Second', price: '99', image: 'second.webp', link: 'https://example.test/second' };
  assert.deepEqual(mergeLineItem('products', 'Second edited · 149', original), { ...original, name: 'Second edited', price: '149' });
  assert.equal(mergeLineItem('products', 'Second edited', original).price, '');
  const education = { school: 'Original school', degree: 'BS', year: '2020' };
  assert.deepEqual(mergeLineItem('education', 'Updated school', education), { ...education, school: 'Updated school' });
  assert.equal(original.name, 'Second', 'Original record must not be mutated');
});

test('optional details preserve unknown properties, clear known fields and survive a saved baseline rebase', async () => {
  const { mergeRowDraft, ROW_DETAIL_FIELDS } = await helpers;
  const original = { school: 'School', degree: 'BS', course: 'Computing', year: 2020, privateMetadata: { original: true } };
  const same = mergeRowDraft('education', 'School', original, { degree: 'BS', course: 'Computing', year: '2020', date: '', link: '' }, 'School');
  assert.equal(same, original, 'An untouched structured item preserves its exact original types');
  const submitted = mergeRowDraft('education', 'School', original, { degree: 'MS', course: '', year: '2020', date: '', link: '' }, 'School');
  assert.equal(submitted.degree, 'MS'); assert.equal(submitted.course, '');
  const pending = mergeRowDraft('education', 'School', submitted, { degree: 'Newer PhD draft', course: '', year: '2020', date: '', link: '' }, 'School');
  assert.equal(pending.degree, 'Newer PhD draft'); assert.deepEqual(pending.privateMetadata, { original: true });
  assert.equal(ROW_DETAIL_FIELDS.education.some(([key]) => key === 'degree'), true);
  assert.equal(ROW_DETAIL_FIELDS.certifications.some(([key]) => key === 'issuer'), true);
  assert.equal(ROW_DETAIL_FIELDS.skills.some(([key]) => key === 'level'), true);
});

test('actual repeatable serializer keeps row identity after removal and advanced drafts after a response', async () => {
  const { mergeRowDraft } = await helpers;
  const row = original => ({ _nextapOriginal: original, isConnected: true,
    main: { value: original.school }, degree: { dataset: { adminRowProperty: 'degree' }, value: original.degree },
    querySelector() { return this.main; }, querySelectorAll() { return [this.degree]; } });
  const first = { id: 'first', school: 'First school', degree: 'BS', link: 'https://example.test/first' };
  const second = { id: 'second', school: 'Second school', degree: 'MS', link: 'https://example.test/second', extra: { keep: true } };
  const list = { children: [row(first), row(second)] }; list.children.shift();
  const source = read('public/admin/editor.js');
  const serialize = source.slice(source.indexOf('  function serializeRows('), source.indexOf('  function captureRows('));
  const accept = source.slice(source.indexOf('  function acceptRows('), source.indexOf('  function draftRecord('));
  const context = vm.createContext({ builders: new Map([['education', { list }]]), mergeRowDraft,
    adminOriginalContent: { education: JSON.stringify([first, second]) }, adminEditingBaseline: {},
    copyOriginal: value => value && typeof value === 'object' ? { ...value } : value });
  vm.runInContext(between('function parseAdminStructured(', 'function renderAdminServicesEditor(') + '\n' + serialize + '\n' + accept, context);
  list.children[0].degree.value = 'Submitted PhD';
  const submitted = vm.runInContext('serializeRows("education")', context);
  assert.deepEqual(JSON.parse(submitted), [{ ...second, degree: 'Submitted PhD' }]);
  list.children[0].degree.value = 'Newer advanced draft';
  context.captures = [{ field: 'education', rows: list.children }]; context.saved = { education: submitted };
  vm.runInContext('acceptRows(captures,saved)', context);
  const newer = JSON.parse(vm.runInContext('serializeRows("education")', context));
  assert.equal(newer[0].degree, 'Newer advanced draft'); assert.equal(newer[0].id, 'second');
  assert.deepEqual(newer[0].extra, { keep: true }); assert.equal(newer[0].link, second.link);
});

test('new-client reset clears stale booking and business-location editors and the saved revision', () => {
  const fields = new Map(), field = id => { if (!fields.has(id)) fields.set(id, { value: 'old value', checked: true }); return fields.get(id); };
  const calls = [], context = vm.createContext({ $: field, editingId: 'old-client', editingSlug: 'old', editingRevision: 7,
    adminEditingBaseline: { id: 'old-client' }, profilePhotoBlob: {}, profilePhotoSourceUrl: 'old-photo',
    nxCropClose() {}, releaseAdminPhotoPreview() {}, renderAdminPhotoPreview() {}, resetBusinessHoursEditor() {},
    updateQuickInfoPreviews() {}, updateCardTypeAccess() {},
    renderBusinessLocationsAdmin: value => calls.push(['locations', value]), renderAdminBookingEditor: value => calls.push(['booking', value]),
    window: { NextapAdminEditor: { setConflict() {} }, nxRefreshContentBuilders() {} } });
  vm.runInContext(between('function clearForm(){', '// ===============================\n// ADMIN LOGIN'), context);
  vm.runInContext('clearForm()', context);
  assert.equal(context.editingRevision, null); assert.equal(context.adminEditingBaseline, null);
  assert.equal(context.profilePhotoBlob, null); assert.equal(field('booking').value, '');
  assert.deepEqual(calls, [['locations', '[]'], ['booking', '']]);
});

function hoursHarness() {
  const fields = new Map();
  const field = id => { if (!fields.has(id)) fields.set(id, { id, value: '', checked: false, disabled: false, hidden: false, textContent: '', matches: () => /^hours_[a-z]+_(enabled|open|close)$/.test(id) }); return fields.get(id); };
  const context = vm.createContext({ $: field, setDirty() {} });
  vm.runInContext(between('const HOURS_DAYS', 'const PROFILE_TYPES') + '\n' + html.match(/function touchAdminBusinessHours\(target\)\{[\s\S]*?\n\}/)[0], context);
  return { field, context,
    load: raw => { context.rawHours = raw; vm.runInContext('loadBusinessHoursEditor(rawHours)', context); },
    serialize: () => vm.runInContext('serializeBusinessHours()', context),
    touch: id => { context.target = field(id); vm.runInContext('touchAdminBusinessHours(target)', context); } };
}

test('legacy Mon–Fri hours display weekdays only and retain exact raw text until edited', () => {
  const editor = hoursHarness(), raw = 'Mon-Fri — 9:00 AM - 6:00 PM'; editor.load(raw);
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
    assert.equal(editor.field('hours_' + day + '_enabled').checked, true);
    assert.equal(editor.field('hours_' + day + '_open').value, '09:00');
    assert.equal(editor.field('hours_' + day + '_close').value, '18:00');
  }
  assert.equal(editor.field('hours_saturday_enabled').checked, false);
  assert.equal(editor.field('hours_sunday_enabled').checked, false);
  assert.equal(editor.serialize(), raw);
});

test('named-day wrapper objects and sparse arrays display the supplied days instead of default weekdays', () => {
  for (const raw of [
    JSON.stringify({ hours: { monday: '9:00 AM-6:00 PM', saturday: 'Closed' } }),
    JSON.stringify([{ day: 1, enabled: true, open: 540, close: 1080 }, { day: 'saturday', enabled: false }])
  ]) {
    const editor = hoursHarness(); editor.load(raw);
    assert.equal(editor.field('hours_monday_enabled').checked, true);
    assert.equal(editor.field('hours_tuesday_enabled').checked, false);
    assert.equal(editor.field('hours_saturday_enabled').checked, false);
    assert.equal(editor.serialize(), raw);
  }
});

test('split hours warn before conversion and preserve untouched days and unknown metadata', () => {
  const editor = hoursHarness();
  const split = { day: 1, enabled: true, note: 'Keep this note', periods: [{ open: 540, close: 720 }, { open: 780, close: 1080 }] };
  const raw = JSON.stringify([split, { day: 2, enabled: true, open: 600, close: 1080 }]); editor.load(raw);
  assert.equal(editor.field('adminHoursWarning').hidden, false); assert.equal(editor.serialize(), raw);
  editor.field('hours_tuesday_close').value = '19:00'; editor.touch('hours_tuesday_close');
  let rows = JSON.parse(editor.serialize()); assert.deepEqual(rows.find(row => row.day === 1), split);
  editor.field('hours_monday_close').value = '17:00'; editor.touch('hours_monday_close');
  rows = JSON.parse(editor.serialize()); const monday = rows.find(row => row.day === 1);
  assert.equal(monday.note, 'Keep this note'); assert.equal(monday.periods, undefined); assert.equal(monday.close, 1020);
});

test('24-hour presets and saved full days are understood by the actual public parser', () => {
  const profile = read('public/profile.html');
  const from = profile.indexOf('function parseTimePart('), to = profile.indexOf('function todayHours(', from);
  assert.ok(from >= 0 && to > from);
  const publicContext = vm.createContext({}); vm.runInContext(profile.slice(from, to), publicContext);
  const editor = hoursHarness(); vm.runInContext('setQuickHours("247")', editor.context);
  const raw = editor.serialize(); publicContext.raw = raw;
  const parsed = vm.runInContext('parseHoursText(raw)', publicContext);
  assert.equal(parsed.length, 7); assert.equal(parsed.every(day => day.enabled && day.mode === '24h'), true);
  editor.load(raw); assert.equal(editor.serialize(), raw);
  assert.equal(editor.field('hours_monday_enabled').checked, true); assert.equal(editor.field('adminHoursWarning').hidden, false);
});

test('invalid links in optional details stop a save and reveal the invalid input', async () => {
  const editor = await saveHarness(); let focused = false, reported = false;
  const details = { open: false }, module = { classList: { remove() {} } };
  const input = { value: 'bad link', disabled: false, checkValidity: () => false,
    closest: selector => selector === 'details' ? details : selector === '.module' ? module : null,
    focus: () => { focused = true; }, reportValidity: () => { reported = true; } };
  editor.context.document.querySelectorAll = () => [input];
  assert.equal(await editor.save(), false); assert.equal(editor.requests.length, 0);
  assert.equal(details.open, true); assert.equal(focused, true); assert.equal(reported, true);
  assert.equal(editor.context.formDirty, true);
});

test('profile-only changes save with untouched legacy links in hidden Content', async () => {
  const editor = await saveHarness(), sections = [];
  const links = ['www.example.test/book', 'Legacy instructions', 'example.test/certificate'].map(value => ({
    value, disabled: false, checkValidity: () => false,
    focus() { throw Error('Unchanged Content must not receive focus'); }
  }));
  editor.context.document.querySelectorAll = selector => selector === '.editor input[type="url"]' ? links : [];
  editor.context.setAdminSection = section => sections.push(section);
  editor.context.activeAdminSection = 'profile';
  vm.runInContext('rememberAdminLinks()', editor.context);
  editor.field('name').value = 'Changed profile name';
  editor.field('products').value = JSON.stringify([{ name: 'Saved product', link: links[0].value }]);
  assert.equal(await editor.save(), true);
  assert.equal(editor.requests.length, 1);
  assert.equal(editor.requests[0].body.name, 'Changed profile name');
  assert.equal(JSON.parse(editor.requests[0].body.products)[0].link, 'www.example.test/book');
  assert.deepEqual(sections, ['profile']);
  assert.equal(editor.context.savingClient, false);
});

test('changing a saved legacy link still blocks malformed content and reveals its actual section', async () => {
  const editor = await saveHarness(), sections = [];
  let focused = false, reported = false;
  const details = { open: false }, module = { classList: { remove() {} } };
  const input = { value: 'www.example.test/saved', disabled: false, checkValidity: () => false,
    closest: selector => selector === '[data-admin-section]' ? { dataset: { adminSection: 'quickinfo' } }
      : selector === 'details' ? details : selector === '.module' ? module : null,
    focus: () => { focused = true; }, reportValidity: () => { reported = true; } };
  editor.context.document.querySelectorAll = () => [input];
  editor.context.setAdminSection = section => sections.push(section);
  vm.runInContext('rememberAdminLinks()', editor.context);
  input.value = 'a newly malformed link';
  assert.equal(await editor.save(), false);
  assert.equal(editor.requests.length, 0); assert.deepEqual(sections, ['quickinfo']);
  assert.equal(details.open, true); assert.equal(focused && reported, true);
  assert.equal(editor.context.formDirty, true);
});

test('a malformed service link entered after a successful Profile save blocks the next save', async () => {
  const editor = await saveHarness(); let focused = false;
  const input = { value: '', disabled: false, checkValidity() { return /^https?:\/\//.test(this.value); },
    closest: selector => selector === '[data-admin-section]' ? { dataset: { adminSection: 'quickinfo' } } : null,
    focus() { focused = true; }, reportValidity() {} };
  editor.context.document.querySelectorAll = selector => selector === '.editor input[type="url"]' ? [input] : [];
  vm.runInContext('rememberAdminLinks()', editor.context);
  editor.field('name').value = 'Updated name'; assert.equal(await editor.save(), true);
  input.value = 'new-invalid-link'; editor.dirty();
  assert.equal(await editor.save(), false); assert.equal(editor.requests.length, 1);
  assert.equal(focused, true); assert.equal(editor.context.formDirty, true);
  assert.match(editor.field('msg').textContent, /complete valid link/);
});

test('successful URL baselines use the submitted value rather than newer edits during a save', async () => {
  const gate = defer(), editor = await saveHarness({ saveGate: gate });
  let focused = false;
  const input = { value: 'https://example.test/saved', disabled: false,
    checkValidity() { return this.value.startsWith('https://'); }, closest: () => null,
    focus() { focused = true; }, reportValidity() {} };
  editor.context.document.querySelectorAll = selector => selector === '.editor input[type="url"]' ? [input] : [];
  vm.runInContext('rememberAdminLinks()', editor.context);
  input.value = 'https://example.test/submitted';
  const saving = editor.save();
  input.value = 'new malformed draft'; editor.dirty();
  gate.resolve(); assert.equal(await saving, true);
  assert.equal(input.value, 'new malformed draft'); assert.equal(editor.context.formDirty, true);
  assert.equal(await editor.save(), false);
  assert.equal(editor.requests.length, 1); assert.equal(focused, true);
});

test('opening a saved client captures legacy Content links before profile-only editing', async () => {
  const editor = await saveHarness();
  let links = [];
  const saved = editor.context.window.clients[0];
  saved.booking = JSON.stringify([{ title: 'Legacy booking', link: 'www.example.test/book' }]);
  editor.context.formDirty = false;
  Object.assign(editor.context, {
    confirmLeaveEditor: () => true, nxCropClose() {}, setProfileType() {},
    LEGACY_CARD_TYPES: new Set(['basic', 'premium', 'elite', 'gold']),
    adminStructuredDisplay: (_key, value) => value,
    renderBusinessLocationsAdmin() {}, loadBusinessHoursEditor() {},
    renderAdminServicesEditor() {}, renderAdminPortfolioEditor() {}, renderAdminReviewsEditor() {},
    renderAdminBookingEditor(value) {
      links = JSON.parse(value).map(item => ({ value: item.link, disabled: false, checkValidity: () => false,
        focus() { throw Error('Untouched saved link received focus'); } }));
    },
    syncAdminBookingEditor: () => editor.field('booking').value,
    updateQuickInfoPreviews() {}, updateCardTypeAccess() {}
  });
  editor.context.document.getElementById = () => null;
  editor.context.document.querySelectorAll = selector => selector === '.editor input[type="url"]' ? links : [];
  editor.context.window.scrollTo = () => {};
  vm.runInContext(editSource, editor.context);
  assert.equal(await editor.context.window.editClient(saved.id), true);
  editor.field('name').value = 'Profile-only update'; editor.dirty();
  assert.equal(await editor.save(), true); assert.equal(editor.requests.length, 1);
  assert.equal(editor.requests[0].body.booking, saved.booking);
});

function locationDraftHarness(items) {
  const input = value => ({ value, disabled: false, checkValidity: () => false, focus() {} });
  const row = item => ({ link: input(item.link), name: input(item.name),
    querySelector(selector) { return selector.includes('-link]') ? this.link : this.name; } });
  let rows = items.map(row), handler;
  const message = { className: '', textContent: '' };
  const context = vm.createContext({
    savingClient: false, $: () => message,
    document: {
      querySelectorAll: selector => selector === '.editor input[type="url"]' ? rows.map(row => row.link) : rows,
      addEventListener: (_event, callback) => { handler = callback; }
    },
    renderBusinessLocationsAdmin: items => { rows = items.map(row); },
    setDirty() {}, updateBusinessLocationAdminPreview() {}
  });
  vm.runInContext(linkSource + '\n' + between('function getBusinessLocationsAdmin(){', 'function renderBusinessLocationsAdmin('), context);
  vm.runInContext('rememberAdminLinks()', context);
  vm.runInContext(between('document.addEventListener("click",e=>{\n  const addBtn=e.target.closest("#addBusinessLocationAdmin")', 'const dirtyFieldIds ='), context);
  return { context, message, get rows() { return rows; },
    add: () => handler({ target: { closest: selector => selector === '#addBusinessLocationAdmin' ? {} : null }, preventDefault() {} }),
    invalid: () => vm.runInContext('invalidEditedAdminLink(snapshotAdminLinks())', context) };
}

test('adding a business-location row retains validation baselines for rebuilt existing inputs', () => {
  for (const changed of [false, true]) {
    const editor = locationDraftHarness([{ name: 'Location', link: 'www.example.test/saved' }]);
    if (changed) editor.rows[0].link.value = 'new malformed value';
    editor.add(); assert.equal(editor.rows.length, 2);
    assert.equal(editor.invalid(), changed ? editor.rows[0].link : undefined);
  }
});

test('clearing an earlier location preserves the surviving legacy link baseline when adding a row', () => {
  for (const changed of [false, true]) {
    const editor = locationDraftHarness([
      { name: 'First location', link: 'https://example.test/first' },
      { name: 'Second location', link: 'www.example.test/second' }
    ]);
    editor.rows[0].name.value = '  '; editor.rows[0].link.value = '  ';
    if (changed) editor.rows[1].link.value = 'new malformed value';
    editor.add(); assert.equal(editor.rows.length, 2);
    assert.equal(editor.rows[0].name.value, 'Second location');
    assert.equal(editor.invalid(), changed ? editor.rows[0].link : undefined);
  }
});

test('adding a location during a pending save keeps submitted nodes and rebases their saved links correctly', () => {
  const editor = locationDraftHarness([{ name: 'Location', link: 'www.example.test/legacy' }]);
  const originalRows = editor.rows, originalInput = editor.rows[0].link;
  originalInput.value = 'https://example.test/submitted';
  vm.runInContext('const submittedLinks=snapshotAdminLinks();savingClient=true;', editor.context);
  editor.add();
  assert.equal(editor.rows, originalRows); assert.equal(editor.rows[0].link, originalInput);
  assert.equal(editor.rows.length, 1); assert.match(editor.message.textContent, /Wait before adding a location/);
  editor.rows[0].name.value = 'Newer name draft';
  vm.runInContext('rememberAdminLinks(submittedLinks);savingClient=false;', editor.context);
  assert.equal(editor.rows[0].name.value, 'Newer name draft');
  originalInput.value = 'www.example.test/legacy';
  assert.equal(editor.invalid(), originalInput, 'The former legacy value is now an edited malformed link');
});

test('section status agrees with publishing rules, including globally disabled content and incomplete CTA', async () => {
  const { sectionState } = await helpers;
  assert.equal(sectionState({ services: 'Design', show_services: true }, 'services'), 'published');
  assert.equal(sectionState({ services: 'Design', show_services: true, quick_info_enabled: false }, 'services'), 'hidden');
  assert.equal(sectionState({ services: '[]', show_services: true }, 'services'), 'empty');
  assert.equal(sectionState({ featured_enabled: true, featured_button_text: 'Book' }, 'featured'), 'empty');
  assert.equal(sectionState({ featured_enabled: true, featured_button_text: 'Book', featured_button_link: 'https://example.test' }, 'featured'), 'published');
  assert.equal(sectionState({ profile_modules: { media: 'Video' }, profile_module_visibility: { media: false } }, 'media'), 'hidden');
});

test('all original admin inline styles remain byte-identical and all inline scripts parse', () => {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]);
  assert.equal(styles.length, 6);
  assert.equal(createHash('sha256').update(JSON.stringify(styles)).digest('hex'), '03943676886c1bf7815911ddce2f1d9c2c950e64084dea957c7f6dc25403b84e');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});
