const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/client-login.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

class Element {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.type = 'text';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
  }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  emit(type, values = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    event.results = (this.listeners[type] || []).map(handler => handler(event));
    return event;
  }
  focus() { this.onFocus?.(); this.emit('focus'); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 250 }; }
}

function loginPage(options = {}) {
  const elements = Object.fromEntries(['crew', 'email', 'pw', 'eye', 'loginForm', 'loginFields', 'submit', 'err', 'forgot'].map(id => [id, new Element()]));
  elements.crew.dataset.mood = 'idle';
  elements.pw.type = 'password';
  elements.email.value = options.identifier || '';
  elements.pw.value = options.password || '';
  elements.loginFields.disabled = true;
  elements.eye.setAttribute('aria-pressed', 'false');
  elements.eye.setAttribute('aria-label', 'Show password');
  elements.email.setAttribute('aria-invalid', 'false');
  elements.pw.setAttribute('aria-invalid', 'false');
  elements.loginForm.setAttribute('aria-busy', 'false');
  const document = { getElementById: id => elements[id], activeElement: null };
  for (const element of Object.values(elements)) element.onFocus = () => { document.activeElement = element; };
  const window = new Element();
  window.matchMedia = query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return { matches: Boolean(options.reducedMotion) }; };
  const location = { href: '/client-login' };
  const requests = [];
  const context = vm.createContext({ document, window, location });
  Object.defineProperty(document, 'cookie', { get() { assert.fail('Login must leave session cookies to the server'); } });
  Object.defineProperty(context, 'localStorage', { get() { assert.fail('Login must not store credentials or session tokens'); } });
  Object.defineProperty(context, 'sessionStorage', { get() { assert.fail('Login must not store credentials or session tokens'); } });
  if (!options.noFetch) context.fetch = async (url, init) => {
    requests.push({ url, init });
    assert.ok(['/api/client-auth/me', '/api/client-auth/login'].includes(url), 'Only the existing auth APIs may be requested');
    if (url === '/api/client-auth/me') return options.sessionFetch ? options.sessionFetch(init) : response({ authenticated: false });
    return options.loginFetch ? options.loginFetch(init) : response({ ok: true });
  };
  vm.runInContext(source, context, { filename: 'client-login.html' });
  return {
    elements, document, window, location, requests,
    async submit() { const event = elements.loginForm.emit('submit'); await Promise.all(event.results); return event; }
  };
}

test('login markup offers real support and policy destinations with safe no-JavaScript POST semantics', () => {
  const form = html.match(/<form\b[^>]*\bid="loginForm"[^>]*>/)[0];
  assert.match(form, /\bmethod="post"/);
  assert.match(form, /\baction="\/api\/client-auth\/login"/);
  assert.match(form, /\baria-busy="false"/);
  assert.match(html, /<fieldset\b[^>]*\bid="loginFields"[^>]*\bdisabled\b/);
  assert.match(html, /<noscript>[\s\S]*?JavaScript is needed to sign in[\s\S]*?mailto:nextapph@gmail\.com/);
  for (const id of ['email', 'pw']) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))[0];
    assert.doesNotMatch(input, /\bname=/, 'Native fallback must not submit credentials or put them in a URL');
    assert.match(input, /\brequired\b/);
    assert.match(input, /\baria-invalid="false"/);
    assert.match(input, /\baria-describedby="[^"]*\berr\b/);
    assert.match(input, new RegExp(`\\bmaxlength="${id === 'email' ? 254 : 256}"`));
    assert.match(input, new RegExp(`\\bautocomplete="${id === 'email' ? 'username' : 'current-password'}"`));
  }
  assert.match(html, /<button\b[^>]*\bid="eye"[^>]*\baria-controls="pw"[^>]*\baria-pressed="false"/);
  assert.match(html, /<div\b[^>]*\bid="err"[^>]*\brole="alert"/);
  const body = html.slice(html.indexOf('<body>'));
  assert.doesNotMatch(body, /\bid="(?:remember|googleLogin)"|Remember for 30 days|Log in with Google|href="#forgot"/);
  assert.match(body, /up to 7 days/);
  assert.match(body, /Sign out on shared or public devices/);
  assert.match(body, /Ordering a card does not automatically create a client login/);
  assert.match(body, /Never send your password by email/);
  const mails = [...body.matchAll(/href="(mailto:[^"]+)"/g)].map(match => new URL(match[1]));
  assert.ok(mails.length >= 3);
  for (const mail of mails) {
    assert.equal(mail.pathname, 'nextapph@gmail.com');
    assert.equal(mail.searchParams.has('body'), false, 'Support links must not prefill any credentials');
    assert.ok(mail.searchParams.get('subject'));
  }
  assert.ok(mails.some(mail => /password reset/i.test(mail.searchParams.get('subject'))));
  assert.ok(mails.some(mail => /account activation/i.test(mail.searchParams.get('subject'))));
  const footer = body.match(/<footer\b[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /<nav\b[^>]*\baria-label=/);
  for (const file of ['privacy.html', 'terms.html', 'security.html', 'data-deletion.html']) {
    assert.ok(fs.existsSync(path.join(root, 'public', file)));
    assert.match(footer, new RegExp(`href="/${file.replace('.', '\\.')}"`));
  }
  assert.match(body, /class="client-brand" href="\/"/);
  assert.doesNotMatch(body, /newestlogo\.png/);
  assert.match(html, /href="\/client-support\.css"/);
  const css = fs.readFileSync(path.join(root, 'public/client-support.css'), 'utf8');
  assert.match(css, /\.client-footer nav\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.client-footer a\{[^}]*min-height:44px/);
  assert.match(css, /:focus-visible/);
});

test('existing login aesthetic stays in its original inline CSS block', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(css).digest('hex'), 'ae3bc63845b1ef6ba1b056ee9d18364899b716df2a9e0f010694ad1b9db4e0ed');
});

test('existing session check only redirects a confirmed authenticated response and has no sign-in side effects', async () => {
  for (const [sessionFetch, authenticated] of [
    [() => response({ authenticated: true, redirect: 'https://untrusted.example' }), true],
    [() => response({ authenticated: false }), false],
    [() => response({ authenticated: 'true' }), false],
    [() => response({ authenticated: true }, 401), false],
    [() => ({ ok: true, json: async () => { throw new Error('Malformed session response'); } }), false],
    [() => { throw new Error('Network unavailable'); }, false]
  ]) {
    const page = loginPage({ sessionFetch }); await settle();
    assert.equal(page.location.href, authenticated ? '/client-dashboard' : '/client-login');
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].url, '/api/client-auth/me');
    assert.equal(page.requests[0].init.credentials, 'same-origin');
    assert.equal(page.elements.err.textContent, '');
    assert.equal(page.elements.loginFields.disabled, false);
  }
});

test('missing and oversized details receive accessible validation before a credential request', async () => {
  for (const item of [
    { identifier: '   ', password: '', invalid: ['email', 'pw'], focus: 'email', error: /Please enter/ },
    { identifier: 'user@example.test', password: '', invalid: ['pw'], focus: 'pw', error: /Please enter/ },
    { identifier: '', password: 'password', invalid: ['email'], focus: 'email', error: /Please enter/ },
    { identifier: 'x'.repeat(255), password: 'password', invalid: ['email'], focus: 'email', error: /too long/ },
    { identifier: 'user@example.test', password: 'x'.repeat(257), invalid: ['pw'], focus: 'pw', error: /too long/ }
  ]) {
    const page = loginPage(item); await settle();
    const event = await page.submit();
    assert.equal(event.defaultPrevented, true);
    assert.equal(page.requests.length, 1, 'Validation must not send a login attempt');
    assert.match(page.elements.err.textContent, item.error);
    for (const id of ['email', 'pw']) assert.equal(page.elements[id].getAttribute('aria-invalid'), String(item.invalid.includes(id)));
    assert.equal(page.document.activeElement, page.elements[item.focus]);
    assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'false');
    assert.equal(page.elements.submit.disabled, false);
    page.elements[item.focus].emit('input');
    assert.equal(page.elements[item.focus].getAttribute('aria-invalid'), 'false');
  }
});

test('successful login sends only same-origin JSON credentials and navigates to the fixed dashboard', async () => {
  const password = '  exact-password-not-trimmed  ';
  const page = loginPage({ identifier: '  +63 917 123 4567  ', password }); await settle();
  const event = await page.submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.requests.length, 2);
  const { url, init } = page.requests[1];
  assert.equal(url, '/api/client-auth/login');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { identifier: '+63 917 123 4567', password });
  assert.equal(page.location.href, '/client-dashboard');
  assert.equal(page.elements.pw.value, '');
  assert.equal(page.elements.err.textContent, '');
  assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'false');
  assert.equal(page.elements.loginFields.disabled, false);
  assert.equal(page.elements.submit.disabled, false);
  assert.equal(page.elements.submit.textContent, 'Log in');
});

test('a pending request disables the form and prevents duplicate login attempts until completion', async () => {
  let finish;
  const page = loginPage({ identifier: 'user@example.test', password: 'password', loginFetch: () => new Promise(resolve => { finish = resolve; }) });
  await settle();
  const first = page.elements.loginForm.emit('submit');
  assert.equal(page.elements.loginFields.disabled, true);
  assert.equal(page.elements.submit.disabled, true);
  assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'true');
  assert.equal(page.elements.submit.textContent, 'Logging in…');
  const duplicate = await page.submit();
  assert.equal(duplicate.defaultPrevented, true);
  assert.equal(page.requests.length, 2);
  finish(response({ ok: true })); await Promise.all(first.results);
  assert.equal(page.elements.loginFields.disabled, false);
  assert.equal(page.elements.submit.disabled, false);
  assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'false');
});

test('HTTP failures use safe status-specific advice without reading internal error bodies and allow retry', async () => {
  const cases = [[401, /do not match an active account/], [429, /Too many sign-in attempts/], [400, /Please check/], [403, /Refresh this page/], [500, /temporarily unavailable/], [503, /temporarily unavailable/]];
  for (const [status, message] of cases) {
    let attempt = 0;
    const page = loginPage({ identifier: 'user@example.test', password: 'password', loginFetch: () => ++attempt === 1 ? {
      ok: false, status, json() { assert.fail('Internal error bodies must not be read or shown'); }
    } : response({ ok: true }) });
    await settle(); await page.submit();
    assert.equal(page.location.href, '/client-login');
    assert.match(page.elements.err.textContent, message);
    assert.equal(page.elements.err.innerHTML, '');
    assert.equal(page.elements.loginFields.disabled, false);
    assert.equal(page.elements.submit.disabled, false);
    assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'false');
    for (const id of ['email', 'pw']) assert.equal(page.elements[id].getAttribute('aria-invalid'), String(status === 401));
    await page.submit();
    assert.equal(page.location.href, '/client-dashboard');
    assert.equal(page.elements.err.textContent, '');
    assert.equal(page.elements.email.getAttribute('aria-invalid'), 'false');
  }
});

test('network and malformed success responses fail safely and restore the form', async () => {
  for (const loginFetch of [
    () => { throw new Error('PRIVATE password:password database detail'); },
    () => ({ ok: true, json: async () => { throw new Error('PRIVATE invalid JSON'); } }),
    () => response({ ok: false, error: 'PRIVATE SQL detail' }),
    () => response({ ok: 'true', redirect: 'https://untrusted.example' }),
    () => response(null)
  ]) {
    const page = loginPage({ identifier: 'user@example.test', password: 'password', loginFetch }); await settle(); await page.submit();
    assert.equal(page.location.href, '/client-login');
    assert.match(page.elements.err.textContent, /Unable to complete sign-in/);
    assert.doesNotMatch(page.elements.err.textContent, /PRIVATE|SQL|password:|untrusted/);
    assert.equal(page.elements.submit.disabled, false);
    assert.equal(page.elements.loginFields.disabled, false);
    assert.equal(page.elements.loginForm.getAttribute('aria-busy'), 'false');
    assert.equal(page.elements.pw.value, 'password');
  }
});

test('show-password toggle exposes accurate pressed state, preserves credentials and supports keyboard click', async () => {
  const page = loginPage({ password: 'do not change this' }); await settle();
  const { pw, eye, crew } = page.elements;
  pw.focus(); assert.equal(crew.dataset.mood, 'hidden');
  assert.equal(eye.emit('mousedown').defaultPrevented, true);
  eye.emit('click');
  assert.equal(pw.type, 'text');
  assert.equal(eye.getAttribute('aria-label'), 'Hide password');
  assert.equal(eye.getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.activeElement, pw);
  assert.equal(crew.dataset.mood, 'exposed');
  eye.emit('click');
  assert.equal(pw.type, 'password');
  assert.equal(eye.getAttribute('aria-label'), 'Show password');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  assert.equal(pw.value, 'do not change this');
  assert.equal(crew.dataset.mood, 'hidden');
  assert.equal(page.requests.length, 1);
});

test('reduced motion omits pointer-driven animation and support links keep native email navigation', async () => {
  const page = loginPage({ reducedMotion: true }); await settle();
  assert.equal(page.window.listeners.pointermove, undefined);
  page.elements.email.focus();
  assert.equal(page.elements.crew.dataset.mood, 'email');
  assert.equal(page.elements.crew.style['--px'], undefined);
  assert.equal(page.elements.forgot.emit('click').defaultPrevented, false);
  assert.equal(page.requests.length, 1);
});

test('a browser without fetch keeps credential fields disabled and offers safe support advice', () => {
  const page = loginPage({ noFetch: true });
  assert.equal(page.elements.loginFields.disabled, true);
  assert.match(page.elements.err.textContent, /updated browser or email NexTap support/);
  assert.equal(page.requests.length, 0);
  assert.equal(page.location.href, '/client-login');
});
