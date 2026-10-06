import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { CARD_DESIGNS } = await import(pathToFileURL(join(root, 'src', 'card-designs.js')).href);
const { default: worker } = await import(pathToFileURL(join(root, 'src', 'index.js')).href);
const migrations = (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
const migrationSources = await Promise.all(migrations.map(name => readFile(join(root, 'migrations', name), 'utf8')));

// Execute actual SQLite, rather than replacing SQL with hand-written route responses.
// The small adapter reproduces the D1 prepared-statement result shapes used by this Worker.
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (let i = 0; i < migrations.length; i++) {
    assert.doesNotThrow(() => sqlite.exec(migrationSources[i]), `Fresh migration failed: ${migrations[i]}`);
  }
  t.after(() => sqlite.close());
  const DB = {
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let parameters = [];
      const statement = {
        bind(...values) { parameters = values; return statement; },
        async first(column) {
          const result = prepared.get(...parameters);
          if (!result) return null;
          return column ? result[column] : { ...result };
        },
        async all() { return { success: true, results: prepared.all(...parameters).map(row => ({ ...row })) }; },
        async run() {
          const result = prepared.run(...parameters);
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        }
      };
      return statement;
    }
  };
  return {
    sqlite,
    env: {
      DB,
      ADMIN_PASSWORD: 'test-only-admin-password',
      CLIENT_AUTH_SECRET: 'test-only-client-secret',
      ASSETS: { async fetch() { return new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }); } }
    }
  };
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
  const response = await worker.fetch(new Request(`https://nextap.test${path}`, { method, headers, body: requestBody }), context.env);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, status: response.status, data, cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
}

async function adminLogin(context) {
  const result = await call(context, '/api/auth/login', { method: 'POST', body: { password: context.env.ADMIN_PASSWORD } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie?.startsWith('nextap_admin='));
  return result.cookie;
}

async function createClient(context, overrides = {}) {
  const cookie = await adminLogin(context);
  const payload = {
    id: 'client-one', slug: 'client-one', name: 'Client One', email: 'one@example.test',
    phone: '+63 917 123 4567', card_type: 'gold', client_login_password: 'original-password',
    ...overrides
  };
  const result = await call(context, '/api/clients', { method: 'POST', cookie, body: payload });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return { cookie, payload, client: result.data };
}

async function clientLogin(context, identifier = 'one@example.test', password = 'original-password') {
  const result = await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier, password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie?.startsWith('nextap_client='));
  return result.cookie;
}

function orderBody(items = [{ plan: 'Elite Card', quantity: 1 }]) {
  return {
    customer_name: 'Order Customer', customer_email: 'orders@example.test', customer_phone: '09171234567',
    card_name: 'Order Customer', title_role: 'Designer', delivery_address: '123 Test Street, Manila',
    delivery_region_code: '1300000000', items
  };
}

function designSnapshot(design) {
  return {
    design_id: design.id, design_name: design.label, design_version: design.version,
    design_front: design.front, design_back: design.back
  };
}

function jpegBytes(size) {
  const bytes = Buffer.alloc(size, 0x41);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(bytes);
  return bytes;
}

function jpegDataUrl(size) { return `data:image/jpeg;base64,${jpegBytes(size).toString('base64')}`; }
function pngBytes(size) {
  const bytes = Buffer.alloc(size, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}
function photoForm(bytes, type = 'image/jpeg') {
  const form = new FormData();
  form.set('photo', new File([bytes], 'photo.jpg', { type }));
  return form;
}

test('fresh migrations support creating, editing and reading a client without losing identity or views', async t => {
  const context = fixture(t);
  const created = await createClient(context, { education: 'Published education', show_education: false });
  assert.equal(created.client.id, 'client-one');
  assert.equal(created.client.education, 'Published education');
  assert.equal(created.client.show_education, false);
  assert.equal((await call(context, '/api/clients/client-one/view', { method: 'POST' })).status, 200);
  const updated = await call(context, '/api/clients', {
    method: 'PUT', cookie: created.cookie, body: { ...created.payload, name: 'Updated Name', client_login_password: '' }
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.name, 'Updated Name');
  assert.equal(updated.data.view_count, 1);
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM clients WHERE id = ?').get('client-one').count, 1);
  assert.equal((await call(context, '/api/clients', { method: 'POST', cookie: created.cookie, body: created.payload })).status, 409);
  await clientLogin(context);
});

test('admin and client APIs keep their authentication boundaries', async t => {
  const context = fixture(t);
  const requests = [
    ['/api/clients', 'GET'], ['/api/clients', 'POST'], ['/api/clients', 'PUT'],
    ['/api/clients/client-one', 'DELETE'], ['/api/clients/client-one/status', 'POST'],
    ['/api/orders', 'GET'], ['/api/orders/order-one', 'PATCH'], ['/api/upload', 'POST'],
    ['/api/client/profile', 'PUT'], ['/api/client/password', 'PUT'], ['/api/client/photo', 'DELETE']
  ];
  for (const [path, method] of requests) {
    const result = await call(context, path, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(result.status, 401, `${method} ${path}: ${JSON.stringify(result.data)}`);
  }
  assert.equal((await call(context, '/api/auth/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const adminCookie = await adminLogin(context);
  const result = await call(context, '/api/client/profile', { method: 'PUT', cookie: adminCookie, body: { name: 'Unsafe edit' } });
  assert.equal(result.status, 401);
});

test('email and commonly formatted Philippine phone numbers can sign in', async t => {
  const context = fixture(t);
  await createClient(context);
  for (const identifier of ['ONE@EXAMPLE.TEST', '09171234567', '0917-123-4567', '(0917) 123.4567', '+63 917 123 4567', '639171234567']) {
    const cookie = await clientLogin(context, identifier);
    const me = await call(context, '/api/client-auth/me', { cookie });
    assert.equal(me.data.authenticated, true, identifier);
    assert.equal(me.data.client.id, 'client-one');
  }
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: 'one@example.test', password: 'wrong' } })).status, 401);
});

test('client edits are restricted to their account and duplicate email changes fail atomically', async t => {
  const context = fixture(t);
  await createClient(context);
  await createClient(context, { id: 'client-two', slug: 'client-two', name: 'Client Two', email: 'two@example.test', phone: '09281234567' });
  const cookie = await clientLogin(context);
  const updated = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { id: 'client-two', name: 'Owner changed', about: 'Owner details', card_type: 'basic', active: false }
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.id, 'client-one');
  assert.equal(updated.data.card_type, 'gold');
  assert.equal(updated.data.active, true);
  assert.equal(context.sqlite.prepare('SELECT name FROM clients WHERE id = ?').get('client-two').name, 'Client Two');
  const duplicate = await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { name: 'Should not persist', email: 'two@example.test' } });
  assert.equal(duplicate.status, 409);
  assert.equal(context.sqlite.prepare('SELECT name FROM clients WHERE id = ?').get('client-one').name, 'Owner changed');
});

test('business hours save verifies normalized values and preserves unrelated fields', async t => {
  const context = fixture(t);
  await createClient(context, { services: 'Original services' });
  const cookie = await clientLogin(context);
  const result = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { business_hours: JSON.stringify([{ day: 1, enabled: true, open: '09:00', close: '17:30' }]) }
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(JSON.parse(result.data.business_hours), [{ day: 1, enabled: true, open: 540, close: 1050 }]);
  assert.equal(result.data.services, 'Original services');
});

test('public profiles remove hidden content while authenticated owner and admin retain drafts', async t => {
  const context = fixture(t);
  const created = await createClient(context, {
    services: 'Private services draft', show_services: false, education: 'Published education',
    featured_enabled: false, featured_title: 'Private featured draft', featured_description: 'Private featured notes',
    business_location_name: 'Private location', business_location_link: 'https://private.example.test',
    business_locations: '[{"name":"Private second location"}]', show_business_location: false,
    profile_modules: JSON.stringify({ games: 'Private module draft', interests: 'Published module' }),
    profile_module_visibility: JSON.stringify({ games: false, interests: true })
  });
  const publicProfile = await call(context, '/api/clients/client-one');
  assert.equal(publicProfile.status, 200);
  const publicText = JSON.stringify(publicProfile.data);
  for (const privateText of ['Private services draft', 'Private featured draft', 'Private featured notes', 'Private location', 'private.example.test', 'Private second location', 'Private module draft']) {
    assert.ok(!publicText.includes(privateText), `Public response leaked ${privateText}`);
  }
  assert.equal(publicProfile.data.education, 'Published education');
  assert.ok(publicText.includes('Published module'));
  assert.ok(!('view_count' in publicProfile.data));
  assert.ok(!('login_password_hash' in publicProfile.data));
  const clientCookie = await clientLogin(context);
  const me = await call(context, '/api/client-auth/me', { cookie: clientCookie });
  assert.equal(me.data.client.services, 'Private services draft');
  const admin = await call(context, '/api/clients', { cookie: created.cookie });
  assert.equal(admin.data.find(client => client.id === 'client-one').featured_title, 'Private featured draft');
});

test('disabling quick info removes all quick-info values from the public response', async t => {
  const context = fixture(t);
  await createClient(context, { quick_info_enabled: false, services: 'Hidden service', education: 'Hidden education', business_hours: 'Hidden schedule' });
  const result = await call(context, '/api/clients/client-one');
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result.data).includes('Hidden'));
});

test('password change revokes prior sessions, renews the changing session and uses the new password', async t => {
  const context = fixture(t);
  await createClient(context);
  const firstCookie = await clientLogin(context);
  const secondCookie = await clientLogin(context);
  const wrong = await call(context, '/api/client/password', { method: 'PUT', cookie: firstCookie, body: { current_password: 'wrong', new_password: 'replacement-password' } });
  assert.equal(wrong.status, 401);
  assert.equal((await call(context, '/api/client-auth/me', { cookie: firstCookie })).data.authenticated, true);
  const result = await call(context, '/api/client/password', { method: 'PUT', cookie: firstCookie, body: { current_password: 'original-password', new_password: 'replacement-password' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie?.startsWith('nextap_client='), 'The browser needs a replacement cookie after password changes');
  for (const cookie of [firstCookie, secondCookie]) {
    assert.equal((await call(context, '/api/client-auth/me', { cookie })).data.authenticated, false);
    assert.equal((await call(context, '/api/client/profile', { method: 'PUT', cookie, body: { name: 'Stale edit' } })).status, 401);
  }
  assert.equal((await call(context, '/api/client-auth/me', { cookie: result.cookie })).data.authenticated, true);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: 'one@example.test', password: 'original-password' } })).status, 401);
  await clientLogin(context, 'one@example.test', 'replacement-password');
});

test('admin password reset and profile deactivation revoke existing client access', async t => {
  const context = fixture(t);
  const created = await createClient(context);
  const oldCookie = await clientLogin(context);
  const reset = await call(context, '/api/clients', { method: 'PUT', cookie: created.cookie, body: { ...created.payload, client_login_password: 'admin-replacement-password' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await call(context, '/api/client-auth/me', { cookie: oldCookie })).data.authenticated, false);
  const newCookie = await clientLogin(context, 'one@example.test', 'admin-replacement-password');
  assert.equal((await call(context, '/api/clients/client-one/status', { method: 'POST', cookie: created.cookie, body: { active: false } })).status, 200);
  assert.equal((await call(context, '/api/client-auth/me', { cookie: newCookie })).data.authenticated, false);
  assert.equal((await call(context, '/api/clients/client-one')).status, 404);
});

test('legacy client tokens require re-login, malformed cookies and tampered tokens fail safely', async t => {
  const context = fixture(t);
  await createClient(context);
  const payload = Buffer.from(JSON.stringify({ role: 'client', clientId: 'client-one', exp: Date.now() + 60_000 })).toString('base64url');
  const signature = createHmac('sha256', context.env.CLIENT_AUTH_SECRET).update(payload).digest('base64url');
  const legacy = `nextap_client=${payload}.${signature}`;
  assert.equal((await call(context, '/api/client-auth/me', { cookie: legacy })).data.authenticated, false);
  for (const cookie of ['nextap_client=%E0%A4%A', 'nextap_client=invalid.invalid', `nextap_client=${payload}.wrong`, 'nextap_admin=%E0%A4%A']) {
    const path = cookie.startsWith('nextap_admin=') ? '/api/auth/me' : '/api/client-auth/me';
    const result = await call(context, path, { cookie });
    assert.equal(result.status, 200, cookie);
    assert.equal(result.data.authenticated, false, cookie);
  }
  const currentCookie = await clientLogin(context);
  const [signedPayload, signedSignature] = decodeURIComponent(currentCookie.split('=')[1]).split('.');
  const changedExpiry = JSON.parse(Buffer.from(signedPayload, 'base64url').toString());
  changedExpiry.exp = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const forgedPayload = Buffer.from(JSON.stringify(changedExpiry)).toString('base64url');
  assert.equal((await call(context, '/api/client-auth/me', { cookie: `nextap_client=${forgedPayload}.${signedSignature}` })).data.authenticated, false);
});

test('login throttling uses canonical phone accounts, ignores fabricated cookies and expires', async t => {
  const context = fixture(t);
  const actualNow = Date.now;
  const fixedNow = 1_800_000_100_000;
  Date.now = () => fixedNow;
  t.after(() => { Date.now = actualNow; });
  const identifiers = ['09170000000', '+63 917 000 0000', '0917-000-0000', '(0917) 000.0000', '639170000000'];
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await call(context, '/api/client-auth/login', {
      method: 'POST', body: { identifier: identifiers[attempt % identifiers.length], password: 'wrong' },
      headers: { 'CF-Connecting-IP': `192.0.2.${attempt + 1}` }, cookie: `retry_after=0; login_date=${fixedNow + 365 * 24 * 60 * 60 * 1000}`
    });
    assert.equal(result.status, 401, JSON.stringify(result.data));
  }
  const blocked = await call(context, '/api/client-auth/login', {
    method: 'POST', body: { identifier: '09170000000', password: 'wrong' }, cookie: 'retry_after=0'
  });
  assert.equal(blocked.status, 429, JSON.stringify(blocked.data));
  assert.ok(Number(blocked.response.headers.get('Retry-After')) > 0);
  assert.ok(Number(blocked.response.headers.get('Retry-After')) <= 900);
  assert.ok(context.sqlite.prepare('SELECT key FROM auth_rate_limits').all().every(row => !row.key.includes('09170000000')));
  Date.now = () => fixedNow + 16 * 60 * 1000;
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: '09170000000', password: 'wrong' } })).status, 401);
});

test('login throttling blocks one IP cycling through different account identifiers', async t => {
  const context = fixture(t);
  const actualNow = Date.now;
  const fixedNow = actualNow();
  Date.now = () => fixedNow;
  t.after(() => { Date.now = actualNow; });
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await call(context, '/api/client-auth/login', {
      method: 'POST', body: { identifier: `unknown-${attempt}@example.test`, password: 'wrong' },
      headers: { 'CF-Connecting-IP': '192.0.2.100' }
    });
    assert.equal(result.status, 401, JSON.stringify(result.data));
  }
  const bucketsBefore = context.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_rate_limits').get().count;
  const blocked = await call(context, '/api/client-auth/login', {
    method: 'POST', body: { identifier: 'one-more-account@example.test', password: 'wrong' },
    headers: { 'CF-Connecting-IP': '192.0.2.100' }
  });
  assert.equal(blocked.status, 429, JSON.stringify(blocked.data));
  assert.ok(Number(blocked.response.headers.get('Retry-After')) > 0);
  for (let attempt = 0; attempt < 20; attempt++) {
    const repeated = await call(context, '/api/client-auth/login', {
      method: 'POST', body: { identifier: `blocked-random-${attempt}@example.test`, password: 'wrong' },
      headers: { 'CF-Connecting-IP': '192.0.2.100' }
    });
    assert.equal(repeated.status, 429, JSON.stringify(repeated.data));
  }
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_rate_limits').get().count, bucketsBefore,
    'A blocked IP must not create new account counters for arbitrary identifiers');
});

test('admin login attempts are throttled independently of client sign-in', async t => {
  const context = fixture(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await call(context, '/api/auth/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  }
  assert.equal((await call(context, '/api/auth/login', { method: 'POST', body: { password: context.env.ADMIN_PASSWORD } })).status, 429);
  assert.equal((await call(context, '/api/client-auth/login', { method: 'POST', body: { identifier: 'unknown@example.test', password: 'wrong' } })).status, 401);
});

test('cross-origin profile writes are rejected while same-origin browser requests work', async t => {
  const context = fixture(t);
  await createClient(context);
  const cookie = await clientLogin(context);
  const rejected = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, headers: { Origin: 'https://untrusted.example.test' }, body: { name: 'Cross-origin edit' }
  });
  assert.equal(rejected.status, 403, JSON.stringify(rejected.data));
  assert.equal(context.sqlite.prepare('SELECT name FROM clients WHERE id = ?').get('client-one').name, 'Client One');
  const accepted = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, headers: { Origin: 'https://nextap.test' }, body: { name: 'Same-origin edit' }
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.name, 'Same-origin edit');
});

test('NCR and other no-province address lookups use supported city and barangay routes', async t => {
  const context = fixture(t);
  const city = { code: '138010000', name: 'City of Manila' };
  const barangay = { code: '138010001', name: 'Barangay 1' };
  const routes = new Map([
    ['/regions/130000000/cities-municipalities', { data: [city] }],
    ['/cities-municipalities/138010000/barangays', { items: [barangay] }],
    ['/regions/030000000/provinces/031400000/cities-municipalities', [city]],
    ['/regions/030000000/provinces/031400000/cities-municipalities/138010000/barangays', [barangay]],
    ['/cities-municipalities/138010000', { data: city }]
  ]);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, 'https://psgc.cloud', 'Address mocks must not permit unrelated network calls');
    assert.ok(requestUrl.pathname.startsWith('/api/v2/'));
    const path = requestUrl.pathname.slice('/api/v2'.length);
    assert.ok(routes.has(path), `Unexpected PSGC route: ${path}`);
    calls.push(path);
    return Response.json(routes.get(path));
  };
  try {
    const cases = [
      ['/api/address/cities?region=130000000', '/regions/130000000/cities-municipalities', [city]],
      ['/api/address/cities?region=130000000&province=%20%20', '/regions/130000000/cities-municipalities', [city]],
      ['/api/address/barangays?region=130000000&city=138010000', '/cities-municipalities/138010000/barangays', [barangay]],
      ['/api/address/barangays?region=130000000&province=&city=138010000', '/cities-municipalities/138010000/barangays', [barangay]],
      ['/api/address/cities?region=030000000&province=031400000', '/regions/030000000/provinces/031400000/cities-municipalities', [city]],
      ['/api/address/barangays?region=030000000&province=031400000&city=138010000', '/regions/030000000/provinces/031400000/cities-municipalities/138010000/barangays', [barangay]],
      ['/api/address/cities?region=130000000&province=huc%3A138010000', '/cities-municipalities/138010000', [city]],
      ['/api/address/barangays?region=130000000&province=huc%3A138010000&city=138010000', '/cities-municipalities/138010000/barangays', [barangay]]
    ];
    for (const [path, upstream, expected] of cases) {
      const result = await call(context, path);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.deepEqual(result.data, expected);
      assert.equal(calls.at(-1), upstream);
    }
    const callsBefore = calls.length;
    assert.equal((await call(context, '/api/address/cities')).status, 400);
    assert.equal((await call(context, '/api/address/barangays?region=130000000')).status, 400);
    assert.equal(calls.length, callsBefore, 'Missing required codes must not call the upstream API');
  } finally { globalThis.fetch = originalFetch; }
});

test('no-province address fallback preserves upstream failure status', async t => {
  const context = fixture(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    assert.equal(new URL(url).origin, 'https://psgc.cloud');
    calls.push(String(url));
    return Response.json({ error: 'Upstream unavailable' }, { status: 503 });
  };
  try {
    for (const path of ['/api/address/cities?region=130000000', '/api/address/barangays?region=130000000&city=138010000']) {
      const result = await call(context, path);
      assert.equal(result.status, 503);
      assert.deepEqual(result.data, []);
    }
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

const manilaDistricts = Array.from({ length: 14 }, (_, index) => ({
  code: `13806${String(index + 1).padStart(2, '0')}000`,
  name: `Manila district ${index + 1}`, type: 'SubMun'
}));
const manilaParent = { code: '1380600000', name: 'City of Manila', type: 'City' };
const manilaBarangaysPath = '/api/address/barangays?region=1300000000&city=1380600000';

test('City of Manila keeps its city choice and loads all district barangays with bounded concurrency', async t => {
  const context = fixture(t);
  const regionalCities = [manilaParent, ...manilaDistricts, { code: '1380500000', name: 'City of Mandaluyong', type: 'City' }];
  const firstBarangay = { code: '1380601001', name: 'Barangay 1', city_municipality: 'Tondo I/II' };
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, 'https://psgc.cloud');
    const path = requestUrl.pathname.slice('/api/v2'.length);
    calls.push(path);
    if (path === '/regions/1300000000/cities-municipalities') return Response.json({ data: regionalCities });
    if (path === '/cities-municipalities/1380600000/barangays') return Response.json({ data: [] });
    const district = manilaDistricts.find(item => path === `/cities-municipalities/${item.code}/barangays`);
    assert.ok(district, `Unexpected upstream route: ${path}`);
    assert.ok(options.signal instanceof AbortSignal);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    const item = { code: String(Number(district.code) + 1), name: `Barangay ${district.name}`, city_municipality: district.name };
    return Response.json({ data: [item, firstBarangay] });
  };
  try {
    const cities = await call(context, '/api/address/cities?region=1300000000');
    assert.deepEqual(cities.data, regionalCities, 'The parent city and existing district choices must remain available');
    const callsBefore = calls.length;
    const result = await call(context, manilaBarangaysPath);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.length, 14, 'Duplicate codes from district responses must appear only once');
    assert.deepEqual(new Set(result.data.map(item => item.code)), new Set(manilaDistricts.map(item => String(Number(item.code) + 1))));
    assert.equal(maximumActive, 4, 'The 14 upstream district requests must run in bounded batches');
    assert.equal(calls.length - callsBefore, 16, 'Only the parent, regional list and 14 verified districts may be fetched');
  } finally { globalThis.fetch = originalFetch; }
});

test('Manila district failures and malformed data return errors instead of partial barangay lists', async t => {
  for (const scenario of ['regional-error', 'missing-district', 'wrong-type', 'child-error', 'empty-child', 'malformed-child', 'network-error']) {
    const context = fixture(t);
    let districtCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
      assert.equal(new URL(url).origin, 'https://psgc.cloud');
      const path = new URL(url).pathname.slice('/api/v2'.length);
      if (path === '/cities-municipalities/1380600000/barangays') return Response.json({ data: [] });
      if (path === '/regions/1300000000/cities-municipalities') {
        if (scenario === 'regional-error') return Response.json({ error: 'Unavailable' }, { status: 503 });
        const districts = scenario === 'missing-district' ? manilaDistricts.slice(0, -1) : manilaDistricts.map((item, index) =>
          scenario === 'wrong-type' && index === 0 ? { ...item, type: 'City' } : item);
        return Response.json({ data: [manilaParent, ...districts] });
      }
      const district = manilaDistricts.find(item => path === `/cities-municipalities/${item.code}/barangays`);
      assert.ok(district, `Unexpected upstream route: ${path}`);
      districtCalls++;
      if (district === manilaDistricts[1]) {
        if (scenario === 'child-error') return Response.json({ error: 'Unavailable' }, { status: 503 });
        if (scenario === 'empty-child') return Response.json({ data: [] });
        if (scenario === 'malformed-child') return Response.json({ data: [{ name: 'Missing barangay code' }] });
        if (scenario === 'network-error') throw new TypeError('Network unavailable');
      }
      await new Promise(resolve => setImmediate(resolve));
      return Response.json([{ code: String(Number(district.code) + 1), name: 'Barangay' }]);
    };
    try {
      const result = await call(context, manilaBarangaysPath);
      assert.equal(result.status, ['regional-error', 'child-error'].includes(scenario) ? 503 : 502, scenario);
      assert.equal(Array.isArray(result.data), false, `${scenario} must not return a partial list`);
      assert.match(result.data.error, /Unable to load/);
      if (['regional-error', 'missing-district', 'wrong-type'].includes(scenario)) assert.equal(districtCalls, 0, scenario);
      else assert.ok(districtCalls <= 4, 'Stop scheduling district requests after a failure');
    } finally { globalThis.fetch = originalFetch; }
  }
});

test('Manila aggregation uses a shared 15 second deadline and stops scheduling after expiry', async t => {
  const context = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let districtCalls = 0;
  let aborted = 0;
  let started;
  const fourStarted = new Promise(resolve => { started = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.slice('/api/v2'.length);
    if (path === '/cities-municipalities/1380600000/barangays') return Response.json({ data: [] });
    if (path === '/regions/1300000000/cities-municipalities') return Response.json(manilaDistricts);
    assert.ok(manilaDistricts.some(item => path === `/cities-municipalities/${item.code}/barangays`));
    districtCalls++;
    if (districtCalls === 4) started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted++;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true }));
  };
  try {
    const pending = call(context, manilaBarangaysPath);
    await fourStarted;
    t.mock.timers.tick(14999);
    assert.equal(aborted, 0);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.status, 504);
    assert.equal(districtCalls, 4, 'A shared deadline must prevent later batches from starting');
    assert.equal(aborted, 4);
    assert.equal(Array.isArray(result.data), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Manila fallback is scoped to the canonical empty NCR parent and preserves other address routes', async t => {
  const context = fixture(t);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(new URL(url).pathname);
    return Response.json({ data: [] });
  };
  try {
    for (const path of [
      '/api/address/barangays?region=1300000000&city=1380601000',
      '/api/address/barangays?region=1300000000&city=1380500000',
      '/api/address/barangays?region=0300000000&city=1380600000',
      '/api/address/barangays?region=1300000000&province=1234500000&city=1380600000'
    ]) {
      const before = calls.length;
      const result = await call(context, path);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data, []);
      assert.equal(calls.length - before, 1, 'Ordinary and province routes must not fan out to Manila districts');
    }
    globalThis.fetch = async url => {
      calls.push(new URL(url).pathname);
      return Response.json({ data: [{ code: '1380601001', name: 'Barangay 1' }] });
    };
    const before = calls.length;
    const result = await call(context, manilaBarangaysPath);
    assert.equal(result.status, 200);
    assert.equal(result.data.length, 1);
    assert.equal(calls.length - before, 1, 'A populated parent response must be used directly');
  } finally { globalThis.fetch = originalFetch; }
});

test('checkout calculates catalog prices, design fees and one shipping fee regardless of submitted amounts', async t => {
  const context = fixture(t);
  const result = await call(context, '/api/orders', {
    method: 'POST', body: {
      ...orderBody([{ plan: 'Elite Card', quantity: 2, unit_price: 0, custom_design: true, custom_design_fee: 0 }]),
      subtotal: 0, total: 0, shipping_fee: -999, shipping_zone: 'Mindanao',
      design_request: 'Use the blue logo and center the name'
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.match(result.data.order_id, /^NT-\d{14}-[A-F0-9]{6}$/);
  const saved = context.sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(result.data.order_id);
  assert.equal(saved.subtotal, (499 + 49) * 2);
  assert.equal(saved.total, (499 + 49) * 2 + 70);
  assert.equal(saved.shipping_fee, 70);
  assert.equal(saved.shipping_zone, 'Luzon');
  assert.equal(saved.delivery_region_code, '1300000000');
  assert.equal(result.data.subtotal, saved.subtotal);
  assert.equal(result.data.total, saved.total);
  assert.equal(result.data.shipping_fee, saved.shipping_fee);
  assert.equal(result.data.shipping_zone, saved.shipping_zone);
  assert.equal(result.data.delivery_region_code, saved.delivery_region_code);
  assert.equal(saved.design_request, 'Use the blue logo and center the name');
  const items = JSON.parse(saved.items_json);
  assert.equal(items[0].unit_price, 499);
  assert.equal(items[0].custom_design_fee, 49);
  assert.equal(result.data.notification_status, 'pending');
});

test('new custom artwork uses the trusted 49 fee while historical 69 fees and totals remain unchanged', async t => {
  const context = fixture(t);
  const historicalItems = [{
    plan: 'Elite Card', quantity: 2, unit_price: 499, custom_design: true,
    custom_design_fee: 69, custom_design_image: '', card_name: 'Earlier artwork'
  }];
  const historicalJson = JSON.stringify(historicalItems);
  context.sqlite.prepare(`
    INSERT INTO orders (id, customer_name, items_json, subtotal, total, shipping_fee, shipping_zone, delivery_region_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('historical-custom-69', 'Earlier Customer', historicalJson, (499 + 69) * 2, (499 + 69) * 2 + 70, 70, 'Luzon', '1300000000');
  const historicalBefore = { ...context.sqlite.prepare('SELECT items_json, subtotal, total, shipping_fee FROM orders WHERE id = ?').get('historical-custom-69') };

  for (const submittedFee of [69, 0, -99, 999, 'forged-fee']) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: {
        ...orderBody([{ plan: 'Premium Card', quantity: 2, custom_design: true, custom_design_fee: submittedFee }]),
        subtotal: 1, total: 1
      }
    });
    assert.equal(result.status, 201, `${JSON.stringify(submittedFee)}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.subtotal, (299 + 49) * 2);
    assert.equal(result.data.shipping_fee, 70);
    assert.equal(result.data.total, (299 + 49) * 2 + 70);
    const saved = context.sqlite.prepare('SELECT items_json, subtotal, total FROM orders WHERE id = ?').get(result.data.order_id);
    assert.equal(JSON.parse(saved.items_json)[0].custom_design_fee, 49);
    assert.equal(saved.subtotal, (299 + 49) * 2);
    assert.equal(saved.total, (299 + 49) * 2 + 70);
  }

  const cookie = await adminLogin(context);
  const orders = await call(context, '/api/orders', { cookie });
  assert.equal(orders.status, 200);
  const historical = orders.data.find(item => item.id === 'historical-custom-69');
  assert.ok(historical);
  assert.deepEqual(historical.items, historicalItems);
  assert.equal(historical.subtotal, historicalBefore.subtotal);
  assert.equal(historical.total, historicalBefore.total);
  assert.equal(historical.shipping_fee, 70);
  const confirmed = await call(context, '/api/orders/historical-custom-69', { method: 'PATCH', cookie, body: { status: 'confirmed' } });
  assert.equal(confirmed.status, 200);
  assert.deepEqual({ ...context.sqlite.prepare('SELECT items_json, subtotal, total, shipping_fee FROM orders WHERE id = ?').get('historical-custom-69') }, historicalBefore,
    'Reading and confirming an earlier order must retain its original price snapshot');
});

test('shipping uses every supported PSGC region and ignores customer-submitted fees and zones', async t => {
  const context = fixture(t);
  const zones = [
    ['Luzon', 70, ['01', '02', '03', '04', '05', '13', '14', '17']],
    ['Visayas', 99, ['06', '07', '08', '18']],
    ['Mindanao', 99, ['09', '10', '11', '12', '15', '16', '19']]
  ];
  for (const [zone, fee, prefixes] of zones) {
    for (const prefix of prefixes) {
      const code = `${prefix}00000000`;
      const result = await call(context, '/api/orders', {
        method: 'POST', body: {
          ...orderBody([{ plan: 'Basic Card', quantity: 1 }]), delivery_region_code: code,
          subtotal: -1, total: 0, shipping_fee: 0, shipping_zone: 'Customer supplied zone'
        }
      });
      assert.equal(result.status, 201, `${code}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.subtotal, 199, code);
      assert.equal(result.data.shipping_fee, fee, code);
      assert.equal(result.data.shipping_zone, zone, code);
      assert.equal(result.data.delivery_region_code, code);
      assert.equal(result.data.total, 199 + fee, code);
      const saved = context.sqlite.prepare('SELECT subtotal, total, shipping_fee, shipping_zone, delivery_region_code FROM orders WHERE id = ?').get(result.data.order_id);
      assert.deepEqual({ ...saved }, {
        subtotal: 199, total: 199 + fee, shipping_fee: fee, shipping_zone: zone, delivery_region_code: code
      }, code);
    }
  }
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 19);
});

test('legacy nine-digit region codes normalize and optional city and region codes can use either width', async t => {
  const context = fixture(t);
  const cases = [
    ['130000000', '1300000000', '138060100', '1300000000', 'Luzon', 70],
    ['0600000000', '060000000', '0630101000', '0600000000', 'Visayas', 99],
    ['190000000', '190000000', '193060100', '1900000000', 'Mindanao', 99],
    ['010000000', '0100000000', '012030100', '0100000000', 'Luzon', 70]
  ];
  for (const [submittedCode, region, city, code, zone, fee] of cases) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: { ...orderBody(), delivery_region_code: submittedCode, region, city }
    });
    assert.equal(result.status, 201, `${submittedCode}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.delivery_region_code, code);
    assert.equal(result.data.shipping_zone, zone);
    assert.equal(result.data.shipping_fee, fee);
    assert.equal(result.data.total, 499 + fee);
    const saved = context.sqlite.prepare('SELECT delivery_region_code, shipping_fee FROM orders WHERE id = ?').get(result.data.order_id);
    assert.equal(saved.delivery_region_code, code);
    assert.equal(saved.shipping_fee, fee);
  }
});

test('missing, unknown and malformed delivery regions and conflicting address codes fail before insertion', async t => {
  const context = fixture(t);
  const invalidRegions = [
    undefined, null, '', 'NCR', '13000000000', '13000000', '1300000001', '1310000000',
    '0000000000', '2000000000', '9900000000', '1300000000suffix', '１３００００００００',
    1300000000, true, [], {}
  ];
  const invalidAddressCodes = [
    { region: '0600000000' }, { region: '060000000' }, { region: '1300000001' },
    { region: '' }, { region: null }, { region: 1300000000 }, { region: [] },
    { city: '0630101000' }, { city: '063010100' }, { city: '13806010' },
    { city: '13806010000' }, { city: '138060100x' }, { city: '' }, { city: null },
    { city: 1380601000 }, { city: {} }, { region: '130000000', city: '193060100' }
  ];
  const cases = [
    ...invalidRegions.map(delivery_region_code => ({ delivery_region_code })),
    ...invalidAddressCodes
  ];
  for (const overrides of cases) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: { ...orderBody(), ...overrides, shipping_fee: 0, total: 0 }
    });
    assert.equal(result.status, 400, `${JSON.stringify(overrides)}: ${JSON.stringify(result.data)}`);
    assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0,
      'Invalid region or conflicting address codes must not create an order');
  }
});

test('shipping is charged once for a mixed multi-card order with custom design', async t => {
  const context = fixture(t);
  const items = [
    { plan: 'Basic Card', quantity: 4 },
    { plan: 'Premium Card', quantity: 3, custom_design: true },
    { plan: 'Elite Card', quantity: 2 }
  ];
  const subtotal = 199 * 4 + (299 + 49) * 3 + 499 * 2;
  for (const [code, fee] of [['1300000000', 70], ['1800000000', 99], ['1900000000', 99]]) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: { ...orderBody(items), delivery_region_code: code, shipping_fee: fee * 9, total: 1 }
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.subtotal, subtotal);
    assert.equal(result.data.shipping_fee, fee);
    assert.equal(result.data.total, subtotal + fee);
    const saved = context.sqlite.prepare('SELECT subtotal, total, shipping_fee, items_json FROM orders WHERE id = ?').get(result.data.order_id);
    assert.equal(saved.subtotal, subtotal);
    assert.equal(saved.total, subtotal + fee);
    assert.equal(saved.shipping_fee, fee);
    assert.equal(JSON.parse(saved.items_json)[1].custom_design_fee, 49);
  }
});

test('the same premade catalog design is available on every plan at unchanged prices and shipping', async t => {
  const context = fixture(t);
  const design = CARD_DESIGNS.find(item => item.id === 'A1');
  assert.ok(design, 'The complete A1 front/back pair must be present in the catalog');
  for (const [plan, price] of [['Basic Card', 199], ['Premium Card', 299], ['Elite Card', 499]]) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: orderBody([{
        plan, quantity: 2, design_id: design.id, unit_price: 0, custom_design_fee: 69,
        design_name: 'Untrusted submitted label', design_version: 'untrusted-version',
        design_front: 'javascript:untrusted-front', design_back: 'https://untrusted.example.test/back.jpg'
      }])
    });
    assert.equal(result.status, 201, `${plan}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.subtotal, price * 2, plan);
    assert.equal(result.data.shipping_fee, 70, plan);
    assert.equal(result.data.total, price * 2 + 70, plan);
    const saved = context.sqlite.prepare('SELECT items_json, subtotal, total, shipping_fee FROM orders WHERE id = ?').get(result.data.order_id);
    const [item] = JSON.parse(saved.items_json);
    for (const [key, value] of Object.entries(designSnapshot(design))) assert.equal(item[key], value, `${plan}: ${key}`);
    assert.equal(item.unit_price, price);
    assert.equal(item.custom_design, false);
    assert.equal(item.custom_design_fee, 0);
    assert.equal(saved.subtotal, price * 2);
    assert.equal(saved.shipping_fee, 70);
    assert.equal(saved.total, price * 2 + 70);
  }
});

test('distinct premade designs on the same plan stay separate and all catalog IDs resolve to trusted snapshots', async t => {
  const context = fixture(t);
  const designs = CARD_DESIGNS.slice(0, 2);
  assert.equal(designs.length, 2);
  assert.notEqual(designs[0].id, designs[1].id);
  const result = await call(context, '/api/orders', {
    method: 'POST', body: orderBody(designs.map((design, index) => ({
      plan: 'Basic Card', quantity: index + 2, design_id: design.id
    })))
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const saved = context.sqlite.prepare('SELECT items_json, subtotal, total FROM orders WHERE id = ?').get(result.data.order_id);
  const items = JSON.parse(saved.items_json);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => [item.design_id, item.quantity]), designs.map((design, index) => [design.id, index + 2]));
  assert.equal(saved.subtotal, 199 * 5);
  assert.equal(saved.total, 199 * 5 + 70);

  // Exercise every generated catalog ID through the real route, rather than
  // deriving acceptance from the lookup implementation.
  const all = await call(context, '/api/orders', {
    method: 'POST', body: orderBody(CARD_DESIGNS.map(design => ({ plan: 'Premium Card', quantity: 1, design_id: design.id })))
  });
  assert.equal(all.status, 201, JSON.stringify(all.data));
  const allSaved = JSON.parse(context.sqlite.prepare('SELECT items_json FROM orders WHERE id = ?').get(all.data.order_id).items_json);
  assert.equal(allSaved.length, CARD_DESIGNS.length);
  assert.deepEqual(allSaved.map(item => item.design_id), CARD_DESIGNS.map(design => design.id));
  for (let index = 0; index < CARD_DESIGNS.length; index++) {
    for (const [key, value] of Object.entries(designSnapshot(CARD_DESIGNS[index]))) assert.equal(allSaved[index][key], value);
    assert.equal(allSaved[index].custom_design, false);
    assert.equal(allSaved[index].custom_design_fee, 0, `Premade design ${CARD_DESIGNS[index].id} must not charge a custom artwork fee`);
  }
});

test('unknown, malformed and ambiguous premade selections are rejected before any order is inserted', async t => {
  const context = fixture(t);
  const validId = CARD_DESIGNS[0]?.id;
  assert.ok(validId);
  const invalidIds = [
    validId.toLowerCase(), ` ${validId}`, `${validId} `, 'A0', 'A5', 'A21', 'Q4', 'PN8',
    '__proto__', 'javascript:alert(1)', null, 1, true, {}, []
  ];
  for (const design_id of invalidIds) {
    const result = await call(context, '/api/orders', {
      method: 'POST', body: orderBody([{ plan: 'Basic Card', quantity: 1, design_id }])
    });
    assert.equal(result.status, 400, `${JSON.stringify(design_id)}: ${JSON.stringify(result.data)}`);
    assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
  }
  const mixed = await call(context, '/api/orders', {
    method: 'POST', body: orderBody([
      { plan: 'Basic Card', quantity: 1, design_id: validId },
      { plan: 'Premium Card', quantity: 1, design_id: validId, custom_design: true }
    ])
  });
  assert.equal(mixed.status, 400, JSON.stringify(mixed.data));
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0,
    'A later invalid item must not leave a partially inserted order');
});

test('legacy checkout without a premade selection remains compatible and existing stored item snapshots are unchanged', async t => {
  const context = fixture(t);
  for (const item of [
    { plan: 'Basic Card', quantity: 1 },
    { plan: 'Basic Card', quantity: 1, design_id: '' },
    { plan: 'Basic Card', quantity: 1, design_id: '', custom_design: true }
  ]) {
    const result = await call(context, '/api/orders', { method: 'POST', body: orderBody([item]) });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.subtotal, item.custom_design ? 199 + 49 : 199);
    const [saved] = JSON.parse(context.sqlite.prepare('SELECT items_json FROM orders WHERE id = ?').get(result.data.order_id).items_json);
    assert.ok(!saved.design_id && !saved.design_front && !saved.design_back, 'A legacy request must not be assigned guessed artwork');
  }
  const earlierItems = [
    { plan: 'Basic Card', quantity: 2, unit_price: 199, custom_design: false, custom_design_fee: 0 },
    { plan: 'Elite Card', quantity: 1, unit_price: 499, custom_design: false, custom_design_fee: 0,
      design_id: 'RETIRED-DESIGN', design_name: 'Earlier snapshot', design_version: 'earlier-version',
      design_front: '/earlier/front.jpg', design_back: '/earlier/back.jpg' }
  ];
  const itemsJson = JSON.stringify(earlierItems);
  context.sqlite.prepare('INSERT INTO orders (id, customer_name, items_json, subtotal, total) VALUES (?, ?, ?, ?, ?)')
    .run('earlier-design-order', 'Earlier Customer', itemsJson, 897, 897);
  const cookie = await adminLogin(context);
  const orders = await call(context, '/api/orders', { cookie });
  assert.equal(orders.status, 200);
  const earlier = orders.data.find(item => item.id === 'earlier-design-order');
  assert.ok(earlier);
  assert.deepEqual(earlier.items, earlierItems, 'Listing must not normalize earlier snapshots against today\'s catalog');
  assert.equal(earlier.total, 897);
  assert.equal(context.sqlite.prepare('SELECT items_json FROM orders WHERE id = ?').get('earlier-design-order').items_json, itemsJson);
});

test('checkout rejects unknown products, invalid quantities and excessive item counts without inserting orders', async t => {
  const context = fixture(t);
  const invalidItems = [
    [{ plan: 'Unknown Card', quantity: 1 }], [{ plan: 'Elite Card', quantity: 0 }],
    [{ plan: 'Elite Card', quantity: -1 }], [{ plan: 'Elite Card', quantity: 1.5 }],
    [{ plan: 'Elite Card', quantity: 100 }], [{ plan: 'Elite Card', quantity: 'not-a-number' }],
    [{ plan: 'Elite Card', quantity: 1, custom_design: 'false' }],
    [null], Array.from({ length: 51 }, () => ({ plan: 'Basic Card', quantity: 1 })), []
  ];
  for (const items of invalidItems) {
    const result = await call(context, '/api/orders', { method: 'POST', body: orderBody(items) });
    assert.equal(result.status, 400, JSON.stringify(items).slice(0, 100) + ': ' + JSON.stringify(result.data));
  }
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
});

test('all existing catalog plans and the maximum valid quantity retain their price contracts', async t => {
  const context = fixture(t);
  for (const [plan, price] of [['Basic Card', 199], ['Premium Card', 299], ['Elite Card', 499]]) {
    const result = await call(context, '/api/orders', { method: 'POST', body: orderBody([{ plan, quantity: 99 }]) });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(context.sqlite.prepare('SELECT total FROM orders WHERE id = ?').get(result.data.order_id).total, price * 99 + 70);
  }
});

test('admin order list and status workflow retain fulfillment details and require authentication', async t => {
  const context = fixture(t);
  const result = await call(context, '/api/orders', { method: 'POST', body: orderBody() });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const cookie = await adminLogin(context);
  const orders = await call(context, '/api/orders', { cookie });
  assert.equal(orders.status, 200);
  const order = orders.data.find(item => item.id === result.data.order_id);
  assert.equal(order.card_name, 'Order Customer');
  assert.equal(order.title_role, 'Designer');
  assert.equal(order.subtotal, 499);
  assert.equal(order.total, 569);
  assert.equal(order.shipping_fee, 70);
  assert.equal(order.shipping_zone, 'Luzon');
  assert.equal(order.delivery_region_code, '1300000000');
  const path = `/api/orders/${encodeURIComponent(order.id)}`;
  assert.equal((await call(context, path, { method: 'PATCH', body: { status: 'confirmed' } })).status, 401);
  assert.equal((await call(context, path, { method: 'PATCH', cookie, body: { status: 'unknown' } })).status, 400);
  const confirmed = await call(context, path, { method: 'PATCH', cookie, body: { status: 'confirmed' } });
  assert.equal(confirmed.status, 200);
  assert.equal(context.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'confirmed');
});

test('admin order listing retains legacy totals and exposes zero shipping defaults for earlier orders', async t => {
  const context = fixture(t);
  context.sqlite.prepare(`
    INSERT INTO orders (id, customer_name, items_json, subtotal, total)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-order', 'Earlier Customer', '[]', 199.25, 273.50);
  const cookie = await adminLogin(context);
  const result = await call(context, '/api/orders', { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const order = result.data.find(item => item.id === 'legacy-order');
  assert.ok(order);
  assert.equal(order.subtotal, 199.25);
  assert.equal(order.total, 273.50, 'Existing totals must not be recomputed using a new shipping fee');
  assert.equal(order.shipping_fee, 0);
  assert.equal(order.shipping_zone, '');
  assert.equal(order.delivery_region_code, '');
  assert.equal(context.sqlite.prepare('SELECT total FROM orders WHERE id = ?').get('legacy-order').total, 273.50);
});

test('WhatsApp notification uses a digits-only recipient, the saved amounts and the selected premade design code', async t => {
  const context = fixture(t);
  Object.assign(context.env, { WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: 'test-sender', ADMIN_WHATSAPP_TO: '+63 (917) 123-4567' });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const design = CARD_DESIGNS.find(item => item.id === 'A1');
    assert.ok(design);
    const result = await call(context, '/api/orders', {
      method: 'POST', body: orderBody([{ plan: 'Elite Card', quantity: 1, design_id: design.id, design_name: 'Untrusted notification label' }])
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.notification_status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.to, '639171234567');
    const message = requests[0].body.text.body;
    assert.match(message, /^Subtotal: ₱499\.00$/m);
    assert.match(message, /^Shipping \(Luzon\): ₱70\.00$/m);
    assert.match(message, /^Total: ₱569\.00$/m);
    const itemLine = message.split('\n').find(line => line.includes('Elite Card'));
    assert.match(itemLine, /\bA1\b/, 'The item line must identify the selected design code');
    assert.ok(!message.includes('Untrusted notification label'));
  } finally { globalThis.fetch = originalFetch; }
});

test('valid profile uploads work and type spoofing is rejected before mutation', async t => {
  const context = fixture(t);
  await createClient(context);
  const cookie = await clientLogin(context);
  const photo = await call(context, '/api/client/photo', { method: 'PUT', cookie, body: photoForm(jpegBytes(64)) });
  assert.equal(photo.status, 200, JSON.stringify(photo.data));
  assert.ok(photo.data.photo_url.startsWith('data:image/jpeg;base64,'));
  const before = context.sqlite.prepare('SELECT photo_key, updated_at FROM clients WHERE id = ?').get('client-one');
  const spoofed = await call(context, '/api/client/photo', { method: 'PUT', cookie, body: photoForm(Buffer.from('<script>not an image</script>')) });
  assert.equal(spoofed.status, 400, JSON.stringify(spoofed.data));
  assert.deepEqual(context.sqlite.prepare('SELECT photo_key, updated_at FROM clients WHERE id = ?').get('client-one'), before);
  assert.equal((await call(context, '/api/client/photo', { method: 'DELETE', cookie })).status, 200);
  assert.equal(context.sqlite.prepare('SELECT photo_key FROM clients WHERE id = ?').get('client-one').photo_key, '');
});

test('single JPEG and PNG uploads preserve the existing 1200 KiB upload boundary', async t => {
  const context = fixture(t);
  await createClient(context);
  const cookie = await clientLogin(context);
  for (const [type, bytes] of [['image/jpeg', jpegBytes(1200 * 1024)], ['image/png', pngBytes(1200 * 1024)]]) {
    const result = await call(context, '/api/client/photo', { method: 'PUT', cookie, body: photoForm(bytes, type) });
    assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 200));
    assert.ok(result.data.photo_url.startsWith(`data:${type};base64,`));
    assert.equal(Buffer.from(result.data.photo_url.split(',')[1], 'base64').length, bytes.length);
    assert.equal(context.sqlite.prepare('SELECT photo_key FROM clients WHERE id = ?').get('client-one').photo_key, result.data.photo_url);
  }
});

test('multipart uploads enforce the streaming request limit without Content-Length and stop reading', async t => {
  const context = fixture(t);
  const created = await createClient(context, { photo_key: jpegDataUrl(64) });
  const clientCookie = await clientLogin(context);
  const before = { ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') };
  for (const [path, method, cookie] of [
    ['/api/client/photo', 'PUT', clientCookie], ['/api/client/featured-photo', 'PUT', clientCookie], ['/api/upload', 'POST', created.cookie]
  ]) {
    let pulled = 0;
    let cancelled = false;
    const chunks = [new Uint8Array(1_000_000), new Uint8Array(1_000_001), new Uint8Array(100)];
    const stream = new ReadableStream({
      pull(controller) {
        if (pulled === chunks.length) controller.close();
        else controller.enqueue(chunks[pulled++]);
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const request = new Request(`https://nextap.test${path}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'multipart/form-data; boundary=test-boundary' },
      body: stream, duplex: 'half'
    });
    assert.equal(request.headers.get('Content-Length'), null);
    const response = await worker.fetch(request, context.env);
    assert.equal(response.status, 413, `${method} ${path}: ${await response.text()}`);
    assert.equal(cancelled, true, 'Oversize uploads must cancel the body stream');
    assert.equal(pulled, 2, 'Do not read the tail after exceeding the request cap');
    assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
  }
});

test('malformed multipart uploads return 400 without changing profile data', async t => {
  const context = fixture(t);
  const created = await createClient(context, { photo_key: jpegDataUrl(64), featured_image: jpegDataUrl(64) });
  const clientCookie = await clientLogin(context);
  const before = { ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') };
  for (const [path, method, cookie] of [
    ['/api/client/photo', 'PUT', clientCookie], ['/api/client/featured-photo', 'PUT', clientCookie], ['/api/upload', 'POST', created.cookie]
  ]) {
    const response = await worker.fetch(new Request(`https://nextap.test${path}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'multipart/form-data; boundary=missing-boundary' },
      body: 'This body has no valid multipart boundaries or headers.'
    }), context.env);
    assert.equal(response.status, 400, `${method} ${path}: ${await response.text()}`);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
  }
});

test('aggregate profile image budget rejects writes without changing the original row', async t => {
  const context = fixture(t);
  const existingImage = jpegDataUrl(850_000);
  await createClient(context, { photo_key: existingImage });
  const cookie = await clientLogin(context);
  const before = { ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') };
  const upload = await call(context, '/api/client/featured-photo', { method: 'PUT', cookie, body: photoForm(jpegBytes(850_000)) });
  assert.equal(upload.status, 413, JSON.stringify(upload.data).slice(0, 200));
  assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
  const direct = await call(context, '/api/client/profile', {
    method: 'PUT', cookie, body: { name: 'Should not persist', featured_image: jpegDataUrl(850_000) }
  });
  assert.equal(direct.status, 413, JSON.stringify(direct.data).slice(0, 200));
  assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
});

test('order image aggregate and individual image budgets reject requests without truncation or insertion', async t => {
  const context = fixture(t);
  // Under the request cap, but over the total database row budget.
  const sameImage = jpegDataUrl(700_000);
  const items = [
    { plan: 'Premium Card', quantity: 1, custom_design: true, custom_design_image: sameImage },
    { plan: 'Elite Card', quantity: 1, custom_design: true, custom_design_image: sameImage }
  ];
  const aggregate = await call(context, '/api/orders', { method: 'POST', body: orderBody(items) });
  assert.equal(aggregate.status, 413, JSON.stringify(aggregate.data).slice(0, 200));
  const oversized = await call(context, '/api/orders', {
    method: 'POST', body: orderBody([{ plan: 'Elite Card', quantity: 1, custom_design: true, custom_design_image: jpegDataUrl(1_300_000) }])
  });
  assert.equal(oversized.status, 413, JSON.stringify(oversized.data).slice(0, 200));
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
});

test('admin image edits validate direct values before writing any profile fields', async t => {
  const context = fixture(t);
  const created = await createClient(context);
  const before = { ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') };
  const result = await call(context, '/api/clients', {
    method: 'PUT', cookie: created.cookie,
    body: { ...created.payload, name: 'Should not persist', photo_key: 'data:image/jpeg;base64,PHNjcmlwdD4=' }
  });
  assert.equal(result.status, 400, JSON.stringify(result.data));
  assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
});

test('admin object module edits include the retained photo in the complete database row budget', async t => {
  const context = fixture(t);
  const created = await createClient(context, { photo_key: jpegDataUrl(850_000) });
  const before = { ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') };
  const body = {
    id: 'client-one', slug: 'client-one', name: 'Should not persist', email: 'one@example.test',
    profile_modules: { media: 'x'.repeat(800_000) }
  };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2_000_000, 'Exercise the stored row guard, not the request guard');
  const result = await call(context, '/api/clients', { method: 'PUT', cookie: created.cookie, body });
  assert.equal(result.status, 413, JSON.stringify(result.data));
  assert.deepEqual({ ...context.sqlite.prepare('SELECT * FROM clients WHERE id = ?').get('client-one') }, before);
});

test('invalid JSON bodies and non-object request bodies produce safe client errors', async t => {
  const context = fixture(t);
  const cookie = await adminLogin(context);
  for (const path of ['/api/orders', '/api/clients']) {
    for (const body of ['{invalid json', 'null', '[]']) {
      const response = await worker.fetch(new Request(`https://nextap.test${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body
      }), context.env);
      assert.equal(response.status, 400, `${path}: ${body}`);
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
  assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS count FROM clients WHERE id = ?').get('client-one').count, 0);
});

test('admin uploads enforce image format and size before returning a database image value', async t => {
  const context = fixture(t);
  const cookie = await adminLogin(context);
  const valid = await call(context, '/api/upload', { method: 'POST', cookie, body: photoForm(jpegBytes(64)) });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  assert.equal(valid.data.key, valid.data.url);
  const wrong = await call(context, '/api/upload', { method: 'POST', cookie, body: photoForm(Buffer.from('<svg></svg>'), 'image/svg+xml') });
  assert.equal(wrong.status, 400, JSON.stringify(wrong.data));
  const oversized = await call(context, '/api/upload', { method: 'POST', cookie, body: photoForm(jpegBytes(1_300_000)) });
  assert.equal(oversized.status, 413, JSON.stringify(oversized.data).slice(0, 200));
});

test('all shipped JavaScript files and executable HTML script blocks parse', async t => {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.wrangler', 'work', 'tests'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:html|js|mjs)$/.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  let scripts = 0;
  const failures = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const sources = file.endsWith('.html')
      ? [...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
          .filter(match => !/\bsrc\s*=/.test(match[1]) && (!/\btype\s*=/.test(match[1]) || /\btype\s*=\s*["']?(?:module|text\/javascript|application\/javascript)\b/i.test(match[1])))
          .map((match, index) => ({ source: match[2], label: `${relative(root, file)} script ${index + 1}`, module: /\bmodule\b/.test(match[1]) }))
      : [{ source: content, label: relative(root, file), module: file.endsWith('.mjs') || file.startsWith(join(root, 'src') + sep) || /(?:content-(?:limits|plan-ui)|client-workspace|profile-links|admin[/\\]editor)\.js$/.test(file) }];
    for (const item of sources) {
      if (!item.source.trim()) continue;
      scripts++;
      const result = spawnSync(process.execPath, ['--check', `--input-type=${item.module ? 'module' : 'commonjs'}`], { input: item.source, encoding: 'utf8' });
      if (result.status !== 0) failures.push(`${item.label}\n${result.stderr}`);
    }
  }
  assert.ok(scripts >= 20, `Expected all app script blocks, checked ${scripts}`);
  assert.deepEqual(failures, [], failures.join('\n'));
  t.diagnostic(`Parsed ${scripts} JavaScript files and executable HTML script blocks.`);
});
