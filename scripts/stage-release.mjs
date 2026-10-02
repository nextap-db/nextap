import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { smokeStagedWorker } from './smoke-staged-worker.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const expectedDatabaseId = '48390df3-9688-485c-a5ba-06484248fba6';
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const privateWrite = (path, content) => writeFileSync(path, content, { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let currentPhase = 'configuration';
const phase = label => { currentPhase = label; console.log('Release preflight: ' + label + '.'); };
const diagnosticCodes = new Set(['timeout', 'missing-file-or-module', 'invalid-cli-option', 'internal-database-metadata', 'sql-statement-size', 'sql-transaction', 'sql-constraint', 'sql-import', 'local-runtime', 'filesystem-access', 'command-failure']);

export function commandDiagnostic(output, code) {
  if (code === 'ETIMEDOUT') return 'timeout';
  if (/ENOENT|no such file|cannot find module|could not resolve/i.test(output)) return 'missing-file-or-module';
  if (/unknown argument|unknown option|invalid argument/i.test(output)) return 'invalid-cli-option';
  if (/_cf_KV|_cf_METADATA/i.test(output)) return 'internal-database-metadata';
  if (/statement too (long|large)|string or blob too big|SQLITE_TOOBIG/i.test(output)) return 'sql-statement-size';
  if (/transaction|SAVEPOINT/i.test(output)) return 'sql-transaction';
  if (/constraint failed/i.test(output)) return 'sql-constraint';
  if (/SQLITE|SQL.*error|D1_ERROR|already exists|no such table|syntax error/i.test(output)) return 'sql-import';
  if (/MiniflareCoreError|runtime failed to start|workerd/i.test(output)) return 'local-runtime';
  if (/EACCES|EPERM|permission denied/i.test(output)) return 'filesystem-access';
  return 'command-failure';
}

export function verifyProductionIdentity(config, info) {
  const binding = config.d1_databases?.find(db => db.binding === 'DB');
  if (config.name !== 'nextap' || !binding || binding.database_name !== 'nextap-db' || binding.database_id !== expectedDatabaseId || info?.uuid !== expectedDatabaseId || info?.version !== 'production') {
    throw new Error('Production Worker/D1 identity or production storage backend could not be verified.');
  }
  return binding;
}

export function localCloneConfig(config, adminPassword, clientSecret) {
  return {
    name: 'nextap-private-release-stage',
    main: resolve(root, config.main),
    compatibility_date: config.compatibility_date,
    assets: { ...config.assets, directory: resolve(root, config.assets.directory) },
    d1_databases: [{ binding: 'DB', database_name: 'nextap-db', database_id: expectedDatabaseId }],
    vars: { ADMIN_PASSWORD: adminPassword, CLIENT_AUTH_SECRET: clientSecret }
  };
}

// All command output stays in private temporary files: Wrangler export prints
// a signed download URL, and failed SQL imports can include private row values.
export function privateRunner(directory, { env = process.env, spawnImpl = spawnSync } = {}) {
  let sequence = 0;
  return (executable, args, label, overrides = {}) => {
    const prefix = join(directory, 'command-' + ++sequence);
    const stdoutPath = prefix + '.stdout', stderrPath = prefix + '.stderr';
    const out = openSync(stdoutPath, 'w', 0o600), err = openSync(stderrPath, 'w', 0o600);
    let result;
    try {
      result = spawnImpl(executable, args, {
        cwd: root, windowsHide: true, timeout: 180_000,
        env: { ...env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler-private.log'), ...overrides },
        stdio: ['ignore', out, err]
      });
    } catch { throw new Error(label + ' failed; private command output was not published.');
    } finally { closeSync(out); closeSync(err); }
    if (result.error || result.status !== 0) {
      const error = new Error(label + ' failed; private command output was not published.');
      error.safeDiagnostic = commandDiagnostic(readFileSync(stdoutPath, 'utf8') + '\n' + readFileSync(stderrPath, 'utf8'), result.error?.code);
      throw error;
    }
    return readFileSync(stdoutPath, 'utf8');
  };
}

function sqliteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sqliteFiles(path) : entry.isFile() && entry.name.endsWith('.sqlite') ? [path] : [];
  });
}

function findCloneDatabase(stateDirectory) {
  const candidates = sqliteFiles(stateDirectory).filter(path => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clients'").get()); }
    finally { db.close(); }
  });
  if (candidates.length !== 1) throw new Error('The isolated D1 import did not create exactly one client database.');
  return candidates[0];
}

// Restore the private dump directly into the isolated SQLite file. Wrangler's
// SQL request path limits statement length, including inline image literals.
// This never targets the remote database and retains the dump's full values.
export function restorePrivateExport(databasePath, exportFile, initializationTable) {
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(readFileSync(exportFile, 'utf8'));
    if (initializationTable) db.exec(`DROP TABLE ${quote(initializationTable)}`);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Foreign key constraint failed in private restore.');
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (cause) {
    const error = new Error('Private local SQLite restore failed; private SQL was not published.');
    error.safeDiagnostic = commandDiagnostic(String(cause?.message || ''), cause?.code);
    throw error;
  } finally { db?.close(); }
}

function tableFingerprint(db, table, columns) {
  const hash = createHash('sha256');
  const statement = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY id`);
  statement.setReadBigInts(true);
  let count = 0;
  for (const row of statement.iterate()) {
    const values = columns.map(column => {
      const value = row[column];
      return value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : [typeof value, typeof value === 'bigint' ? String(value) : value];
    });
    hash.update(JSON.stringify(values) + '\n'); count++;
  }
  return { columns, count, hash: hash.digest('hex') };
}

export function captureOriginalData(db) {
  const baseline = {};
  for (const table of ['clients', 'orders']) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
    baseline[table] = columns.length ? tableFingerprint(db, table, columns) : null;
  }
  if (!baseline.clients) throw new Error('Production clone has no clients table; release staging stopped.');
  return baseline;
}

export function verifyOriginalData(db, baseline) {
  try {
    for (const [table, expected] of Object.entries(baseline)) {
      if (!expected) continue;
      const actual = tableFingerprint(db, table, expected.columns);
      if (actual.count !== expected.count || actual.hash !== expected.hash) throw new Error();
    }
  } catch { throw new Error('Existing client/order data changed during local schema reconciliation.'); }
  return { clients: baseline.clients.count, orders: baseline.orders?.count || 0 };
}

export function auditDataBudgets(db, { rowBytes = 1_800_000, imageBytes = 1_700_000 } = {}) {
  const audit = { oversizedProfiles: 0, oversizedOrders: 0, oversizedImages: 0, invalidOrderItems: 0 };
  for (const table of ['clients', 'orders']) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE name=? AND type='table'").get(table);
    if (!exists) continue;
    const statement = db.prepare(`SELECT * FROM ${quote(table)}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      const size = Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(String(value ?? ''), 'utf8'), 0);
      if (size > rowBytes) audit[table === 'clients' ? 'oversizedProfiles' : 'oversizedOrders']++;
      let images = [row.photo_key, row.featured_image];
      if (table === 'orders') {
        try {
          const items = JSON.parse(row.items_json || '[]');
          if (!Array.isArray(items)) throw new Error();
          images = items.map(item => item?.custom_design_image);
        } catch { audit.invalidOrderItems++; images = []; }
      }
      audit.oversizedImages += images.filter(image => typeof image === 'string' && image.startsWith('data:') && Buffer.byteLength(image, 'utf8') > imageBytes).length;
    }
  }
  return audit;
}

export function enforceDataBudgets(audit) {
  if (Object.values(audit).some(count => count > 0)) throw new Error(`Existing clone data needs attention before release: ${JSON.stringify(audit)}. No production schema was changed.`);
}

export function cleanupPrivateStage(directory, parent) {
  if (dirname(resolve(directory)) !== resolve(parent) || !basename(directory).startsWith('nextap-release-')) throw new Error('Unsafe temporary cleanup path rejected.');
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopWorker(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(5_000)]);
}

export async function stageLocalCopy({ exportFile, directory, config, run = privateRunner(directory), log = console.log, onPhase = label => log('Release preflight: ' + label + '.') }) {
  const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const state = join(directory, 'isolated-state'), configPath = join(directory, 'wrangler.local.json');
  const adminPassword = randomBytes(32).toString('hex');
  const localConfig = localCloneConfig(config, adminPassword, randomBytes(32).toString('hex'));
  privateWrite(configPath, JSON.stringify(localConfig));
  const localArgs = ['--local', '--config', configPath, '--persist-to', state];
  onPhase('private clone initialization');
  const initializationTable = '__nextap_private_restore_' + randomBytes(16).toString('hex');
  run(process.execPath, [wrangler, 'd1', 'execute', 'nextap-db', ...localArgs, '--command', `CREATE TABLE ${quote(initializationTable)} (ready INTEGER)`, '--json'], 'Private local initialization');
  const initialized = sqliteFiles(state).filter(path => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(initializationTable)); }
    finally { db.close(); }
  });
  if (initialized.length !== 1) throw new Error('Isolated local D1 did not initialize exactly one marked SQLite database.');
  onPhase('private clone import');
  restorePrivateExport(initialized[0], exportFile, initializationTable);
  const databasePath = findCloneDatabase(state);
  let database = new DatabaseSync(databasePath, { readOnly: true });
  let baseline;
  try { baseline = captureOriginalData(database); } finally { database.close(); }
  onPhase('local schema reconciliation');
  run(process.execPath, [join(root, 'scripts', 'reconcile-d1.mjs'), '--local', '--apply', '--config', configPath, '--persist-to', state], 'Local clone reconciliation');
  database = new DatabaseSync(databasePath, { readOnly: true });
  let counts, audit;
  onPhase('existing-data integrity and budget audit');
  try { counts = verifyOriginalData(database, baseline); audit = auditDataBudgets(database); } finally { database.close(); }
  log(`Original data preserved in private clone: ${counts.clients} clients, ${counts.orders} orders; budget audit ${JSON.stringify(audit)}.`);
  enforceDataBudgets(audit);

  onPhase('local Worker startup and smoke');
  const port = await availablePort();
  const out = openSync(join(directory, 'worker.stdout'), 'w', 0o600), err = openSync(join(directory, 'worker.stderr'), 'w', 0o600);
  const workerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'worker-private.log') };
  for (const key of Object.keys(workerEnv)) if (/^(CLOUDFLARE_|WORKER_API_TOKEN$|ADMIN_|CLIENT_AUTH_SECRET$|RESEND_|WHATSAPP_)/.test(key)) delete workerEnv[key];
  const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', configPath, '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port)], { cwd: directory, env: workerEnv, stdio: ['ignore', out, err], windowsHide: true, detached: process.platform !== 'win32' });
  closeSync(out); closeSync(err);
  child.on('error', () => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) break;
      try { const response = await fetch(`http://127.0.0.1:${port}/__nextap-version`, { signal: AbortSignal.timeout(1_000), redirect: 'error' }); if (response.ok) { ready = true; break; } } catch {}
      await sleep(500);
    }
    if (!ready) throw new Error('Local staged Worker did not become ready; private logs were not published.');
    const result = await smokeStagedWorker(`http://127.0.0.1:${port}`, adminPassword);
    log(`Private local Worker smoke passed (${result.checks} checks; synthetic client/order only; notifications disabled).`);
    return { counts, audit, smoke: result };
  } finally { await stopWorker(child); }
}

async function cloudflareRead(path, token, label) {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/' + path, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.success !== true || !data.result) throw new Error();
    return data.result;
  } catch { throw new Error(label + ' failed; no private API response was published.'); }
}

async function main() {
  const { RUNNER_TEMP: runnerTemp, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: d1Token, WORKER_API_TOKEN: workerToken } = process.env;
  if (!runnerTemp || !accountId || !d1Token || !workerToken) throw new Error('Private release staging requires RUNNER_TEMP, the Cloudflare account, D1 token and Worker token.');
  const parent = resolve(runnerTemp);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'nextap-release-'));
  let cleanupDone = false;
  const cleanup = () => { if (!cleanupDone) { cleanupPrivateStage(directory, parent); cleanupDone = true; } };
  process.once('exit', cleanup);
  try {
    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
    phase('production D1 identity and backend verification');
    const info = await cloudflareRead(`accounts/${encodeURIComponent(accountId)}/d1/database/${expectedDatabaseId}`, d1Token, 'Production D1 identity check');
    verifyProductionIdentity(config, info);
    const run = privateRunner(directory);
    const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const timestamp = new Date().toISOString();
    phase('Cloudflare recovery bookmark capture');
    const bookmarkData = JSON.parse(run(process.execPath, [wrangler, 'd1', 'time-travel', 'info', 'nextap-db', '--timestamp', timestamp, '--json'], 'D1 recovery bookmark'));
    if (typeof bookmarkData.bookmark !== 'string' || !/^[A-Za-z0-9-]{16,200}$/.test(bookmarkData.bookmark)) throw new Error('D1 recovery bookmark could not be validated.');
    console.log('::add-mask::' + bookmarkData.bookmark);
    let previousVersions = [];
    phase('previous Worker version capture');
    try {
      const deployments = JSON.parse(run(process.execPath, [wrangler, 'deployments', 'list', '--name', 'nextap', '--json'], 'Previous Worker deployment capture', { CLOUDFLARE_API_TOKEN: workerToken }));
      const latest = deployments.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0];
      previousVersions = (latest?.versions || []).map(version => version.version_id).filter(id => /^[a-f0-9-]{36}$/i.test(id));
    } catch { console.log('Previous Worker version could not be captured automatically; retain the previously recorded release version.'); }
    privateWrite(join(directory, 'recovery.json'), JSON.stringify({ timestamp, bookmark: bookmarkData.bookmark, previousVersions }));
    console.log(`Cloudflare recovery checkpoint verified at ${timestamp}. Previous Worker version(s): ${previousVersions.join(', ') || 'not captured'}.`);
    const exportFile = join(directory, 'production-private.sql');
    phase('private production export');
    run(process.execPath, [wrangler, 'd1', 'export', 'nextap-db', '--remote', '--output', exportFile, '--skip-confirmation'], 'Private production export');
    await stageLocalCopy({ exportFile, directory, config, run, onPhase: phase });
    console.log('Private production-copy staging passed. Production schema has not been changed by this step.');
  } finally { cleanup(); process.removeListener('exit', cleanup); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { const code = diagnosticCodes.has(error?.safeDiagnostic) ? ` Category: ${error.safeDiagnostic}.` : ''; console.error(`Private release preflight failed during ${currentPhase}.${code} Production migration/deployment must not proceed. Private diagnostics were not published.`); process.exitCode = 1; });
}
