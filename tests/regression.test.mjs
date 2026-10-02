import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
    card_name: 'Order Customer', title_role: 'Designer', delivery_address: '123 Test Street, Manila', items
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

test('checkout calculates catalog prices and custom design fees regardless of submitted prices or total', async t => {
  const context = fixture(t);
  const result = await call(context, '/api/orders', {
    method: 'POST', body: {
      ...orderBody([{ plan: 'Elite Card', quantity: 2, unit_price: 0, custom_design: true, custom_design_fee: 0 }]),
      subtotal: 0, total: 0, design_request: 'Use the blue logo and center the name'
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.match(result.data.order_id, /^NT-\d{14}-[A-F0-9]{6}$/);
  const saved = context.sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(result.data.order_id);
  assert.equal(saved.subtotal, (499 + 69) * 2);
  assert.equal(saved.total, (499 + 69) * 2);
  assert.equal(saved.design_request, 'Use the blue logo and center the name');
  const items = JSON.parse(saved.items_json);
  assert.equal(items[0].unit_price, 499);
  assert.equal(items[0].custom_design_fee, 69);
  assert.equal(result.data.notification_status, 'pending');
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
    assert.equal(context.sqlite.prepare('SELECT total FROM orders WHERE id = ?').get(result.data.order_id).total, price * 99);
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
  assert.equal(order.total, 499);
  const path = `/api/orders/${encodeURIComponent(order.id)}`;
  assert.equal((await call(context, path, { method: 'PATCH', body: { status: 'confirmed' } })).status, 401);
  assert.equal((await call(context, path, { method: 'PATCH', cookie, body: { status: 'unknown' } })).status, 400);
  const confirmed = await call(context, path, { method: 'PATCH', cookie, body: { status: 'confirmed' } });
  assert.equal(confirmed.status, 200);
  assert.equal(context.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'confirmed');
});

test('formatted WhatsApp notification recipient is sent as digits', async t => {
  const context = fixture(t);
  Object.assign(context.env, { WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: 'test-sender', ADMIN_WHATSAPP_TO: '+63 (917) 123-4567' });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await call(context, '/api/orders', { method: 'POST', body: orderBody() });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.notification_status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.to, '639171234567');
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
      : [{ source: content, label: relative(root, file), module: file.endsWith('.mjs') || file.endsWith(join('src', 'index.js')) }];
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
