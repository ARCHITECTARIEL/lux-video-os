import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('0018 adds LUXIFY consent lifecycle tables, terminal reasons and close-only guards', async () => {
  const [sql, previousText, currentText, journalText, lockText] = await Promise.all([
    read('../drizzle/0018_luxify_consent_lifecycle.sql'),
    read('../drizzle/meta/0017_snapshot.json'),
    read('../drizzle/meta/0018_snapshot.json'),
    read('../drizzle/meta/_journal.json'),
    read('../config/database-schema.lock.json'),
  ]);
  const text = sql.replace(/\r\n/g, '\n');
  for (const table of ['lux_staff_grants', 'luxify_creative_asset_approvals', 'luxify_look_capability_evidence', 'luxify_look_creative_approvals']) {
    assert.match(text, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(text, new RegExp(`CREATE TRIGGER \\w+ BEFORE DELETE ON ${table}`));
  }
  assert.match(text, /ADD COLUMN "terminal_reason" text/);
  assert.ok(text.indexOf('SET "terminal_reason" = \'revoked\'') < text.indexOf('luxify_cinematic_consents_terminal_ck'), 'backfill precedes the terminal check');
  assert.match(text, /"terminal_reason" is not null and "luxify_cinematic_consents"\."terminal_reason" in \('withdrawn', 'revoked', 'source_revoked'\)/);
  assert.match(text, /CREATE TRIGGER luxify_cinematic_consents_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON luxify_cinematic_consents/);
  assert.match(text, /rows are closed, never deleted/);
  assert.match(text, /requires an active source identity consent/);
  assert.match(text, /may only be closed/);
  assert.match(text, /AFTER UPDATE OF revoked_at ON identity_consents/);
  assert.match(text, /terminal_reason = 'source_revoked'/);
  assert.match(text, /@luxmarketingcompany\[\.\]com\$/);
  for (const table of ['lux_staff_grants', 'luxify_creative_asset_approvals', 'luxify_look_capability_evidence', 'luxify_look_creative_approvals']) {
    assert.match(text, new RegExp(`CREATE TRIGGER ${table}_close_only_trg BEFORE UPDATE ON ${table}\\s+FOR EACH ROW EXECUTE FUNCTION luxify_consent_records_close_only\\(\\)`));
  }
  assert.match(text, /\(to_jsonb\(NEW\) - 'revoked_at'\) IS DISTINCT FROM \(to_jsonb\(OLD\) - 'revoked_at'\)/);
  assert.match(text, /source\.revoked_at IS NULL\s+FOR SHARE;\s+IF NOT FOUND THEN/, 'insert guard locks the source consent');
  assert.match(text, /interval '5 minutes'/);
  assert.match(text, /"luxify_look_creative_approvals"\."expires_at" <= "luxify_look_creative_approvals"\."approved_at" \+ interval '30 days'/);
  const sourceBackfill = text.indexOf(`"terminal_reason" = 'source_revoked' FROM "identity_consents"`);
  assert.ok(sourceBackfill > 0 && sourceBackfill < text.indexOf('CREATE FUNCTION luxify_cinematic_consents_guard'), 'already-revoked sources are closed before the guard exists');
  for (const name of text.match(/"[a-z0-9_]+"/g)) assert.ok(name.length - 2 <= 63, `${name} exceeds 63 bytes`);
  assert.match(text, /interval '30 days'/);
  assert.doesNotMatch(text, /DROP |TRUNCATE |DELETE FROM/i);

  const previous = JSON.parse(previousText);
  const current = JSON.parse(currentText);
  assert.equal(current.prevId, previous.id);
  assert.deepEqual(Object.keys(current.tables).filter(name => !previous.tables[name]).sort(), [
    'public.lux_staff_grants', 'public.luxify_creative_asset_approvals', 'public.luxify_look_capability_evidence', 'public.luxify_look_creative_approvals',
  ]);
  assert.ok(current.tables['public.luxify_cinematic_consents'].columns.terminal_reason);
  const journal = JSON.parse(journalText);
  const entry = journal.entries[18];
  assert.deepEqual(entry, { idx: 18, version: '7', when: entry.when, tag: '0018_luxify_consent_lifecycle', breakpoints: true });
  assert.ok(entry.when > journal.entries[17].when);
  assert.equal(JSON.parse(lockText).tableCount, 35, '0019 adds luxify_consent_challenge_uses');
});
