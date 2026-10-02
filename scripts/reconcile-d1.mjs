import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const historySql = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(255) UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

// Split only outside quoted strings. Unsupported SQL fails before any writes;
// extending migrations beyond these additive operations requires review here.
export function splitSql(source, delimiter = ';') {
  const parts = [];
  let part = '', quoted = '', comment = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') { comment = ''; part += '\n'; } continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = ''; i++; part += ' '; } continue; }
    if (quoted) {
      part += c;
      if (c === quoted) {
        if (next === quoted) { part += next; i++; } else quoted = '';
      }
      continue;
    }
    if (c === '-' && next === '-') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (c === "'" || c === '"') { quoted = c; part += c; continue; }
    if (c === delimiter) { if (part.trim()) parts.push(part.trim()); part = ''; } else part += c;
  }
  if (quoted || comment === 'block') throw new Error('Unterminated SQL string/comment');
  if (part.trim()) parts.push(part.trim());
  return parts;
}

function parseColumn(definition) {
  const match = definition.trim().match(/^(\w+)\s+([\w()]+)\b(.*)$/s);
  if (!match) throw new Error('Unsupported column definition: ' + definition);
  const [, name, type, constraints] = match;
  const defaultMatch = constraints.match(/\bDEFAULT\s+('(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/i);
  return { name, type: type.toUpperCase(), pk: /\bPRIMARY KEY\b/i.test(constraints), unique: /\bUNIQUE\b/i.test(constraints), notnull: /\bNOT NULL\b/i.test(constraints), default: defaultMatch?.[1] ?? null };
}

export function parseMigration(name, source) {
  const operations = splitSql(source).map(sql => {
    let match = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]+)\)$/i);
    if (match) return { kind: 'table', table: match[1], columns: splitSql(match[2], ',').map(parseColumn), sql };
    match = sql.match(/^ALTER TABLE (\w+) ADD COLUMN ([\s\S]+)$/i);
    if (match) return { kind: 'column', table: match[1], column: parseColumn(match[2]), sql };
    match = sql.match(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)\s*\(([\w\s,]+)\)$/i);
    if (match) return { kind: 'index', unique: Boolean(match[1]), index: match[2], table: match[3], columns: match[4].split(',').map(s => s.trim()), sql };
    match = sql.match(/^INSERT OR IGNORE INTO (\w+)\s*\(([\w\s,]+)\)\s*VALUES\s*\(([\s\S]+)\)$/i);
    if (match) {
      const columns = match[2].split(',').map(s => s.trim());
      const values = splitSql(match[3], ',');
      const idPosition = columns.indexOf('id');
      if (columns.length !== values.length || idPosition < 0 || !/^'(?:[^']|'')*'$/.test(values[idPosition])) throw new Error('Seed requires one literal id');
      return { kind: 'seed', table: match[1], idSql: values[idPosition], sql };
    }
    throw new Error(`Unsupported operation in ${name}: ${sql.slice(0, 100)}`);
  });
  return { name, operations };
}

export function loadMigrations(directory = join(root, 'migrations')) {
  return readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()
    .map(name => parseMigration(name, readFileSync(join(directory, name), 'utf8')));
}

function affinity(type) {
  const t = String(type).toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/(CHAR|CLOB|TEXT)/.test(t)) return 'TEXT';
  if (!t || t.includes('BLOB')) return 'BLOB';
  if (/(REAL|FLOA|DOUB)/.test(t)) return 'REAL';
  return 'NUMERIC';
}

function verifyColumn(table, expected, actual, state) {
  const primaryColumns = [...(state.tables.get(table)?.values() || [])].filter(c => c.pk);
  if (!actual || affinity(actual.type) !== affinity(expected.type) || (expected.pk && (!actual.pk || primaryColumns.length !== 1)) || (expected.notnull && !actual.notnull) || (expected.unique && !state.uniqueColumns.get(table)?.has(expected.name))) {
    throw new Error(`Incompatible schema for ${table}.${expected.name}. Inspect a backup/staging copy before changing its type or constraints.`);
  }
  // A manually added nullable/default-free column remains usable by explicit
  // application writes. Preserve its definition and existing values.
}

async function snapshot(query, operations) {
  const tables = [...new Set(['d1_migrations', ...operations.filter(op => op.table).map(op => op.table)])];
  const indexes = [...new Set(operations.filter(op => op.kind === 'index').map(op => op.index))];
  const sql = ["SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index')",
    ...tables.map(t => `PRAGMA table_info(${quote(t)})`),
    ...indexes.map(i => `PRAGMA index_info(${quote(i)})`),
    ...tables.map(t => `PRAGMA index_list(${quote(t)})`)];
  const sets = await query(sql.join(';') + ';');
  if (sets.length !== sql.length) throw new Error('Database returned incomplete schema inspection results');
  const uniqueIndexes = tables.flatMap((table, i) => sets[1 + tables.length + indexes.length + i]
    .filter(index => Number(index.unique) === 1 && Number(index.partial) === 0)
    .map(index => ({ table, name: index.name })));
  // D1 forbids the table-valued pragma_* functions. Use supported standalone
  // PRAGMAs and explicitly inspect autoindexes for UNIQUE column constraints.
  const uniqueInfo = uniqueIndexes.length
    ? await query(uniqueIndexes.map(index => `PRAGMA index_info(${quote(index.name)})`).join(';') + ';')
    : [];
  if (uniqueInfo.length !== uniqueIndexes.length) throw new Error('Database returned incomplete unique-index inspection results');
  const uniqueColumns = new Map(tables.map(table => [table, new Set()]));
  uniqueIndexes.forEach((index, i) => {
    if (uniqueInfo[i].length === 1) uniqueColumns.get(index.table)?.add(uniqueInfo[i][0].name);
  });
  return {
    objects: new Map(sets[0].map(row => [row.name, row])),
    tables: new Map(tables.map((table, i) => [table, new Map(sets[i + 1].map(c => [c.name, c]))])),
    indexes: new Map(indexes.map((index, i) => [index, sets[tables.length + i + 1].map(c => c.name)])),
    uniqueColumns
  };
}

function missingOperations(migration, state, applied, existingSeedTables) {
  return migration.operations.filter(op => {
    if (op.kind === 'table') {
      if (!state.objects.has(op.table)) return true;
      for (const c of op.columns) verifyColumn(op.table, c, state.tables.get(op.table)?.get(c.name), state);
      return false;
    }
    if (op.kind === 'column') {
      const actual = state.tables.get(op.table)?.get(op.column.name);
      if (!actual) return true;
      verifyColumn(op.table, op.column, actual, state);
      return false;
    }
    if (op.kind === 'index') {
      const actual = state.objects.get(op.index);
      if (!actual) return true;
      const unique = /^CREATE UNIQUE INDEX\b/i.test(actual.sql || '');
      if (actual.type !== 'index' || actual.tbl_name !== op.table || unique !== op.unique || /\bWHERE\b/i.test(actual.sql || '') || JSON.stringify(state.indexes.get(op.index)) !== JSON.stringify(op.columns)) {
        throw new Error(`Incompatible index ${op.index}; inspect before changing it.`);
      }
      return false;
    }
    // Seeds belong to a genuinely fresh bootstrap. An existing table is an
    // explicitly preserved data baseline, even when historical records are
    // missing: never recreate a deleted or never-used demo client.
    return !applied.has(migration.name) && !existingSeedTables.has(op.table);
  });
}

export async function reconcile(query, migrations = loadMigrations(), { apply = false, log = () => {} } = {}) {
  const operations = migrations.flatMap(m => m.operations);
  let state = await snapshot(query, operations);
  const existingSeedTables = new Set(operations.filter(op => op.kind === 'seed' && state.objects.has(op.table)).map(op => op.table));
  let applied = new Set();
  if (state.objects.has('d1_migrations')) {
    for (const c of parseMigration('history', historySql).operations[0].columns) verifyColumn('d1_migrations', c, state.tables.get('d1_migrations').get(c.name), state);
    const [rows] = await query('SELECT name FROM d1_migrations;');
    applied = new Set(rows.map(r => r.name));
  }
  // Validate all existing objects before any mutation. Names/numeric IDs from
  // previous Wrangler runs stay intact, including unknown migration records.
  for (const migration of migrations) missingOperations(migration, state, applied, existingSeedTables);
  const pending = migrations.filter(m => !applied.has(m.name) || missingOperations(m, state, applied, existingSeedTables).length);
  if (!apply) {
    for (const m of pending) log(`Pending/repair: ${m.name}`);
    return { pending: pending.map(m => m.name), changed: [] };
  }
  if (!state.objects.has('d1_migrations')) await query(historySql);
  const changed = [];
  for (const migration of migrations) {
    const missing = missingOperations(migration, state, applied, existingSeedTables);
    if (missing.length) {
      log(`Applying ${migration.name}: ${missing.length} missing operation(s)`);
      await query(missing.map(op => op.sql).join(';') + ';');
      state = await snapshot(query, operations);
      // Reinspect actual D1 effects; do not assume execute success means the
      // expected schema is present, even for fabricated old history records.
      for (const op of migration.operations.filter(op => op.kind !== 'seed')) {
        if (missingOperations({ name: migration.name, operations: [op] }, state, applied, existingSeedTables).length) throw new Error(`Verification failed for ${migration.name}; history was not changed`);
      }
      changed.push(migration.name);
    }
    if (!applied.has(migration.name)) {
      for (const op of migration.operations.filter(op => op.kind === 'seed')) {
        if (existingSeedTables.has(op.table)) {
          if (!state.objects.has(op.table)) throw new Error(`Existing-data baseline verification failed for ${migration.name}; history was not changed`);
          log(`Baseline: ${migration.name}; existing ${op.table} data retained, historical demo seed not replayed`);
          continue;
        }
        const [rows] = await query(`SELECT id FROM ${quote(op.table)} WHERE id = ${op.idSql};`);
        if (rows.length !== 1) throw new Error(`Seed verification failed for ${migration.name}; history was not changed`);
      }
      await query(`INSERT INTO d1_migrations (name, applied_at) VALUES (${literal(migration.name)}, CURRENT_TIMESTAMP);`);
      const [recorded] = await query(`SELECT name FROM d1_migrations WHERE name = ${literal(migration.name)};`);
      if (recorded.length !== 1) throw new Error(`Migration history verification failed for ${migration.name}`);
      applied.add(migration.name);
      log(`Verified: ${migration.name}`);
    }
  }
  return { pending: [], changed };
}

function wranglerQuery(database, remote, configPath) {
  const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) throw new Error('Wrangler is not installed. Run npm ci before database commands.');
  return async sql => {
    const options = configPath ? ['--config', configPath] : [];
    const result = spawnSync(process.execPath, [bin, 'd1', 'execute', database, remote ? '--remote' : '--local', '--json', '--command', sql, ...options], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Wrangler D1 execute failed: ${result.error?.message || result.stderr || result.stdout}`);
    let output;
    try { output = JSON.parse(result.stdout); } catch { throw new Error('Wrangler did not return JSON; schema/history were not assumed valid. ' + result.stdout.slice(0, 300)); }
    if (!Array.isArray(output) || output.some(item => item.success !== true || !Array.isArray(item.results))) throw new Error('D1 returned an unsuccessful or unexpected result');
    return output.map(item => item.results);
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/reconcile-d1.mjs [--local|--remote] [--check|--apply] [--database NAME] [--config PATH]\nDefaults: --local --check. --check is read-only and exits 1 when repair/application is needed.');
    return;
  }
  const databaseAt = args.indexOf('--database');
  const database = databaseAt < 0 ? 'nextap-db' : args[databaseAt + 1];
  const configAt = args.indexOf('--config');
  const configPath = configAt < 0 ? undefined : resolve(root, args[configAt + 1] || '');
  const valid = new Set(['--local', '--remote', '--check', '--apply', '--database', '--config']);
  for (let i = 0; i < args.length; i++) {
    if (!valid.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (args[i] === '--database' || args[i] === '--config') { const option = args[i]; if (!args[++i] || args[i].startsWith('--')) throw new Error(`${option} requires a value`); }
  }
  if ((args.includes('--remote') && args.includes('--local')) || (args.includes('--apply') && args.includes('--check'))) throw new Error('Choose one database target and one mode');
  if (configPath && !existsSync(configPath)) throw new Error('Configuration file not found: ' + configPath);
  const remote = args.includes('--remote'), apply = args.includes('--apply');
  console.log(`${apply ? 'Reconcile' : 'Inspect'} ${remote ? 'REMOTE' : 'local'} D1 database: ${database}`);
  const result = await reconcile(wranglerQuery(database, remote, configPath), loadMigrations(), { apply, log: console.log });
  if (result.pending.length) { console.error(`${result.pending.length} migration(s) need reconciliation. Rerun with --apply after backup/staging verification.`); process.exitCode = 1; }
  else console.log('Checked-in schema and migration history verified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
