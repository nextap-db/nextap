import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeStagedWorker } from '../scripts/smoke-staged-worker.mjs';

const baseUrl = 'http://127.0.0.1:8788';
const adminPassword = 'test-only-private-admin-password';

function mockWorker({ failAt, failure } = {}) {
  const calls = [];
  let client;
  let order;
  const existingOrder = { id: 'private-existing-order-id', customer_name: 'Private existing customer', total: 199 };
  const orderId = 'NT-20261002000000-ABC123';
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, baseUrl);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ path: url.pathname, method: options.method, cookie: options.headers.Cookie, body });
    if (calls.length === failAt) return failure({ body, client, order });
    switch (calls.length) {
      case 1:
        assert.equal(url.pathname, '/api/auth/login');
        assert.equal(body.password, adminPassword);
        return Response.json({ ok: true }, { headers: { 'set-cookie': 'nextap_admin=test-admin-cookie; Path=/; HttpOnly; Secure' } });
      case 2:
        assert.equal(url.pathname, '/api/orders');
        assert.equal(options.headers.Cookie, 'nextap_admin=test-admin-cookie');
        return Response.json([existingOrder]);
      case 3:
        assert.equal(url.pathname, '/api/clients');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Cookie, 'nextap_admin=test-admin-cookie');
        assert.match(body.id, /^stage-smoke-[a-f0-9-]{36}$/);
        assert.equal(body.slug, body.id);
        assert.equal(body.email, `${body.id}@example.test`);
        assert.ok(body.client_login_password.length >= 32);
        client = { ...body };
        return Response.json(client);
      case 4:
        assert.equal(url.pathname, '/api/client-auth/login');
        assert.equal(body.identifier, client.email);
        assert.equal(body.password, client.client_login_password);
        assert.equal(options.headers.Cookie, undefined);
        return Response.json({ ok: true, client }, { headers: { 'set-cookie': 'nextap_client=test-client-cookie; Path=/; HttpOnly; Secure' } });
      case 5:
        assert.equal(url.pathname, '/api/client/profile');
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers.Cookie, 'nextap_client=test-client-cookie');
        client = { ...client, ...body };
        return Response.json(client);
      case 6:
        assert.equal(url.pathname, `/api/clients/${client.id}`);
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Cookie, undefined);
        return Response.json(client);
      case 7:
        assert.equal(url.pathname, '/api/orders');
        assert.equal(options.method, 'POST');
        assert.equal(body.customer_email, client.email);
        assert.equal(body.card_name, client.name);
        assert.equal(body.title_role, client.job_title);
        assert.ok(body.customer_phone && body.delivery_address && body.contact_preference);
        assert.deepEqual(body.items, [{ plan: 'Elite Card', quantity: 1 }]);
        order = {
          ...body, id: orderId, total: 499, subtotal: 499, status: 'new', notification_status: 'pending',
          items: [{ ...body.items[0], unit_price: 499 }]
        };
        return Response.json({ ok: true, order_id: orderId, notification_status: 'pending' }, { status: 201 });
      case 8:
      case 10:
        assert.equal(url.pathname, '/api/orders');
        assert.equal(options.headers.Cookie, 'nextap_admin=test-admin-cookie');
        return Response.json([existingOrder, order]);
      case 9:
        assert.equal(url.pathname, `/api/orders/${orderId}`);
        assert.equal(options.method, 'PATCH');
        assert.equal(options.headers.Cookie, 'nextap_admin=test-admin-cookie');
        assert.deepEqual(body, { status: 'confirmed' });
        order.status = body.status;
        return Response.json({ ok: true, status: 'confirmed' });
      default:
        assert.fail('Unexpected local smoke request');
    }
  };
  return { calls, fetchImpl };
}

test('local smoke exercises authenticated profile and checkout persistence with sanitized results', async () => {
  const fixture = mockWorker();
  const result = await smokeStagedWorker(baseUrl, adminPassword, fixture);
  assert.deepEqual(result, { ok: true, checks: 10, syntheticClients: 1, syntheticOrders: 1 });
  assert.equal(fixture.calls.length, 10);
  assert.equal(fixture.calls.some(call => call.path.includes('private-existing-order-id') || call.path.endsWith('/view')), false);
  assert.equal(JSON.stringify(result).includes('stage-smoke-'), false);
  const second = mockWorker();
  await smokeStagedWorker(baseUrl, adminPassword, second);
  assert.notEqual(fixture.calls[2].body.id, second.calls[2].body.id);
  assert.notEqual(fixture.calls[2].body.email, second.calls[2].body.email);
  assert.notEqual(fixture.calls[2].body.client_login_password, second.calls[2].body.client_login_password);
});

test('remote URLs and URL credentials are rejected before any requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('Must not request'); };
  for (const target of [
    'https://nextap.digitalprofile.workers.dev', 'http://127.0.0.1.example.test:8788',
    'http://private-user:private-pass@127.0.0.1:8788', `${baseUrl}/api`, `${baseUrl}/?secret=private`, 'private-invalid-url'
  ]) {
    await assert.rejects(smokeStagedWorker(target, adminPassword, { fetchImpl }), {
      message: 'Staged Worker smoke failed at local target validation.'
    });
  }
  assert.equal(requests, 0);
});

test('HTTP failures do not read or expose private response bodies', async () => {
  let bodyRead = false;
  const fixture = mockWorker({ failAt: 2, failure: () => ({
    status: 500,
    async json() { bodyRead = true; throw new Error('private-database-row'); }
  }) });
  await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), {
    message: 'Staged Worker smoke failed at authenticated order read (HTTP 500).'
  });
  assert.equal(bodyRead, false);
  assert.equal(fixture.calls.length, 2);
});

test('transport and JSON errors discard the original error and its private details', async () => {
  for (const failure of [
    () => { throw new Error(`private-network-error ${adminPassword}`); },
    () => ({ status: 200, async json() { throw new Error('private-row-parse-error'); } })
  ]) {
    const fixture = mockWorker({ failAt: 2, failure });
    await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), error => {
      assert.equal(error.message, 'Staged Worker smoke failed at authenticated order read.');
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes('private-'), false);
      return true;
    });
  }
});

test('missing authentication cookie aborts before reading client data', async () => {
  const fixture = mockWorker({ failAt: 1, failure: () => Response.json({ ok: true }) });
  await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), {
    message: 'Staged Worker smoke failed at admin session.'
  });
  assert.equal(fixture.calls.length, 1);
});

test('checkout with an active notification sender fails with a sanitized error', async () => {
  const fixture = mockWorker({ failAt: 7, failure: () => Response.json({
    ok: true, order_id: 'NT-20261002000000-ABC123', notification_status: 'sent'
  }, { status: 201 }) });
  await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), {
    message: 'Staged Worker smoke failed at synthetic checkout.'
  });
  assert.equal(fixture.calls.length, 7);
});

test('persisted price mismatch fails without including order or existing row details', async () => {
  const fixture = mockWorker({ failAt: 8, failure: ({ order }) => Response.json([
    { id: 'private-existing-order-id', customer_name: 'private-existing-name' }, { ...order, total: 0 }
  ]) });
  await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), {
    message: 'Staged Worker smoke failed at synthetic order persistence.'
  });
  assert.equal(fixture.calls.length, 8);
});

test('successful PATCH must also persist the confirmed status', async () => {
  const fixture = mockWorker({ failAt: 10, failure: ({ order }) => Response.json([{ ...order, status: 'new' }]) });
  await assert.rejects(smokeStagedWorker(baseUrl, adminPassword, fixture), {
    message: 'Staged Worker smoke failed at synthetic order status persistence.'
  });
});
