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
            const output = { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
            if (context.afterWrite) await context.afterWrite(sql, parameters, output);
            return output;
          }
        };
        return statement;
      }
    }
  };
  return context;
}

async function call(context, path, { method = 'GET', body, cookie, headers: extraHeaders } = {}) {
  const headers = new Headers(extraHeaders);
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

function assertChanged(result) {
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, 'PROFILE_CHANGED');
  assert.equal(typeof result.data.error, 'string');
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

test('authenticated admin and owner reads expose the persisted revision while public reads omit it', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const stored = row(context, client.body.id).content_revision;
  assert.ok(Number.isSafeInteger(stored) && stored >= 0);
  assert.equal(client.data.content_revision, stored);
  const admin = await call(context, '/api/clients', { cookie: await adminCookie(context) });
  assert.equal(admin.data.find(item => item.id === client.body.id).content_revision, stored);
  const owner = await call(context, '/api/client-auth/me', { cookie: await ownerCookie(context, client) });
  assert.equal(owner.data.client.content_revision, stored);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.equal(Object.hasOwn(publicProfile.data, 'content_revision'), false);
  assertUsage(publicProfile.data, { keys: ['services'] });
});

test('an owner editor revision prevents stale overwrites and accepted or legacy saves advance the revision', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const cookie = await ownerCookie(context, client);
  let revision = client.data.content_revision;
  const saved = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { expected_revision: revision, portfolio: 'New published portfolio' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.content_revision, revision + 1);
  const before = row(context, client.body.id);
  const stale = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { expected_revision: revision, name: 'Stale name', portfolio: 'Stale portfolio' }
  });
  assertChanged(stale);
  assert.deepEqual(row(context, client.body.id), before);
  revision = saved.data.content_revision;
  const fresh = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { expected_revision: revision, about: 'Fresh biography' } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.content_revision, revision + 1);
  const legacy = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { about: 'Compatible old editor' } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.content_revision, fresh.data.content_revision + 1);
  assert.equal(legacy.data.portfolio, 'New published portfolio');
});

test('an admin editor revision protects complete saves and omission preserves old editor compatibility', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const cookie = await adminCookie(context);
  const revision = client.data.content_revision;
  const body = { ...client.body, client_login_password: '' };
  const saved = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...body, expected_revision: revision, name: 'Fresh administrator name' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.content_revision, revision + 1);
  const before = row(context, client.body.id);
  const stale = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...body, expected_revision: revision, name: 'Stale administrator name' } });
  assertChanged(stale);
  assert.deepEqual(row(context, client.body.id), before);
  const fresh = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...body, expected_revision: saved.data.content_revision, name: 'Second administrator name' } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.content_revision, saved.data.content_revision + 1);
  const legacy = await call(context, '/api/clients', { method: 'PUT', cookie, body: { ...body, name: 'Old administrator editor' } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.content_revision, fresh.data.content_revision + 1);
});

test('invalid or conflicting JSON/header revisions fail without changing admin or owner profile data', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const owner = await ownerCookie(context, client);
  const admin = await adminCookie(context);
  const before = row(context, client.body.id);
  const invalid = [null, false, true, -1, 0.5, '0', '', [], {}, Number.MAX_SAFE_INTEGER + 1];
  for (const [path, cookie, base] of [
    ['/api/client/profile', owner, { name: 'Invalid owner update' }],
    ['/api/clients', admin, { ...client.body, client_login_password: '', name: 'Invalid admin update' }]
  ]) {
    for (const expected_revision of invalid) {
      const result = await call(context, path, { method: 'PUT', cookie, body: { ...base, expected_revision } });
      assert.equal(result.status, 400, `${path} revision ${JSON.stringify(expected_revision)}: ${JSON.stringify(result.data)}`);
      assert.deepEqual(row(context, client.body.id), before);
    }
    const conflicting = await call(context, path, {
      method: 'PUT', cookie, body: { ...base, expected_revision: before.content_revision },
      headers: { 'X-Expected-Revision': String(before.content_revision + 1) }
    });
    assert.equal(conflicting.status, 400, JSON.stringify(conflicting.data));
    assert.deepEqual(row(context, client.body.id), before);
  }
});

test('Featured and identity photo PUT/DELETE check header revisions, advance on success and preserve missing-header compatibility', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['featured']));
  const cookie = await ownerCookie(context, client);
  for (const path of ['/api/client/featured-photo', '/api/client/photo']) {
    let revision = row(context, client.body.id).content_revision;
    const uploaded = await call(context, path, { method: 'PUT', cookie, body: photoForm(), headers: { 'X-Expected-Revision': String(revision) } });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.content_revision, revision + 1);
    const before = row(context, client.body.id);
    for (const method of ['PUT', 'DELETE']) {
      const stale = await call(context, path, { method, cookie, ...(method === 'PUT' ? { body: photoForm() } : {}), headers: { 'X-Expected-Revision': String(revision) } });
      assertChanged(stale);
      assert.deepEqual(row(context, client.body.id), before);
    }
    revision = uploaded.data.content_revision;
    const removed = await call(context, path, { method: 'DELETE', cookie, headers: { 'X-Expected-Revision': String(revision) } });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.content_revision, revision + 1);
    assert.equal(row(context, client.body.id)[path.endsWith('featured-photo') ? 'featured_image' : 'photo_key'], '');
    const compatibleUpload = await call(context, path, { method: 'PUT', cookie, body: photoForm() });
    assert.equal(compatibleUpload.status, 200);
    assert.equal(compatibleUpload.data.content_revision, removed.data.content_revision + 1);
    const compatibleDelete = await call(context, path, { method: 'DELETE', cookie });
    assert.equal(compatibleDelete.status, 200);
    assert.equal(compatibleDelete.data.content_revision, compatibleUpload.data.content_revision + 1);
  }
});

test('invalid multipart/delete revision headers are rejected before any photo or row mutation', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['featured']));
  const cookie = await ownerCookie(context, client);
  const before = row(context, client.body.id);
  for (const path of ['/api/client/featured-photo', '/api/client/photo']) {
    for (const method of ['PUT', 'DELETE']) {
      for (const header of ['', '-1', '1.5', '1e2', 'true', 'null', '1 0', String(Number.MAX_SAFE_INTEGER + 1)]) {
        const result = await call(context, path, { method, cookie, ...(method === 'PUT' ? { body: photoForm() } : {}), headers: { 'X-Expected-Revision': header } });
        assert.equal(result.status, 400, `${method} ${path} header ${JSON.stringify(header)}: ${JSON.stringify(result.data)}`);
        assert.deepEqual(row(context, client.body.id), before);
      }
    }
  }
});

test('stale multipart revisions are checked before reading or parsing the upload body', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['featured']));
  const cookie = await ownerCookie(context, client);
  const staleRevision = client.data.content_revision;
  const saved = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { expected_revision: staleRevision, about: 'Advance the editor revision' } });
  assert.equal(saved.status, 200);
  const before = row(context, client.body.id);
  for (const path of ['/api/client/featured-photo', '/api/client/photo']) {
    const request = new Request(`https://content-plan.test${path}`, {
      method: 'PUT', headers: { Cookie: cookie, 'X-Expected-Revision': String(staleRevision), 'Content-Type': 'multipart/form-data; boundary=missing' },
      body: 'Deliberately malformed upload; a stale editor must not parse it'
    });
    const body = request.body;
    let reads = 0;
    Object.defineProperty(request, 'body', { get() { reads++; return body; } });
    const response = await worker.fetch(request, context.env);
    assertChanged({ status: response.status, data: await response.json() });
    assert.equal(reads, 0, 'A stale upload is rejected before obtaining a stream reader');
    assert.equal(request.bodyUsed, false);
    assert.deepEqual(row(context, client.body.id), before);
  }
});

test('admin-created phone-only owners can save unrelated content while clearing an existing email or name remains invalid', async t => {
  const context = fixture(t);
  const phoneOnly = await createClient(context, { email: '', phone: '09171234567', ...contentFor(['services']) });
  const login = await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: '09171234567', password: clientPassword } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const edited = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: login.cookie, body: { expected_revision: phoneOnly.data.content_revision, portfolio: 'Phone-only owner portfolio' }
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.email, '');
  assertUsage(edited.data, { keys: ['services', 'portfolio'] });
  const explicitEmpty = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: login.cookie, body: { email: '', about: 'Compatible unchanged blank email' }
  });
  assert.equal(explicitEmpty.status, 200, JSON.stringify(explicitEmpty.data));
  const phoneBefore = row(context, phoneOnly.body.id);
  const noName = await call(context, '/api/client/profile', { method: 'PUT', cookie: login.cookie, body: { name: '', services: 'Must not write' } });
  assert.equal(noName.status, 400);
  assert.deepEqual(row(context, phoneOnly.body.id), phoneBefore);
  const emailOwner = await createClient(context, { phone: '09281234567' });
  const emailCookie = await ownerCookie(context, emailOwner);
  const emailBefore = row(context, emailOwner.body.id);
  const cleared = await call(context, '/api/client/profile', { method: 'PUT', cookie: emailCookie, body: { email: '', about: 'Must not write' } });
  assert.equal(cleared.status, 400);
  assert.deepEqual(row(context, emailOwner.body.id), emailBefore);
});

test('owner and admin API saves preserve v2 hours modes, explicit days and multiple periods', async t => {
  const context = fixture(t);
  const hours = JSON.stringify([
    { day: 1, enabled: true, mode: '24h', periods: [] },
    { day: 5, enabled: true, mode: 'regular', periods: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '17:00' }] },
    { day: 6, enabled: false, mode: 'closed', periods: [] }
  ]);
  const expected = [
    { day: 1, enabled: true, mode: '24h', periods: [] },
    { day: 5, enabled: true, mode: 'regular', periods: [{ open: 540, close: 720 }, { open: 780, close: 1020 }] },
    { day: 6, enabled: false, mode: 'closed', periods: [] }
  ];
  const v2Hours = raw => JSON.parse(raw).map(({ day, enabled, mode, periods }) => ({ day, enabled, mode, periods }));
  const client = await createClient(context, { business_hours: hours });
  assert.deepEqual(v2Hours(client.data.business_hours), expected);
  const owner = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, client), body: { expected_revision: client.data.content_revision, business_hours: hours }
  });
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  assert.deepEqual(v2Hours(owner.data.business_hours), expected);
  const admin = await call(context, '/api/clients', {
    method: 'PUT', cookie: await adminCookie(context), body: { ...client.body, client_login_password: '', expected_revision: owner.data.content_revision, business_hours: hours }
  });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  assert.deepEqual(v2Hours(admin.data.business_hours), expected);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.deepEqual(v2Hours(publicProfile.data.business_hours), expected);
  assertUsage(publicProfile.data, { keys: ['business_hours'] });
});

test('deactivating a profile advances its revision so a stale full admin save cannot reactivate it', async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const cookie = await adminCookie(context);
  const list = await call(context, '/api/clients', { cookie });
  const opened = list.data.find(item => item.id === client.body.id);
  const status = await call(context, `/api/clients/${client.body.id}/status`, { method: 'POST', cookie, body: { active: false } });
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.equal(status.data.active, false);
  const deactivated = row(context, client.body.id);
  assert.equal(deactivated.active, 0);
  assert.equal(deactivated.content_revision, opened.content_revision + 1);
  const stale = await call(context, '/api/clients', {
    method: 'PUT', cookie, body: { ...client.body, client_login_password: '', active: true, name: 'Stale resurrection', expected_revision: opened.content_revision }
  });
  assertChanged(stale);
  assert.deepEqual(row(context, client.body.id), deactivated);
  assert.equal((await call(context, `/api/clients/${client.body.id}`)).status, 404);
});

test('changing a password invalidates a pending full admin save without restoring the old credentials', { timeout: 10_000 }, async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const admin = await adminCookie(context);
  const owner = await ownerCookie(context, client);
  let announce, release;
  const captured = new Promise(resolve => { announce = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  context.pausedRead = { id: client.body.id, announce, ready };
  const pending = call(context, '/api/clients', {
    method: 'PUT', cookie: admin, body: { ...client.body, client_login_password: '', expected_revision: client.data.content_revision, name: 'Stale credential rollback' }
  });
  await captured;
  const changed = await call(context, '/api/client/password', {
    method: 'PUT', cookie: owner, body: { current_password: clientPassword, new_password: 'synthetic-replacement-password' }
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const afterPassword = row(context, client.body.id);
  assert.equal(afterPassword.content_revision, client.data.content_revision + 1);
  assert.equal(changed.data.client.content_revision, afterPassword.content_revision);
  release();
  assertChanged(await pending);
  assert.deepEqual(row(context, client.body.id), afterPassword);
  const renewed = await call(context, '/api/client-auth/me', { cookie: changed.cookie });
  assert.equal(renewed.data.authenticated, true);
  assert.equal(renewed.data.client.content_revision, afterPassword.content_revision);
  assert.equal((await call(context, '/api/client-auth/me', { cookie: owner })).data.authenticated, false);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: client.body.email, password: clientPassword } })).status, 401);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: client.body.email, password: 'synthetic-replacement-password' } })).status, 200);
});

test('a concurrent admin password reset prevents issuing an already-invalid renewed owner cookie', { timeout: 10_000 }, async t => {
  const context = fixture(t);
  const client = await createClient(context, contentFor(['services']));
  const owner = await ownerCookie(context, client);
  const admin = await adminCookie(context);
  let announce, release;
  const written = new Promise(resolve => { announce = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  context.afterWrite = async sql => {
    if (!/UPDATE clients SET login_password_hash/.test(sql)) return;
    context.afterWrite = null;
    announce();
    await ready;
  };
  const pending = call(context, '/api/client/password', {
    method: 'PUT', cookie: owner, body: { current_password: clientPassword, new_password: 'synthetic-owner-new-password' }
  });
  await written;
  const revision = row(context, client.body.id).content_revision;
  const reset = await call(context, '/api/clients', {
    method: 'PUT', cookie: admin, body: { ...client.body, expected_revision: revision, client_login_password: 'synthetic-admin-reset-password' }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const afterReset = row(context, client.body.id);
  release();
  const superseded = await pending;
  assertChanged(superseded);
  assert.equal(superseded.cookie, undefined);
  assert.deepEqual(row(context, client.body.id), afterReset);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: client.body.email, password: 'synthetic-owner-new-password' } })).status, 401);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: client.body.email, password: 'synthetic-admin-reset-password' } })).status, 200);
});

test('a null business-hours day uses its array position through admin creation and owner round-trip', async t => {
  const context = fixture(t);
  const hours = JSON.stringify([{ day: 0, enabled: false }, { day: null, enabled: true, open: '09:00', close: '17:00' }]);
  const client = await createClient(context, { business_hours: hours });
  const createdHours = JSON.parse(client.data.business_hours);
  assert.deepEqual(createdHours.map(item => item.day), [0, 1]);
  assert.equal(createdHours[1].open, 540);
  const saved = await call(context, '/api/client/profile', {
    method: 'PUT', cookie: await ownerCookie(context, client), body: { expected_revision: client.data.content_revision, business_hours: hours }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(JSON.parse(saved.data.business_hours), createdHours);
  const publicProfile = await call(context, `/api/clients/${client.body.id}`);
  assert.deepEqual(JSON.parse(publicProfile.data.business_hours), createdHours);
});
