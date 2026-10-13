import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCatalogueLineEndings, readSchemaCatalogue, schemaDigest } from '../tools/check-migrations.mjs';

test('catalogue text has the same digest across LF, CRLF, and lone CR', async () => {
  const catalogue = {
    routines: [{ definition: 'begin\r\n  return 1;\rend;' }],
    columns: [{ default: 'line one\rline two', position: 1, notNull: true }],
    constraints: [{ definition: 'check (\r\nvalue > 0\r)' }],
    metadata: [null, false, 42, { nested: ['a\rb', 3.5] }],
  };
  const expected = {
    routines: [{ definition: 'begin\n  return 1;\nend;' }],
    columns: [{ default: 'line one\nline two', position: 1, notNull: true }],
    constraints: [{ definition: 'check (\nvalue > 0\n)' }],
    metadata: [null, false, 42, { nested: ['a\nb', 3.5] }],
  };

  assert.deepEqual(normalizeCatalogueLineEndings(catalogue), expected);
  assert.equal(schemaDigest(normalizeCatalogueLineEndings(catalogue)), schemaDigest(expected));
  assert.notEqual(schemaDigest(catalogue), schemaDigest(expected));
  assert.equal(catalogue.routines[0].definition, 'begin\r\n  return 1;\rend;');

  const client = { async query() { return { rows: [{ catalogue }] }; } };
  const read = await readSchemaCatalogue(client);
  assert.deepEqual(read, expected);
  assert.equal(schemaDigest(read), schemaDigest(expected));
});
