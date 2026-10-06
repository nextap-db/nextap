import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildContactCard, contactFilename } = await import(pathToFileURL(join(root, 'src', 'contact-card.js')).href);
const { default: worker } = await import(pathToFileURL(join(root, 'src', 'index.js')).href);
const migrations = (await readdir(join(root, 'migrations')))
  .filter(name => name.endsWith('.sql') && !name.includes('_seed_')).sort();
const migrationSources = await Promise.all(migrations.map(name => readFile(join(root, 'migrations', name), 'utf8')));
const unfold = card => card.replace(/\r\n[ \t]/g, '');

function fixture(t, overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  migrationSources.forEach(source => sqlite.exec(source));
  t.after(() => sqlite.close());
  const client = {
    id: 'synthetic-contact-id', slug: 'fictional-contact', name: 'Fictional Contact',
    company: 'Fictional Company', job_title: 'Designer', email: 'fictional@example.test',
    phone: '09171234567', whatsapp: '09171234567', viber: '+639171234567',
    website: 'https://example.test/profile;details?one=1&two=2#intro',
    instagram: '@fictional', facebook: 'facebook.com/fictional',
    telegram: '@fictional_contact', steam: '76561198000000001',
    active: 1, view_count: 17, last_viewed_at: '2001-01-01T00:00:00.000Z', content_revision: 11,
    login_password_hash: 'synthetic-private-hash', login_password_salt: 'synthetic-private-salt',
    about: 'synthetic-private-about', photo_key: 'synthetic-private-photo',
    education: 'synthetic-hidden-education', show_education: 0,
    services: 'synthetic-hidden-services', show_services: 0,
    featured_enabled: 0, featured_description: 'synthetic-hidden-featured',
    profile_modules: JSON.stringify({ media: 'synthetic-hidden-module', games: 'synthetic-hidden-game' }),
    profile_module_visibility: JSON.stringify({ media: false, games: false }),
    ...overrides
  };
  const columns = Object.keys(client);
  sqlite.prepare(`INSERT INTO clients (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(key => client[key]));
  const writes = [];
  const env = {
    ADMIN_PASSWORD: 'synthetic-contact-admin', CLIENT_AUTH_SECRET: 'synthetic-contact-session',
    ASSETS: { async fetch() { throw new Error('Contact API must not load a page asset'); } },
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let parameters = [];
        const adapter = {
          bind(...values) { parameters = values; return adapter; },
          async first(column) { const row = statement.get(...parameters); return row ? (column ? row[column] : { ...row }) : null; },
          async all() { return { success: true, results: statement.all(...parameters).map(row => ({ ...row })) }; },
          async run() {
            writes.push(sql);
            const result = statement.run(...parameters);
            return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          }
        };
        return adapter;
      }
    }
  };
  return { sqlite, client, env, writes };
}

function snapshot(context) {
  return {
    clients: context.sqlite.prepare('SELECT * FROM clients ORDER BY id').all(),
    orders: context.sqlite.prepare('SELECT * FROM orders ORDER BY id').all(),
    rates: context.sqlite.prepare('SELECT * FROM auth_rate_limits ORDER BY key').all(),
    changes: context.sqlite.prepare('SELECT total_changes() AS n').get().n
  };
}

async function request(context, path) {
  const response = await worker.fetch(new Request('https://contact.test' + path), context.env);
  return { response, text: await response.text() };
}

test('vCard text escapes delimiters, slashes and all newline forms without allowing property injection', () => {
  const card = buildContactCard({
    name: 'Fictional;Name, Jr\\Test\r\nTeam\rEND:VCARD\nBEGIN:VCARD',
    company: 'Example;Co, Inc\\Office\rBranch\u0000', job_title: 'Research\nDevelopment'
  });
  const logical = unfold(card);
  assert.ok(logical.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'));
  assert.ok(logical.endsWith('END:VCARD\r\n'));
  assert.ok(logical.includes('N:;Fictional\\;Name\\, Jr\\\\Test\\nTeam\\nEND:VCARD\\nBEGIN:VCARD;;;\r\n'));
  assert.ok(logical.includes('ORG:Example\\;Co\\, Inc\\\\Office\\nBranch\r\n'));
  assert.ok(logical.includes('TITLE:Research\\nDevelopment\r\n'));
  assert.equal(logical.split('\r\n').filter(line => line === 'BEGIN:VCARD').length, 1);
  assert.equal(logical.split('\r\n').filter(line => line === 'END:VCARD').length, 1);
  assert.doesNotMatch(card.replace(/\r\n/g, ''), /[\r\n\u0000]/);
  // Splitting only unescaped separators verifies all five N components.
  const n = logical.split('\r\n').find(line => line.startsWith('N:')).slice(2);
  assert.equal(n.split(/(?<!\\);/).length, 5);
});

test('vCard folds complete Unicode characters into physical lines of at most 75 UTF-8 bytes and unfolds losslessly', () => {
  const name = 'Fictional ' + '文😀é'.repeat(35);
  const company = 'Office ' + '界'.repeat(80);
  const card = buildContactCard({ name, company });
  const physical = card.split('\r\n').filter(Boolean);
  assert.ok(physical.some(line => line.startsWith(' ')), 'The long fields must actually exercise folding');
  for (const line of physical) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `Physical line is ${Buffer.byteLength(line, 'utf8')} bytes`);
    assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
  const logical = unfold(card);
  assert.ok(logical.includes('FN:' + name + '\r\n'));
  assert.ok(logical.includes('ORG:' + company + '\r\n'));
});

test('vCard URL values preserve URI delimiters while phone and messaging values become usable links', () => {
  const website = 'https://example.test/path;param?one=1,two=2&name=Fictional#details';
  const card = unfold(buildContactCard({
    name: 'Fictional Contact', phone: '0917 123 4567', website,
    whatsapp: 'https://wa.me/639171234567?text=Hello%20Fictional', viber: '+1 (415) 555-2671',
    facebook: 'facebook.com/fictional.profile', telegram: '@fictional_contact',
    steam: '76561198000000001', twitter: '@fictional_contact'
  }));
  assert.ok(card.includes('URL:' + website + '\r\n'));
  assert.ok(card.includes('TEL;TYPE=CELL:+639171234567\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=whatsapp:https://wa.me/639171234567?text=Hello%20Fictional\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=viber:viber://chat?number=%2B14155552671\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=facebook:https://facebook.com/fictional.profile\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=telegram:https://t.me/fictional_contact\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=steam:https://steamcommunity.com/profiles/76561198000000001\r\n'));
  assert.ok(card.includes('X-SOCIALPROFILE;TYPE=x:https://x.com/fictional_contact\r\n'));
  assert.doesNotMatch(card, /\\[;,]/, 'URI semicolons and commas are not text-field escapes');
});

test('vCard omits unsafe URLs, malformed phones and unrelated private or content fields', () => {
  const card = unfold(buildContactCard({
    name: 'Fictional', website: 'javascript:alert(1)', facebook: 'data:text/html,unsafe',
    phone: '0917ABC4567', whatsapp: 'https://evil.example.test/639171234567',
    login_password_hash: 'private-hash-marker', login_password_salt: 'private-salt-marker',
    content_revision: 99999, view_count: 88888, last_viewed_at: 'private-view-marker',
    featured_description: 'private-featured-marker', services: 'private-services-marker',
    profile_modules: { media: 'private-module-marker' }, about: 'private-about-marker'
  }));
  assert.doesNotMatch(card, /^(?:URL|TEL|X-SOCIALPROFILE)/m);
  assert.doesNotMatch(card, /private-|99999|88888|content_revision|password|profile_modules/);
});

test('contact filenames are bounded ASCII names without header or path injection', () => {
  assert.equal(contactFilename({ slug: 'fictional-profile', id: 'other' }), 'fictional-profile.vcf');
  assert.equal(contactFilename({ id: 'fictional-id' }), 'fictional-id.vcf');
  assert.equal(contactFilename({}), 'contact.vcf');
  const filename = contactFilename({ slug: '../"\r\nInjected: bad; 名' + 'a'.repeat(120) });
  assert.match(filename, /^[a-z0-9_-]{1,80}\.vcf$/i);
  assert.ok(filename.length <= 84);
});

test('public contact endpoint serves the same active fictional profile by both ID and slug without auth or database writes', async t => {
  const context = fixture(t);
  const before = snapshot(context);
  const byId = await request(context, '/api/clients/' + context.client.id + '/contact.vcf');
  const bySlug = await request(context, '/api/clients/' + context.client.slug + '/contact.vcf');
  for (const result of [byId, bySlug]) {
    assert.equal(result.response.status, 200, result.text);
    assert.match(result.response.headers.get('Content-Type'), /^text\/vcard;\s*charset=utf-8$/i);
    assert.equal(result.response.headers.get('Content-Disposition'), 'inline; filename="fictional-contact.vcf"');
    assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.response.headers.get('CDN-Cache-Control'), 'no-store');
    assert.equal(result.response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(result.response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(result.response.headers.get('Set-Cookie'), null);
    assert.ok(unfold(result.text).includes('FN:Fictional Contact\r\n'));
    assert.ok(unfold(result.text).includes('TEL;TYPE=CELL:+639171234567\r\n'));
    assert.doesNotMatch(result.text, /synthetic-private|synthetic-hidden|content_revision|view_count|last_viewed_at/);
  }
  assert.equal(byId.text, bySlug.text);
  assert.deepEqual(snapshot(context), before, 'Downloads must not count views, mutate profiles, create orders or rate-limit rows');
  assert.deepEqual(context.writes, []);
});

test('download=1 requests attachment disposition, while other values retain inline contact import', async t => {
  const context = fixture(t);
  for (const [query, disposition] of [['?download=1', 'attachment'], ['?download=0', 'inline'], ['?download=true', 'inline']]) {
    const result = await request(context, '/api/clients/fictional-contact/contact.vcf' + query);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('Content-Disposition'), disposition + '; filename="fictional-contact.vcf"');
    assert.ok(result.text.startsWith('BEGIN:VCARD\r\n'));
  }
  assert.deepEqual(context.writes, []);
});

test('unknown, encoded injection-like and inactive contact keys return 404 without exposing a contact or mutating data', async t => {
  const context = fixture(t, { active: 0 });
  const before = snapshot(context);
  for (const key of [context.client.id, context.client.slug, 'unknown-profile', encodeURIComponent("' OR 1=1 --")]) {
    const result = await request(context, '/api/clients/' + key + '/contact.vcf');
    assert.equal(result.response.status, 404, result.text);
    assert.equal(result.response.headers.get('Content-Disposition'), null);
    assert.doesNotMatch(result.text, /VCARD|Fictional|synthetic-private|synthetic-hidden/);
    assert.equal(result.response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  assert.deepEqual(snapshot(context), before);
  assert.deepEqual(context.writes, []);
});
