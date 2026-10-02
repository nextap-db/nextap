import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { loadMigrations, parseMigration, reconcile, splitSql } from '../scripts/reconcile-d1.mjs';

const migrations = loadMigrations();
const database = () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const query = async sql => {
    calls.push(sql);
    return splitSql(sql).map(statement => db.prepare(statement).all());
  };
  return { db, query, calls };
};

test('all raw migrations bootstrap SQLite and support the Worker client insert', () => {
  const { db } = database();
  for (const m of migrations) for (const op of m.operations) db.exec(op.sql);
  const worker = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const match = worker.match(/INSERT INTO clients\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/);
  assert.ok(match, 'client insert located');
  const columns = match[1].split(',').map(c => c.trim());
  assert.equal(columns.length, (match[2].match(/\?/g) || []).length);
  const insert = db.prepare(`INSERT INTO clients (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  const values = columns.map(c => ({ id: 'schema-check', slug: 'schema-check', name: 'Schema check', active: 1 }[c] ?? ''));
  insert.run(...values);
  assert.equal(db.prepare("SELECT name FROM clients WHERE id = 'schema-check'").get().name, 'Schema check');
  db.close();
});

test('fresh reconciliation verifies schema, tracks history, and is idempotent', async () => {
  const { db, query, calls } = database();
  const first = await reconcile(query, migrations, { apply: true });
  assert.equal(first.changed.length, migrations.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, migrations.length);
  const history = db.prepare('SELECT * FROM d1_migrations ORDER BY id').all();
  calls.length = 0;
  assert.deepEqual(await reconcile(query, migrations, { apply: true }), { pending: [], changed: [] });
  assert.ok(calls.every(sql => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/i.test(sql.trim())));
  assert.deepEqual(db.prepare('SELECT * FROM d1_migrations ORDER BY id').all(), history);
  db.close();
});

test('manual columns and partially recorded migrations preserve client data and history IDs', async () => {
  const { db, query } = database();
  for (const m of migrations.slice(0, 1)) for (const op of m.operations) db.exec(op.sql);
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  db.exec("INSERT INTO d1_migrations (id, name) VALUES (80, '0003_add_social_links.sql'), (81, 'unknown-legacy.sql')");
  db.exec("ALTER TABLE clients ADD COLUMN tiktok TEXT DEFAULT ''; ALTER TABLE clients ADD COLUMN card_type TEXT DEFAULT 'basic'; ALTER TABLE clients ADD COLUMN education TEXT DEFAULT ''");
  db.exec("INSERT INTO clients (id,slug,name,education,tiktok) VALUES ('keep','keep','Do not alter','Existing education','Existing link')");
  await reconcile(query, migrations, { apply: true });
  const preserved = db.prepare("SELECT * FROM clients WHERE id='keep'").get();
  assert.equal(preserved.education, 'Existing education');
  assert.equal(preserved.tiktok, 'Existing link');
  assert.equal(db.prepare("SELECT id FROM d1_migrations WHERE name='0003_add_social_links.sql'").get().id, 80);
  assert.equal(db.prepare("SELECT id FROM d1_migrations WHERE name='unknown-legacy.sql'").get().id, 81);
  assert.ok(db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === 'youtube'));
  assert.ok(db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === 'show_business_inquiry'));
  db.close();
});

test('read-only check identifies repairs without creating schema or history', async () => {
  const { db, query, calls } = database();
  const result = await reconcile(query);
  assert.equal(result.pending.length, migrations.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  assert.ok(calls.every(sql => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/i.test(sql.trim())));
  db.close();
});

test('an incompatible manually added column fails before any mutation', async () => {
  const { db, query, calls } = database();
  db.exec(migrations[0].operations[0].sql);
  db.exec('ALTER TABLE clients ADD COLUMN card_type INTEGER DEFAULT 0');
  await assert.rejects(reconcile(query, migrations, { apply: true }), /Incompatible schema for clients.card_type/);
  assert.ok(calls.every(sql => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/i.test(sql.trim())));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='d1_migrations'").get().n, 0);
  db.close();
});

test('a manually created base table without required slug uniqueness fails before writes', async () => {
  const { db, query, calls } = database();
  db.exec(migrations[0].operations[0].sql.replace('slug TEXT NOT NULL UNIQUE', 'slug TEXT NOT NULL'));
  await assert.rejects(reconcile(query, migrations, { apply: true }), /Incompatible schema for clients.slug/);
  assert.ok(calls.every(sql => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/i.test(sql.trim())));
  db.close();
});

test('failed schema verification does not mark that migration applied; retry can repair', async () => {
  const { db, query } = database();
  const discardAlter = async sql => /ALTER TABLE clients ADD COLUMN tiktok/.test(sql) ? [[]] : query(sql);
  await assert.rejects(reconcile(discardAlter, migrations, { apply: true }), /Verification failed for 0003/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0003_add_social_links.sql'").get().n, 0);
  await reconcile(query, migrations, { apply: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, migrations.length);
  db.close();
});

test('intentionally removed seed profile is not recreated after recorded migration', async () => {
  const { db, query } = database();
  await reconcile(query, migrations, { apply: true });
  db.exec("DELETE FROM clients WHERE id='christian-abrazaldo'");
  await reconcile(query, migrations, { apply: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 0);
  db.close();
});

test('existing client data without seed history is baselined without adding the demo', async () => {
  const { db, query } = database();
  for (const op of migrations[0].operations) db.exec(op.sql);
  db.exec("INSERT INTO clients (id,slug,name) VALUES ('real-client','real-client','Existing client')");
  const log = [];
  await reconcile(query, migrations, { apply: true, log: message => log.push(message) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
  assert.equal(db.prepare("SELECT name FROM clients WHERE id='real-client'").get().name, 'Existing client');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE id='christian-abrazaldo'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0002_seed_christian.sql'").get().n, 1);
  assert.ok(log.some(message => message.includes('Baseline: 0002_seed_christian.sql')));
  await reconcile(query, migrations, { apply: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
  db.close();
});

test('existing customized demo is retained when its historical seed record is missing', async () => {
  const { db, query } = database();
  for (const op of migrations[0].operations) db.exec(op.sql);
  db.exec("INSERT INTO clients (id,slug,name) VALUES ('christian-abrazaldo','customized','Customized client')");
  await reconcile(query, migrations, { apply: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
  assert.equal(db.prepare("SELECT slug,name FROM clients WHERE id='christian-abrazaldo'").get().name, 'Customized client');
  assert.equal(db.prepare("SELECT slug FROM clients WHERE id='christian-abrazaldo'").get().slug, 'customized');
  db.close();
});

test('unexpected migration SQL requires explicit reconciler support', () => {
  assert.throws(() => parseMigration('future.sql', 'DROP TABLE clients;'), /Unsupported operation/);
  assert.deepEqual(splitSql("INSERT INTO t VALUES ('with;comma,inside'); -- ignored\n SELECT 1;"), ["INSERT INTO t VALUES ('with;comma,inside')", 'SELECT 1']);
});
