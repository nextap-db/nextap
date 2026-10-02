import { randomBytes, randomUUID } from 'node:crypto';

class StagedSmokeError extends Error {}

function fail(step, status) {
  const suffix = Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
  throw new StagedSmokeError(`Staged Worker smoke failed at ${step}${suffix}.`);
}

function localOrigin(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { fail('local target validation'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('local target validation');
  }
  return url.origin;
}

function sessionCookie(response, name, step) {
  try {
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie?.startsWith(`${name}=`) || cookie.length <= name.length + 1) fail(step);
    return cookie;
  } catch { fail(step); }
}

// Call only against the isolated, local Wrangler Worker bound to the staged D1
// clone. The caller must omit notification credentials from that Worker.
// No response bodies, identifiers, credentials, or cookies are logged/returned.
export async function smokeStagedWorker(baseUrl, adminPassword, { fetchImpl = fetch } = {}) {
  try {
    const origin = localOrigin(baseUrl);
    if (typeof adminPassword !== 'string' || !adminPassword || typeof fetchImpl !== 'function') fail('local configuration');
    const token = randomUUID();
    const id = `stage-smoke-${token}`;
    const email = `${id}@example.test`;
    const name = `Staged Smoke ${token}`;
    const password = randomBytes(32).toString('base64url');
    const jobTitle = 'Staged smoke profile update';
    let checks = 0;

    async function call(step, path, { method = 'GET', cookie, body, expectedStatus = 200 } = {}) {
      try {
        const headers = { 'Cache-Control': 'no-cache' };
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetchImpl(new URL(path, origin), {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000)
        });
        if (response.status !== expectedStatus) fail(step, response.status);
        const data = await response.json();
        checks++;
        return { response, data };
      } catch (error) {
        if (error instanceof StagedSmokeError) throw error;
        fail(step);
      }
    }

    const adminLogin = await call('admin sign-in', '/api/auth/login', {
      method: 'POST', body: { password: adminPassword }
    });
    if (adminLogin.data?.ok !== true) fail('admin sign-in');
    const adminCookie = sessionCookie(adminLogin.response, 'nextap_admin', 'admin session');

    const initialOrders = await call('authenticated order read', '/api/orders', { cookie: adminCookie });
    if (!Array.isArray(initialOrders.data)) fail('authenticated order read');

    const created = await call('synthetic client creation', '/api/clients', {
      method: 'POST', cookie: adminCookie,
      body: { id, slug: id, name, email, phone: '09170000000', card_type: 'gold', client_login_password: password }
    });
    if (created.data?.id !== id || created.data?.email !== email || created.data?.name !== name) fail('synthetic client creation');

    const clientLogin = await call('client sign-in', '/api/client-auth/login', {
      method: 'POST', body: { identifier: email, password }
    });
    if (clientLogin.data?.ok !== true || clientLogin.data?.client?.id !== id) fail('client sign-in');
    const clientCookie = sessionCookie(clientLogin.response, 'nextap_client', 'client session');

    const changed = await call('client profile update', '/api/client/profile', {
      method: 'PUT', cookie: clientCookie, body: { job_title: jobTitle }
    });
    if (changed.data?.id !== id || changed.data?.job_title !== jobTitle) fail('client profile update');

    // GET does not increment profile views; only this synthetic profile is read.
    const published = await call('synthetic public profile read', `/api/clients/${encodeURIComponent(id)}`);
    if (published.data?.id !== id || published.data?.name !== name || published.data?.job_title !== jobTitle) fail('synthetic public profile read');

    const order = await call('synthetic checkout', '/api/orders', {
      method: 'POST', expectedStatus: 201,
      body: {
        customer_name: name, customer_email: email, customer_phone: '09170000000',
        delivery_address: 'Isolated staging smoke test address', delivery_region_code: '1300000000', card_name: name,
        title_role: jobTitle, contact_preference: 'email', items: [{ plan: 'Elite Card', quantity: 1 }]
      }
    });
    if (order.data?.ok !== true || typeof order.data?.order_id !== 'string' ||
        !/^NT-\d{14}-[A-F0-9]{6}$/.test(order.data.order_id) || order.data?.notification_status !== 'pending') fail('synthetic checkout');
    const orderId = order.data.order_id;

    function syntheticOrder(data, step, expectedState) {
      if (!Array.isArray(data)) fail(step);
      const row = data.find(item => item?.id === orderId);
      if (!row || row.customer_email !== email || row.card_name !== name || row.title_role !== jobTitle ||
          row.total !== 569 || row.subtotal !== 499 || row.shipping_fee !== 70 ||
          row.shipping_zone !== 'Luzon' || row.delivery_region_code !== '1300000000' || row.status !== expectedState ||
          row.notification_status !== 'pending' || !Array.isArray(row.items) || row.items.length !== 1 ||
          row.items[0]?.plan !== 'Elite Card' || row.items[0]?.quantity !== 1 || row.items[0]?.unit_price !== 499) fail(step);
    }

    const savedOrder = await call('synthetic order persistence', '/api/orders', { cookie: adminCookie });
    syntheticOrder(savedOrder.data, 'synthetic order persistence', 'new');

    const confirmed = await call('synthetic order confirmation', `/api/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH', cookie: adminCookie, body: { status: 'confirmed' }
    });
    if (confirmed.data?.ok !== true || confirmed.data?.status !== 'confirmed') fail('synthetic order confirmation');

    const verified = await call('synthetic order status persistence', '/api/orders', { cookie: adminCookie });
    syntheticOrder(verified.data, 'synthetic order status persistence', 'confirmed');
    return { ok: true, checks, syntheticClients: 1, syntheticOrders: 1 };
  } catch (error) {
    if (error instanceof StagedSmokeError) throw error;
    fail('local smoke execution');
  }
}
