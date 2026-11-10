import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readSchemaCatalogue, schemaDigest } from '../tools/check-migrations.mjs';

// QA recheck N-L1: PG 18 stores column NOT NULLs as pg_constraint rows
// (contype 'n'); PG 17 does not. The capture must not depend on that.
const MODULE = process.env.VIDEO_OS_PGLITE_MODULE;
const skip = MODULE ? false : 'VIDEO_OS_PGLITE_MODULE is unset (disposable PGlite only; never a real DATABASE_URL)';

test('catalogue capture excludes contype n constraint rows (static)', async () => {
  let sql = '';
  const catalogue = { tables: [], columns: [], constraints: [], indexes: [], policies: [], triggers: [], enums: [], views: [], routines: [], sequences: [] };
  await readSchemaCatalogue({ query: async text => { sql = text; return { rows: [{ catalogue }] }; } });
  const constraints = sql.split('\n').find(line => line.includes("'constraints'"));
  assert.ok(constraints, 'constraints subquery present');
  assert.match(constraints, /from pg_constraint k .* and k\.contype <> 'n'\)/);
  assert.match(sql.split('\n').find(line => line.includes("'columns'")), /'notNull',a\.attnotnull/, 'nullability still captured per column');
});

test('PG 18 (PGlite): NOT NULL rows exist in pg_constraint, carry nothing beyond columns.notNull, and are absent from the capture', { skip }, async () => {
  const { PGlite } = await import(MODULE);
  const db = new PGlite();
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) {
    const text = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) if (statement.trim()) await db.exec(statement);
  }
  assert.equal(Number((await db.query('show server_version_num')).rows[0].server_version_num.slice(0, 2)), 18, 'PGlite build is PG 18');
  const notNullRows = (await db.query(`select c.relname as "table", a.attname as "column", k.convalidated, k.connoinherit, cardinality(k.conkey) as keys
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where n.nspname = 'public' and k.contype = 'n' order by 1, 2`)).rows;
  assert.ok(notNullRows.length > 0, 'PG 18 catalogues NOT NULL constraints (the source of the drift)');
  // Every 'n' row is a plain, validated, inheritable single-column NOT NULL, so
  // excluding it loses no information that columns.notNull does not carry.
  for (const row of notNullRows) {
    assert.equal(row.keys, 1, `${row.table}.${row.column}`);
    assert.equal(row.convalidated, true, `${row.table}.${row.column} NOT VALID would be invisible`);
    assert.equal(row.connoinherit, false, `${row.table}.${row.column} NO INHERIT would be invisible`);
  }
  const catalogue = await readSchemaCatalogue(db);
  assert.equal(catalogue.constraints.filter(row => row.type === 'n').length, 0);
  const notNullColumns = catalogue.columns.filter(column => column.notNull).map(column => `${column.table}.${column.name}`).sort();
  assert.deepEqual(notNullRows.map(row => `${row.table}.${row.column}`).sort(), notNullColumns, "'n' rows map 1:1 onto columns with notNull=true");
  // Other constraint types are still captured.
  for (const type of ['c', 'f', 'p', 'u']) assert.ok(catalogue.constraints.some(row => row.type === type), `constraint type ${type} captured`);
  // A change to nullability still changes the fingerprint.
  const before = schemaDigest(catalogue);
  const email = catalogue.columns.find(column => column.table === 'users' && column.name === 'email');
  assert.ok(email, 'users.email captured');
  await db.exec(`ALTER TABLE users ALTER COLUMN email ${email.notNull ? 'DROP' : 'SET'} NOT NULL`);
  assert.notEqual(schemaDigest(await readSchemaCatalogue(db)), before, 'nullability drift is still detected');
  await db.close();
});
