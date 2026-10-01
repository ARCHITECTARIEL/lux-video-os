import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse, stringify, unflatten } from 'devalue';

test('patched serializer reads existing 5.9.2 Workflow-style string and legacy flat-array payloads', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/devalue-5.9.2-wire.json', import.meta.url), 'utf8'));
  assert.equal(fixture.generatedWith, '5.9.2');
  assert.equal(fixture.synthetic, true);
  for (const value of [parse(fixture.wire), unflatten(JSON.parse(fixture.wire))]) {
    assert.equal(value.self, value);
    assert.equal(value.first, value.second);
    assert.equal(value.map.get('item'), value.first);
    assert.equal(value.date.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(value.count, 12345678901234567890n);
    assert.deepEqual([...value.set], ['a', 'b']);
    assert.deepEqual([...value.bytes], [0, 128, 255]);
    assert.equal(Object.hasOwn(value, 'missing'), true);
    assert.equal(value.missing, undefined);
    assert.deepEqual(parse(stringify(value)), value);
  }
});
