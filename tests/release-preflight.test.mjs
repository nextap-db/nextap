import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, writeSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedDatabaseId, verifyProductionIdentity, localCloneConfig, privateRunner,
  captureOriginalData, verifyOriginalData, auditDataBudgets, enforceDataBudgets, cleanupPrivateStage, commandDiagnostic, restorePrivateExport
} from '../scripts/stage-release.mjs';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const fixture = t => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT, view_count INTEGER, photo_key TEXT, featured_image TEXT); CREATE TABLE orders (id TEXT PRIMARY KEY, items_json TEXT, total REAL)");
  db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)').run('private-id', 'private-client-name', 123n, 'https://example.test/photo', '');
  db.prepare('INSERT INTO orders VALUES (?,?,?)').run('private-order', '[]', 499);
  t.after(() => db.close());
  return db;
};

test('release preflight rejects the wrong configured or live D1 and legacy storage', () => {
  assert.equal(verifyProductionIdentity(config, { uuid: expectedDatabaseId, version: 'production' }).binding, 'DB');
  for (const info of [{ uuid: 'other-db', version: 'production' }, { uuid: expectedDatabaseId, version: 'alpha' }, { uuid: expectedDatabaseId }]) {
    assert.throws(() => verifyProductionIdentity(config, info), /could not be verified/);
  }
  assert.throws(() => verifyProductionIdentity({ ...config, name: 'other-worker' }, { uuid: expectedDatabaseId, version: 'production' }));
  assert.throws(() => verifyProductionIdentity({ ...config, d1_databases: [{ binding: 'DB', database_name: 'nextap-db', database_id: 'other-db' }] }, { uuid: expectedDatabaseId, version: 'production' }));
});

test('local clone configuration includes generated credentials and excludes production notifications/routes', () => {
  const clone = localCloneConfig({ ...config, vars: { RESEND_API_KEY: 'private-production-key', ADMIN_PASSWORD: 'private-password' }, routes: ['production.example/*'] }, 'synthetic-admin', 'synthetic-client');
  assert.deepEqual(clone.vars, { ADMIN_PASSWORD: 'synthetic-admin', CLIENT_AUTH_SECRET: 'synthetic-client' });
  assert.equal(clone.routes, undefined);
  assert.equal(clone.d1_databases.length, 1);
  assert.equal(clone.d1_databases[0].remote, undefined);
  assert.ok(!JSON.stringify(clone).includes('private-production-key'));
});

test('original-column fingerprints accept additive schema/defaults without altering existing records', t => {
  const db = fixture(t);
  const baseline = captureOriginalData(db);
  db.exec("ALTER TABLE clients ADD COLUMN education TEXT DEFAULT ''; CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER)");
  assert.deepEqual(verifyOriginalData(db, baseline), { clients: 1, orders: 1 });
  assert.ok(!JSON.stringify(baseline).includes('private-client-name'));
  assert.ok(!JSON.stringify(baseline).includes('private-id'));
});

test('changing original data, removing a row, or adding a row fails integrity without exposing values', t => {
  const db = fixture(t);
  const baseline = captureOriginalData(db);
  db.exec("UPDATE clients SET name='secret-new-value' WHERE id='private-id'");
  assert.throws(() => verifyOriginalData(db, baseline), error => !error.message.includes('secret-new-value') && /data changed/.test(error.message));
  db.exec("UPDATE clients SET name='private-client-name'; DELETE FROM orders");
  assert.throws(() => verifyOriginalData(db, baseline), /data changed/);
  db.prepare('INSERT INTO orders VALUES (?,?,?)').run('private-order', '[]', 499);
  db.prepare('INSERT INTO clients VALUES (?,?,?,?,?)').run('unexpected-demo', 'Unexpected', 0, '', '');
  assert.throws(() => verifyOriginalData(db, baseline), /data changed/);
});

test('budget checks return only aggregate counts and block oversized/invalid existing data', t => {
  const db = fixture(t);
  assert.deepEqual(auditDataBudgets(db), { oversizedProfiles: 0, oversizedOrders: 0, oversizedImages: 0, invalidOrderItems: 0 });
  db.prepare('UPDATE clients SET photo_key=?').run('data:image/jpeg;base64,' + 'A'.repeat(200));
  db.prepare('UPDATE orders SET items_json=?').run('{invalid-private-content');
  const audit = auditDataBudgets(db, { rowBytes: 100, imageBytes: 50 });
  assert.deepEqual(audit, { oversizedProfiles: 1, oversizedOrders: 0, oversizedImages: 1, invalidOrderItems: 1 });
  assert.throws(() => enforceDataBudgets(audit), error => /needs attention/.test(error.message) && !error.message.includes('private') && !error.message.includes('data:image'));
});

test('private command output and signed URLs stay in private files on command failure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nextap-release-'));
  t.after(() => cleanupPrivateStage(directory, tmpdir()));
  const secret = 'https://download.example.test/private-signed-url';
  const run = privateRunner(directory, {
    spawnImpl: (_bin, _args, options) => {
      assert.equal(typeof options.stdio[1], 'number');
      assert.equal(typeof options.stdio[2], 'number');
      writeSync(options.stdio[1], secret);
      writeSync(options.stdio[2], 'SQL with private client data');
      return { status: 1, error: new Error(secret) };
    }
  });
  assert.throws(() => run('unused', [], 'Private export'), error => /Private export failed/.test(error.message) && !error.message.includes(secret));
  assert.equal(readFileSync(join(directory, 'command-1.stdout'), 'utf8'), secret);
  assert.equal(readFileSync(join(directory, 'command-1.stderr'), 'utf8'), 'SQL with private client data');
});

test('command diagnostics publish fixed categories without echoing private command data', () => {
  assert.equal(commandDiagnostic('SQLITE_ERROR private-client-row https://private.test/token'), 'sql-import');
  assert.equal(commandDiagnostic('no such file: private-secret-path'), 'missing-file-or-module');
  assert.equal(commandDiagnostic('private download URL and private row'), 'command-failure');
  assert.equal(commandDiagnostic('private output', 'ETIMEDOUT'), 'timeout');
});

test('private SQLite restore preserves large inline image values beyond the D1 SQL statement limit', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nextap-release-'));
  t.after(() => cleanupPrivateStage(directory, tmpdir()));
  const image = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(180000);
  const sqlFile = join(directory, 'synthetic.sql');
  const databasePath = join(directory, 'isolated.sqlite');
  writeFileSync(sqlFile, "CREATE TABLE clients (id TEXT PRIMARY KEY, photo_key TEXT); INSERT INTO clients VALUES ('synthetic', '" + image + "');");
  restorePrivateExport(databasePath, sqlFile);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT photo_key FROM clients').get().photo_key, image); }
  finally { db.close(); }
  writeFileSync(sqlFile, "not valid SQL private-content");
  assert.throws(() => restorePrivateExport(databasePath, sqlFile), error => !error.message.includes('private-content') && !error.stack.includes('private-content'));
});

test('private stage cleanup rejects parent/unrelated paths and removes only its checked temporary child', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nextap-release-'));
  assert.throws(() => cleanupPrivateStage(tmpdir(), tmpdir()), /Unsafe/);
  assert.throws(() => cleanupPrivateStage(join(tmpdir(), 'unrelated'), tmpdir()), /Unsafe/);
  cleanupPrivateStage(directory, tmpdir());
  assert.equal(existsSync(directory), false);
});
