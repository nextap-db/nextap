import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: worker } = await import(pathToFileURL(join(root, 'src', 'index.js')).href);
const migrationNames = (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
const migrationSources = await Promise.all(migrationNames.map(name => readFile(join(root, 'migrations', name), 'utf8')));

// These are the approved product sections, rather than an expectation derived
// from the implementation under test. A child row never creates another slot.
const quickKeys = [
  'business_location', 'business_hours', 'services', 'portfolio', 'booking',
  'reviews', 'payments', 'education', 'skills', 'resume', 'achievements',
  'certifications', 'pricing', 'products', 'promotions', 'team', 'business_inquiry'
];
const specialKeys = [
  'media', 'games', 'streaming', 'discord', 'tournament_history',
  'gallery', 'interests', 'custom_links', 'collaborations'
];
const allKeys = [...quickKeys, ...specialKeys, 'featured'];
const clientPassword = 'synthetic-content-password';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (let i = 0; i < migrationNames.length; i++) {
    assert.doesNotThrow(() => sqlite.exec(migrationSources[i]), `Fresh migration failed: ${migrationNames[i]}`);
  }
  t.after(() => sqlite.close());
  const context = { sqlite, nextId: 0, adminCookie: null, readGate: null, pausedRead: null };
  context.env = {
    ADMIN_PASSWORD: 'synthetic-content-admin', CLIENT_AUTH_SECRET: 'synthetic-content-session',
    ASSETS: { async fetch() { return new Response('<html>synthetic asset</html>'); } },
    DB: {
      prepare(sql) {
        const prepared = sqlite.prepare(sql);
        let parameters = [];
        const statement = {
          bind(...values) { parameters = values; return statement; },
          async first(column) {
            const row = prepared.get(...parameters);
            if (!row) return null;
            const result = { ...row };
            // A one-use test gate lets two real authenticated requests read the
            // same old row before either writes, without mocking route results.
            const gate = context.readGate;
            if (gate && result.id === gate.id && 'card_type' in result) {
              gate.arrived++;
              if (gate.arrived === 2) { context.readGate = null; gate.release(); }
              await gate.ready;
            }
            const paused = context.pausedRead;
            if (paused && result.id === paused.id && 'card_type' in result) {
              context.pausedRead = null;
              paused.announce();
              await paused.ready;
            }
            return column ? result[column] : result;
          },
          async all() { return { success: true, results: prepared.all(...parameters).map(row => ({ ...row })) }; },
          async run() {
            const result = prepared.run(...parameters);
            return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          }
        };
        return statement;
      }
    }
  };
  return context;
}

async function call(context, path, { method = 'GET', body, cookie } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  let requestBody;
  if (body instanceof FormData) requestBody = body;
  else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`https://content-plan.test${path}`, { method, headers, body: requestBody }), context.env);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
}

async function adminCookie(context) {
  if (context.adminCookie) return context.adminCookie;
  const result = await call(context, '/api/auth/login', { method: 'POST', body: { password: context.env.ADMIN_PASSWORD } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie?.startsWith('nextap_admin='));
  context.adminCookie = result.cookie;
  return result.cookie;
}

function contentFor(keys) {
  const body = {};
  const modules = {};
  for (const key of keys) {
    if (key === 'business_location') {
      body.business_location_name = 'Synthetic main office';
      body.business_location_link = 'https://example.test/map';
      body.business_locations = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ name: `Branch ${i}`, link: `https://example.test/branch/${i}` })));
    } else if (key === 'business_hours') {
      body.business_hours = JSON.stringify(Array.from({ length: 7 }, (_, day) => ({ day, enabled: true, open: '09:00', close: '17:00' })));
    } else if (key === 'featured') {
      Object.assign(body, {
        featured_enabled: true, featured_title: 'Synthetic featured content', featured_description: 'A complete featured section',
        featured_button_text: 'Read more', featured_button_link: 'https://example.test/featured'
      });
    } else if (specialKeys.includes(key)) {
      // Dashboards keep each specialized textarea's structured rows as JSON
      // text inside the enclosing profile_modules object.
      modules[key] = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `${key} entry ${i}`, url: `https://example.test/${key}/${i}` })));
    } else {
      body[key] = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `${key} entry ${i}`, description: `Saved ${key} description ${i}` })));
    }
  }
  if (Object.keys(modules).length) body.profile_modules = JSON.stringify(modules);
  return body;
}

function payload(context, overrides = {}) {
  const id = `content-client-${++context.nextId}`;
  return {
    id, slug: id, name: 'Synthetic Content Client', email: `${id}@example.test`, phone: '09171234567',
    card_type: 'basic', client_login_password: clientPassword, ...overrides
  };
}

async function createClient(context, overrides = {}) {
  const body = payload(context, overrides);
  const result = await call(context, '/api/clients', { method: 'POST', cookie: await adminCookie(context), body });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return { body, data: result.data };
}

async function ownerCookie(context, client) {
  const result = await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: client.body.email, password: clientPassword } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie?.startsWith('nextap_client='));
  return result.cookie;
}

function row(context, id) {
  const result = context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return result ? { ...result } : null;
}

function assertUsage(data, { plan = 'basic', limit = 3, keys = [] } = {}) {
  assert.deepEqual(data.content_plan, {
    plan, label: { basic: 'Basic', premium: 'Premium', elite: 'Elite' }[plan], limit,
    used: keys.length, keys: data.content_plan?.keys, over_limit: limit !== null && keys.length > limit,
    remaining: limit === null ? null : Math.max(0, limit - keys.length)
  });
  assert.deepEqual([...data.content_plan.keys].sort(), [...keys].sort());
  assert.equal(new Set(data.content_plan.keys).size, keys.length, 'A section consumes only one slot');
}

function assertLimitError(result, options) {
  assert.equal(result.status, 400, JSON.stringify(result.data));
  assert.equal(result.data.code, 'CONTENT_BLOCK_LIMIT');
  assert.equal(typeof result.data.error, 'string');
  assertUsage(result.data, options);
}

function photoForm() {
  const bytes = new Uint8Array(64).fill(0x41);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const body = new FormData();
  body.set('photo', new File([bytes], 'synthetic.jpg', { type: 'image/jpeg' }));
  return body;
}

// Deliberately model an already-live row imported from before enforcement. New
// API writes never get this bypass, and the credentials remain real/test-only.
async function legacyClient(context, cardType, keys, overrides = {}) {
  const client = await createClient(context, { card_type: 'gold', ...contentFor(keys), ...overrides });
  context.sqlite.prepare('UPDATE clients SET card_type = ? WHERE id = ?').run(cardType, client.body.id);
  client.body.card_type = cardType;
  return client;
}

test('admin creation enforces Basic 3/4 and Premium 6/7 boundaries before inserting any profile', async t => {
  const context = fixture(t);
  for (const [cardType, plan, limit] of [['basic', 'basic', 3], ['premium', 'premium', 6]]) {
    const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments', 'education'].slice(0, limit);
    const accepted = await createClient(context, { card_type: cardType, ...contentFor(keys) });
    assertUsage(accepted.data, { plan, limit, keys });
    const publicProfile = await call(context, `/api/clients/${accepted.body.id}`);
    assert.equal(publicProfile.status, 200);
    assertUsage(publicProfile.data, { plan, limit, keys });

    const attemptedKeys = [...keys, 'skills'];
    const body = payload(context, { card_type: cardType, ...contentFor(attemptedKeys), content_plan: { used: 0, limit: null } });
    const before = context.sqlite.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
    const denied = await call(context, '/api/clients', { method: 'POST', cookie: await adminCookie(context), body });
    assertLimitError(denied, { plan, limit, keys: attemptedKeys });
    assert.equal(row(context, body.id), null);
    assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS n FROM clients').get().n, before);
  }
});

test('Elite and its stored gold alias publish all 27 approved sections without a finite cap', async t => {
  const context = fixture(t);
  for (const cardType of ['gold', 'elite']) {
    const client = await createClient(context, { card_type: cardType, ...contentFor(allKeys) });
    assert.equal(client.data.card_type, 'gold', 'Elite retains the existing stored gold plan contract');
    assertUsage(client.data, { plan: 'elite', limit: null, keys: allKeys });
    const publicProfile = await call(context, `/api/clients/${client.body.id}`);
    assertUsage(publicProfile.data, { plan: 'elite', limit: null, keys: allKeys });
    assert.equal(Object.keys(JSON.parse(publicProfile.data.profile_modules)).length, 9);
  }
});

test('each of the 17 Quick sections and 9 specialized sections consumes one slot regardless of child rows', async t => {
  const context = fixture(t);
  for (const key of [...quickKeys, ...specialKeys]) {
    const client = await createClient(context, contentFor([key]));
    assertUsage(client.data, { keys: [key] });
    const publicProfile = await call(context, `/api/clients/${client.body.id}`);
    assertUsage(publicProfile.data, { keys: [key] });
    const hidden = quickKeys.includes(key)
      ? { ['show_' + key]: false }
      : { profile_module_visibility: { [key]: false } };
    const draft = await createClient(context, { ...contentFor([key]), ...hidden });
    assertUsage(draft.data, { keys: [] });
  }
});

test('identity, contact, social links and the location header remain free at the Basic boundary', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking'];
  const free = {
    name: 'Synthetic identity', job_title: 'Designer', company: 'Synthetic company', about: 'Identity biography',
    phone: '09171234567', messenger: 'https://example.test/messenger', whatsapp: '09171234567', viber: '09171234567',
    instagram: 'https://example.test/instagram', facebook: 'https://example.test/facebook', linkedin: 'https://example.test/linkedin',
    tiktok: 'https://example.test/tiktok', youtube: 'https://example.test/youtube', x: 'https://example.test/x',
    telegram: 'https://example.test/telegram', threads: 'https://example.test/threads', github: 'https://example.test/github',
    behance: 'https://example.test/behance', dribbble: 'https://example.test/dribbble', twitch: 'https://example.test/twitch',
    steam: 'https://example.test/steam', website: 'https://example.test', location: 'Manila, Philippines', show_location: true
  };
  const client = await createClient(context, { ...contentFor(keys), ...free });
  assertUsage(client.data, { keys });
  const saved = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, client), body: { ...free, about: 'Updated free biography', location: 'Cebu, Philippines' }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assertUsage(saved.data, { keys });
  assert.equal(saved.data.location, 'Cebu, Philippines');
  assert.equal(saved.data.services, client.body.services);
});

test('empty JSON collections and whitespace do not consume sections or prevent a valid save', async t => {
  const context = fixture(t);
  const empty = {};
  for (const [i, key] of quickKeys.entries()) {
    if (key !== 'business_location') empty[key] = ['[]', '{}', '   '][i % 3];
  }
  Object.assign(empty, {
    business_locations: '[]', business_location_name: ' ', business_location_link: '',
    profile_modules: JSON.stringify(Object.fromEntries(specialKeys.map((key, i) => [key, i % 2 ? {} : []]))),
    featured_enabled: true, featured_title: ' ', featured_description: '', featured_button_text: 'CTA without a destination'
  });
  const client = await createClient(context, empty);
  assertUsage(client.data, { keys: [] });
  assert.equal(client.data.profile_modules, empty.profile_modules, 'Empty structures are retained, not deleted');
  const result = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, client), body: { services: 'Published service', profile_modules: JSON.stringify({ media: [], games: {} }) }
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assertUsage(result.data, { keys: ['services'] });
  assert.deepEqual(JSON.parse(result.data.profile_modules), { media: [], games: {} });
});

test('literal null and false strings remain meaningful published text and cannot bypass the Basic cap', async t => {
  const context = fixture(t);
  const client = await createClient(context, {
    services: 'null', portfolio: 'false', profile_modules: JSON.stringify({ games: 'false' })
  });
  const keys = ['services', 'portfolio', 'games'];
  assertUsage(client.data, { keys });
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assertUsage(publicProfile.data, { keys });
  assert.equal(publicProfile.data.services, 'null');
  assert.equal(publicProfile.data.portfolio, 'false');
  assert.equal(JSON.parse(publicProfile.data.profile_modules).games, 'false');
  const before = row(context, client.body.id);
  const rejected = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, client), body: { featured_enabled: true, featured_title: 'null' }
  });
  assertLimitError(rejected, { keys: [...keys, 'featured'] });
  assert.deepEqual(row(context, client.body.id), before);
});

test('unapproved module names and empty business-location rows do not become charged public sections', async t => {
  const context = fixture(t);
  const client = await createClient(context, {
    ...contentFor(['services', 'portfolio', 'booking']),
    business_locations: JSON.stringify([{ name: '', link: '', internal_note: 'Unpublished metadata' }]),
    profile_modules: JSON.stringify({ invented_paid_section: 'A forged section', games: '[]', media: '{}' }),
    content_plan: { keys: ['invented_paid_section'], used: 99, limit: 0 }
  });
  assertUsage(client.data, { keys: ['services', 'portfolio', 'booking'] });
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assertUsage(publicProfile.data, { keys: ['services', 'portfolio', 'booking'] });
  assert.equal('invented_paid_section' in JSON.parse(publicProfile.data.profile_modules), false);
  assert.equal(client.data.profile_modules.includes('A forged section'), true, 'Unrecognized draft data is retained privately');
});

test('hidden drafts of every section are retained for admin and owner while public usage remains zero', async t => {
  const context = fixture(t);
  const hidden = Object.fromEntries(quickKeys.map(key => ['show_' + key, false]));
  hidden.profile_module_visibility = Object.fromEntries(specialKeys.map(key => [key, false]));
  const client = await createClient(context, { ...contentFor(allKeys), ...hidden, featured_enabled: false });
  assertUsage(client.data, { keys: [] });
  const before = row(context, client.body.id);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assertUsage(publicProfile.data, { keys: [] });
  assert.equal(publicProfile.data.services, undefined);
  assert.equal(publicProfile.data.business_locations, undefined);
  assert.equal(publicProfile.data.featured_title, undefined);
  assert.deepEqual(JSON.parse(publicProfile.data.profile_modules), {});
  const owner = await call(context, '/api/client-auth/me', { cookie: await ownerCookie(context, client) });
  assertUsage(owner.data.client, { keys: [] });
  assert.equal(owner.data.client.services, client.body.services);
  assert.equal(owner.data.client.featured_title, client.body.featured_title);
  assert.equal(owner.data.client.profile_modules, client.body.profile_modules);
  const admin = await call(context, '/api/clients', { cookie: await adminCookie(context) });
  assert.equal(admin.data.find(item => item.id === client.body.id).business_locations, client.body.business_locations);
  assert.deepEqual(row(context, client.body.id), before, 'Read endpoints never rewrite historical drafts');
});

test('full owner saves enforce meaningful visibility and ignore a forged unlimited plan', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking'];
  const client = await createClient(context, contentFor(keys));
  const cookie = await ownerCookie(context, client);
  const before = row(context, client.body.id);
  const denied = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { ...client.body, ...contentFor([...keys, 'reviews']), name: 'Should not save', card_type: 'gold', content_plan: { plan: 'elite', limit: null, used: 0 } }
  });
  assertLimitError(denied, { keys: [...keys, 'reviews'] });
  assert.deepEqual(row(context, client.body.id), before);
  const saved = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { ...client.body, ...contentFor([...keys, 'reviews']), show_reviews: false, card_type: 'gold', name: 'Saved with a hidden draft' }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.card_type, 'basic');
  assertUsage(saved.data, { keys });
  assert.equal(saved.data.reviews, contentFor(['reviews']).reviews);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.equal(publicProfile.data.reviews, undefined);
  assertUsage(publicProfile.data, { keys });
});

test('partial owner saves count retained fields, and visibility changes free a slot without deleting drafts', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking'];
  const client = await createClient(context, { ...contentFor([...keys, 'reviews']), show_reviews: false });
  const cookie = await ownerCookie(context, client);
  const editedDraft = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { reviews: 'New hidden review draft' } });
  assert.equal(editedDraft.status, 200);
  assertUsage(editedDraft.data, { keys });
  const before = row(context, client.body.id);
  const denied = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_reviews: true, name: 'Must not persist' } });
  assertLimitError(denied, { keys: [...keys, 'reviews'] });
  assert.deepEqual(row(context, client.body.id), before);
  const swapped = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_services: false, show_reviews: true } });
  assert.equal(swapped.status, 200, JSON.stringify(swapped.data));
  assertUsage(swapped.data, { keys: ['portfolio', 'booking', 'reviews'] });
  assert.equal(swapped.data.services, client.body.services);
  assert.equal(swapped.data.reviews, 'New hidden review draft');
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.equal(publicProfile.data.services, undefined);
  assert.equal(publicProfile.data.reviews, 'New hidden review draft');
});

test('specialized visibility and the Quick Info master toggle count published content and preserve all drafts', async t => {
  const context = fixture(t);
  const modules = contentFor(specialKeys).profile_modules;
  const allHidden = Object.fromEntries(specialKeys.map(key => [key, false]));
  const client = await createClient(context, { profile_modules: modules, profile_module_visibility: allHidden });
  const cookie = await ownerCookie(context, client);
  const firstThree = { ...allHidden, media: true, games: true, streaming: true };
  const published = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { profile_module_visibility: JSON.stringify(firstThree) } });
  assert.equal(published.status, 200);
  assertUsage(published.data, { keys: ['media', 'games', 'streaming'] });
  const before = row(context, client.body.id);
  const fourth = { ...firstThree, discord: true };
  const denied = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { profile_module_visibility: JSON.stringify(fourth) } });
  assertLimitError(denied, { keys: ['media', 'games', 'streaming', 'discord'] });
  assert.deepEqual(row(context, client.body.id), before);
  const hidden = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { quick_info_enabled: false, profile_module_visibility: JSON.stringify(fourth) } });
  assert.equal(hidden.status, 200);
  assertUsage(hidden.data, { keys: [] });
  assert.equal(hidden.data.profile_modules, modules);
  assert.deepEqual(JSON.parse((await call(context, `/api/clients/${client.body.id}`)).data.profile_modules), {});
  const hiddenRow = row(context, client.body.id);
  const reenabled = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { quick_info_enabled: true } });
  assertLimitError(reenabled, { keys: ['media', 'games', 'streaming', 'discord'] });
  assert.deepEqual(row(context, client.body.id), hiddenRow);
});

test('Featured uses one independent slot and a complete CTA counts while a draft CTA does not', async t => {
  const context = fixture(t);
  const client = await createClient(context, {
    featured_enabled: true, featured_button_text: 'Contact us', quick_info_enabled: false,
    ...contentFor(['services', ...specialKeys])
  });
  assertUsage(client.data, { keys: [] });
  const cookie = await ownerCookie(context, client);
  const featured = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { featured_button_link: 'https://example.test/contact' } });
  assert.equal(featured.status, 200);
  assertUsage(featured.data, { keys: ['featured'] });
  const rich = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { featured_title: 'Published heading', featured_description: 'Published description' }
  });
  assert.equal(rich.status, 200);
  assertUsage(rich.data, { keys: ['featured'] });
  const hidden = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { featured_enabled: false } });
  assert.equal(hidden.status, 200);
  assertUsage(hidden.data, { keys: [] });
  assert.equal(hidden.data.featured_title, 'Published heading');
  assert.equal((await call(context, `/api/clients/${client.body.id}`)).data.featured_title, undefined);
});

test('admin full saves enforce the stored candidate and leave all fields unchanged after a cap rejection', async t => {
  const context = fixture(t);
  for (const [cardType, plan, limit] of [['basic', 'basic', 3], ['premium', 'premium', 6]]) {
    const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments', 'education'].slice(0, limit);
    const client = await createClient(context, { card_type: cardType, ...contentFor(keys) });
    const before = row(context, client.body.id);
    const extra = [...keys, 'products'];
    const denied = await call(context, '/api/clients', {
      method: 'PUT', cookie: await adminCookie(context), body: { ...client.body, ...contentFor(extra), name: 'Rejected administrator edit', content_plan: { used: 0, limit: null } }
    });
    assertLimitError(denied, { plan, limit, keys: extra });
    assert.deepEqual(row(context, client.body.id), before);
    const saved = await call(context, '/api/clients', {
      method: 'PUT', cookie: await adminCookie(context), body: { ...client.body, ...contentFor(extra), show_products: false, name: 'Administrator saved a draft' }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assertUsage(saved.data, { plan, limit, keys });
    assert.equal(saved.data.products, contentFor(['products']).products);
  }
});

test('legacy Basic over-limit owner edits and reductions succeed, but adding or replacing a published key fails', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments'];
  const client = await legacyClient(context, 'basic', keys);
  const cookie = await ownerCookie(context, client);
  const edited = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { name: 'Legacy owner edit', services: 'Edited existing published service' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assertUsage(edited.data, { keys });
  for (const body of [
    { education: 'New sixth section' },
    { show_services: false, education: 'Replacement fifth section' }
  ]) {
    const before = row(context, client.body.id);
    const denied = await call(context, '/api/client/profile', { method: 'PUT', cookie, body });
    const expected = body.show_services === false ? ['portfolio', 'booking', 'reviews', 'payments', 'education'] : [...keys, 'education'];
    assertLimitError(denied, { keys: expected });
    assert.deepEqual(row(context, client.body.id), before);
  }
  const reduced = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_payments: false } });
  assert.equal(reduced.status, 200);
  assertUsage(reduced.data, { keys: keys.slice(0, 4) });
  const reducedRow = row(context, client.body.id);
  const restore = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_payments: true } });
  assertLimitError(restore, { keys });
  assert.deepEqual(row(context, client.body.id), reducedRow, 'A removed over-limit allowance cannot be reused');
  const within = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_reviews: false } });
  assert.equal(within.status, 200);
  assertUsage(within.data, { keys: keys.slice(0, 3) });
  const swap = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { show_services: false, education: 'Valid replacement within three' } });
  assert.equal(swap.status, 200);
  assertUsage(swap.data, { keys: ['portfolio', 'booking', 'education'] });
  assert.equal(swap.data.payments, client.body.payments);
  assert.equal(swap.data.reviews, client.body.reviews);
});

test('legacy Premium admin saves preserve the same keys, allow reduction and reject a new over-limit replacement', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments', 'education', 'skills', 'resume'];
  const client = await legacyClient(context, 'premium', keys);
  const cookie = await adminCookie(context);
  const editedBody = { ...client.body, name: 'Edited historical Premium', services: 'Historical service updated' };
  const edited = await call(context, '/api/clients', { method: 'PUT', cookie, body: editedBody });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assertUsage(edited.data, { plan: 'premium', limit: 6, keys });
  for (const replacing of [false, true]) {
    const before = row(context, client.body.id);
    const denied = await call(context, '/api/clients', {
      method: 'PUT', cookie, body: { ...editedBody, ...(replacing ? { show_services: false } : {}), products: 'New section' }
    });
    assertLimitError(denied, { plan: 'premium', limit: 6, keys: [...(replacing ? keys.slice(1) : keys), 'products'] });
    assert.deepEqual(row(context, client.body.id), before);
  }
  const reduced = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...editedBody, show_resume: false } });
  assert.equal(reduced.status, 200);
  assertUsage(reduced.data, { plan: 'premium', limit: 6, keys: keys.slice(0, 7) });
});

test('an over-limit plan downgrade is rejected while an upgrade or an in-limit downgrade is allowed', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments', 'education', 'skills'];
  const elite = await createClient(context, { card_type: 'gold', ...contentFor(keys) });
  const cookie = await adminCookie(context);
  for (const [card_type, plan, limit] of [['premium', 'premium', 6], ['basic', 'basic', 3]]) {
    const before = row(context, elite.body.id);
    const denied = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...elite.body, card_type } });
    assertLimitError(denied, { plan, limit, keys });
    assert.deepEqual(row(context, elite.body.id), before);
  }
  const historical = await legacyClient(context, 'basic', keys);
  const failedIntermediate = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...historical.body, card_type: 'premium' } });
  assertLimitError(failedIntermediate, { plan: 'premium', limit: 6, keys });
  const upgraded = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...historical.body, card_type: 'gold' } });
  assert.equal(upgraded.status, 200);
  assertUsage(upgraded.data, { plan: 'elite', limit: null, keys });
  const downgraded = await call(context, '/api/clients', {
    method: 'PUT', cookie, body: { ...elite.body, card_type: 'basic', show_reviews: false, show_payments: false, show_education: false, show_skills: false }
  });
  assert.equal(downgraded.status, 200);
  assertUsage(downgraded.data, { keys: keys.slice(0, 3) });
  assert.equal(downgraded.data.skills, elite.body.skills, 'Changing a plan never deletes hidden content');
});

test('owner-submitted plan changes cannot downgrade Elite or bypass a stored Premium limit', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments', 'education'];
  const elite = await createClient(context, { card_type: 'gold', ...contentFor(keys) });
  const eliteResult = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, elite), body: { card_type: 'basic', skills: 'Seventh section remains permitted for Elite' }
  });
  assert.equal(eliteResult.status, 200);
  assert.equal(eliteResult.data.card_type, 'gold');
  assertUsage(eliteResult.data, { plan: 'elite', limit: null, keys: [...keys, 'skills'] });
  const premium = await createClient(context, { card_type: 'premium', ...contentFor(keys) });
  const before = row(context, premium.body.id);
  const denied = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, premium), body: { card_type: 'elite', skills: 'Unpermitted seventh section' }
  });
  assertLimitError(denied, { plan: 'premium', limit: 6, keys: [...keys, 'skills'] });
  assert.deepEqual(row(context, premium.body.id), before);
});

test('Featured upload cannot newly consume a fourth slot, but a hidden image is retained as a draft', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking'];
  const client = await createClient(context, { ...contentFor(keys), featured_enabled: true });
  const cookie = await ownerCookie(context, client);
  const before = row(context, client.body.id);
  const denied = await call(context, '/api/client/featured-photo', { method: 'PUT', cookie, body: photoForm() });
  assertLimitError(denied, { keys: [...keys, 'featured'] });
  assert.deepEqual(row(context, client.body.id), before);
  const disabled = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { featured_enabled: false } });
  assert.equal(disabled.status, 200);
  const draft = await call(context, '/api/client/featured-photo', { method: 'PUT', cookie, body: photoForm() });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.ok(draft.data.featured_image.startsWith('data:image/jpeg;base64,'));
  assertUsage(draft.data, { keys });
  assert.equal((await call(context, `/api/clients/${client.body.id}`)).data.featured_image, undefined);
  const draftRow = row(context, client.body.id);
  const publish = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { featured_enabled: true } });
  assertLimitError(publish, { keys: [...keys, 'featured'] });
  assert.deepEqual(row(context, client.body.id), draftRow);
  const swapped = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { featured_enabled: true, show_services: false } });
  assert.equal(swapped.status, 200);
  assertUsage(swapped.data, { keys: ['portfolio', 'booking', 'featured'] });
  assert.equal(swapped.data.featured_image, draft.data.featured_image);
});

test('replacing a published Featured photo and updating the free identity photo do not add slots', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'featured'];
  const client = await createClient(context, contentFor(keys));
  const cookie = await ownerCookie(context, client);
  const featured = await call(context, '/api/client/featured-photo', { method: 'PUT', cookie, body: photoForm() });
  assert.equal(featured.status, 200);
  assertUsage(featured.data, { keys });
  const photo = await call(context, '/api/client/photo', { method: 'PUT', cookie, body: photoForm() });
  assert.equal(photo.status, 200);
  assertUsage(photo.data, { keys });
  assert.ok(photo.data.photo_url.startsWith('data:image/jpeg;base64,'));
  const removed = await call(context, '/api/client/featured-photo', { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assertUsage(removed.data, { keys });
  assert.equal(removed.data.featured_title, client.body.featured_title, 'Deleting a photo retains the rest of Featured');
});

test('a legacy over-limit Featured block can receive an image without acquiring another published key', async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'featured'];
  const client = await legacyClient(context, 'basic', keys);
  const result = await call(context, '/api/client/featured-photo', { method: 'PUT', cookie: await ownerCookie(context, client), body: photoForm() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assertUsage(result.data, { keys });
  assert.ok(result.data.featured_image.startsWith('data:image/jpeg;base64,'));
  assert.equal(result.data.services, client.body.services);
  assert.equal(result.data.reviews, client.body.reviews);
});

test('legacy public profiles above the cap remain complete and all read APIs leave historical rows unchanged', async t => {
  const context = fixture(t);
  const client = await legacyClient(context, 'basic', allKeys, { view_count: 29 });
  const before = row(context, client.body.id);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.equal(publicProfile.status, 200);
  assertUsage(publicProfile.data, { keys: allKeys });
  for (const key of quickKeys) {
    const field = key === 'business_location' ? 'business_locations' : key;
    assert.equal(publicProfile.data[field], before[field], `Legacy public ${key} must not be truncated`);
  }
  assert.equal(publicProfile.data.profile_modules, before.profile_modules);
  assert.equal(publicProfile.data.featured_title, before.featured_title);
  assert.equal(publicProfile.data.featured_description, before.featured_description);
  assert.equal(publicProfile.data.featured_button_link, before.featured_button_link);
  const owner = await call(context, '/api/client-auth/me', { cookie: await ownerCookie(context, client) });
  assertUsage(owner.data.client, { keys: allKeys });
  const admin = await call(context, '/api/clients', { cookie: await adminCookie(context) });
  assertUsage(admin.data.find(item => item.id === client.body.id), { keys: allKeys });
  assert.deepEqual(row(context, client.body.id), before);
});

test('two simultaneous owner saves cannot combine individually valid edits into a fourth Basic block', { timeout: 10_000 }, async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services', 'portfolio']));
  const cookie = await ownerCookie(context, client);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  context.readGate = { id: client.body.id, arrived: 0, ready, release };
  const results = await Promise.all([
    call(context, '/api/client/profile', { method: 'PUT', cookie, body: { booking: 'Concurrent booking' } }),
    call(context, '/api/client/profile', { method: 'PUT', cookie, body: { reviews: 'Concurrent reviews' } })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409], JSON.stringify(results));
  const saved = row(context, client.body.id);
  assert.equal(Boolean(saved.booking), !Boolean(saved.reviews));
  const winner = saved.booking ? 'booking' : 'reviews';
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assertUsage(publicProfile.data, { keys: ['services', 'portfolio', winner] });
});

test('a pending admin save cannot recreate a deleted legacy profile, and PUT never creates an unknown profile', { timeout: 10_000 }, async t => {
  const context = fixture(t);
  const keys = ['services', 'portfolio', 'booking', 'reviews', 'payments'];
  const client = await legacyClient(context, 'basic', keys);
  const cookie = await adminCookie(context);
  let announce, release;
  const captured = new Promise(resolve => { announce = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  context.pausedRead = { id: client.body.id, announce, ready };
  const pending = call(context, '/api/clients', {
    method: 'PUT', cookie, body: { ...client.body, client_login_password: '', name: 'Stale legacy administrator save' }
  });
  await captured;
  assert.ok(row(context, client.body.id), 'The pending save has captured an existing over-limit row');
  const deleted = await call(context, `/api/clients/${client.body.id}`, { method: 'DELETE', cookie });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(row(context, client.body.id), null);
  release();
  const staleSave = await pending;
  assert.equal(staleSave.status, 409, JSON.stringify(staleSave.data));
  assert.equal(row(context, client.body.id), null, 'A stale UPSERT must not recreate the deleted legacy content');
  assert.equal((await call(context, `/api/clients/${client.body.id}`)).status, 404);

  const missing = payload(context, { ...contentFor(['services']), client_login_password: '' });
  const beforeCount = context.sqlite.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const unknownSave = await call(context, '/api/clients', { method: 'PUT', cookie, body: missing });
  assert.equal(unknownSave.status, 404, JSON.stringify(unknownSave.data));
  assert.equal(row(context, missing.id), null);
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS n FROM clients').get().n, beforeCount);
});
