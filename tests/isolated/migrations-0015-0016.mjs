#!/usr/bin/env node
// Disposable, synthetic PostgreSQL 18.6 rehearsal. No host port or external DB.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = `vos-mig-1516-${randomBytes(4).toString('hex')}`;
const account = 'synthetic-account';
const project = '11111111-1111-4111-8111-111111111111';
const identity = '22222222-2222-4222-8222-222222222222';
const consent = '33333333-3333-4333-8333-333333333333';
const q = value => `'${String(value).replaceAll("'", "''")}'`;

function docker(args) {
  return new Promise((done, fail) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}
async function required(args) {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`Disposable command failed: ${result.stderr.slice(-700)}`);
  return result.stdout;
}
function psql(sql, db = 'vos_migrations') {
  return docker(['exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', sql]);
}
async function query(sql, db) {
  const result = await psql(sql, db);
  if (result.code !== 0) throw new Error(`Synthetic SQL failed: ${result.stderr.slice(-700)}`);
  return result.stdout;
}
async function rejected(sql, pattern, db) {
  const result = await psql(sql, db);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, pattern);
}
function apply(file, db = 'vos_migrations', atomic = false) {
  return docker(['exec', name, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(atomic ? ['-1'] : []),
    '-U', 'postgres', '-d', db, '-f', `/tmp/drizzle/${file}`]);
}
async function seed(db = 'vos_migrations') {
  await query(`insert into users(id,name) values(${q(account)},'Synthetic');`, db);
  await query(`insert into media_assets(id,account_id,kind,private_pathname,content_type,bytes,sha256) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',${q(account)},'photo','video-os/uploads/seed-photo','image/jpeg',3,repeat('a',64)),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',${q(account)},'voice','video-os/uploads/seed-voice','audio/wav',3,repeat('b',64));`, db);
  await query(`insert into user_identities(id,account_id,display_name,source_photo_asset_id,source_voice_asset_id)
    values(${q(identity)}::uuid,${q(account)},'Synthetic','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid);`, db);
  await query(`insert into identity_consents(id,account_id,identity_id,face_authorization,voice_authorization,
    provider_processing_authorization,archive_delete_acknowledgment,policy_version,photo_sha256,voice_sha256)
    values(${q(consent)}::uuid,${q(account)},${q(identity)}::uuid,true,true,true,true,'synthetic-policy',repeat('a',64),repeat('b',64));`, db);
  await query(`insert into projects(id,account_id,identity_id,title) values(${q(project)}::uuid,${q(account)},${q(identity)}::uuid,'Synthetic');`, db);
}
function job(id, provider, input, db = 'vos_migrations') {
  return query(`insert into video_jobs(id,account_id,project_id,idempotency_key,correlation_id,provider,status,title,format,cost_credits,input)
    values(${q(id)},${q(account)},${q(project)}::uuid,${q(`key-${id}`)},'synthetic',${q(provider)},
    'reserved','Synthetic','landscape',7,${q(JSON.stringify(input))}::jsonb);`, db);
}
async function main() {
  let created = false;
  try {
    const journal = JSON.parse(await readFile(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
    assert.deepEqual(journal.entries.slice(-3).map(x => [x.idx, x.tag]), [
      [14, '0014_pre_role_guard'], [15, '0015_luxify_cinematic_consent'], [16, '0016_render_mode'],
    ]);
    assert.ok(journal.entries[14].when < journal.entries[15].when && journal.entries[15].when < journal.entries[16].when);
    const s14 = JSON.parse(await readFile(join(root, 'drizzle/meta/0014_snapshot.json'), 'utf8'));
    const s15 = JSON.parse(await readFile(join(root, 'drizzle/meta/0015_snapshot.json'), 'utf8'));
    const s16 = JSON.parse(await readFile(join(root, 'drizzle/meta/0016_snapshot.json'), 'utf8'));
    assert.equal(s15.prevId, s14.id);
    assert.equal(s16.prevId, s15.id);
    await required(['run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_DB=vos_migrations', 'postgres:18']);
    created = true;
    for (let n = 0; n < 40; n += 1) {
      if ((await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'vos_migrations'])).code === 0) break;
      if (n === 39) throw new Error('Disposable PostgreSQL not ready.');
      await new Promise(done => setTimeout(done, 250));
    }
    const version = await required(['exec', name, 'postgres', '--version']);
    assert.match(version, /PostgreSQL\) 18\.6/);
    await required(['cp', join(root, 'drizzle'), `${name}:/tmp/drizzle`]);
    const files = (await readdir(join(root, 'drizzle'))).filter(x => /^\d{4}_.+\.sql$/.test(x)).sort();
    assert.equal(files.length, 17);
    for (const file of files.slice(0, 15)) {
      const result = await apply(file);
      assert.equal(result.code, 0, `${file}: ${result.stderr.slice(-700)}`);
    }
    await seed();
    await job('legacy-heygen', 'heygen', {});
    await job('legacy-sadtalker', 'sadtalker', {});
    await job('standard-current', 'sadtalker', { contractVersion: 'standard-narration-v1', tier: 'STANDARD' });
    await job('scripted-standard', 'heygen', { contractVersion: 'scripted-photo-v1', tier: 'STANDARD' });
    await job('scripted-premium-legacy', 'heygen', { contractVersion: 'scripted-photo-v1', tier: 'PREMIUM' });
    await job('scripted-premium', 'heygen', { contractVersion: 'scripted-photo-v1', tier: 'PREMIUM', renderMode: 'premium_presenter_v1' });
    await job('standard-current-strict', 'sadtalker', { contractVersion: 'standard-narration-v1', tier: 'STANDARD', renderMode: 'standard_narration_v1' });
    await job('luxify', 'heygen', { contractVersion: 'luxify-cinematic-v1',
      renderMode: 'luxify_cinematic_v1', providerCapability: 'cinematic_avatar' });
    let result = await apply(files[15]);
    assert.equal(result.code, 0, result.stderr.slice(-700));
    assert.equal(await query('select count(*) from luxify_cinematic_consents;'), '0');
    const insertConsent = `insert into luxify_cinematic_consents(id,account_id,identity_id,source_identity_consent_id,
      idempotency_key,provider_look_id,provider_space_fingerprint,policy_version,purpose,
      cinematic_generation_authorization,provider_processing_authorization,approval_evidence_sha256,
      accepted_at,expires_at) values('44444444-4444-4444-8444-444444444444'::uuid,${q(account)},
      ${q(identity)}::uuid,${q(consent)}::uuid,'55555555-5555-4555-8555-555555555555'::uuid,
      'private-look',repeat('a',64),'luxify-cinematic-consent/v1','luxify-cinematic-generation',
      true,true,repeat('b',64),now(),now()+interval '8760 hours')`;
    await query(`${insertConsent};`);
    await rejected(`update luxify_cinematic_consents set expires_at=accepted_at+interval '8784 hours';`, /window_ck/);
    await rejected(`update luxify_cinematic_consents set cinematic_generation_authorization=false;`, /authorization_ck/);
    await rejected(`update luxify_cinematic_consents set provider_look_id='invalid/look';`, /look_ck/);
    await rejected(`update luxify_cinematic_consents set policy_version='obsolete';`, /policy_ck/);
    await rejected(`${insertConsent
      .replace("'44444444-4444-4444-8444-444444444444'", "'77777777-7777-4777-8777-777777777777'")
      .replace("'55555555-5555-4555-8555-555555555555'", "'88888888-8888-4888-8888-888888888888'")
      .replace("'private-look'", "'other-look'")
      .replace(q(consent), q('66666666-6666-4666-8666-666666666666'))};`, /foreign key/);
    result = await apply(files[16], 'vos_migrations', true);
    assert.equal(result.code, 0, result.stderr.slice(-700));
    const modes = await query('select id||\':\'||render_mode from video_jobs order by id;');
    for (const expected of ['legacy-heygen:premium', 'legacy-sadtalker:standard',
      'scripted-standard:standard', 'scripted-premium:premium', 'scripted-premium-legacy:premium',
      'luxify:luxified', 'standard-current:standard', 'standard-current-strict:standard']) assert.ok(modes.includes(expected), expected);
    assert.equal(await query(`select video_os_render_mode_for_job('sadtalker',
      '{"contractVersion":"standard-narration-v1","tier":"PREMIUM"}'::jsonb) is null;`), 't');
    assert.equal(await query(`select video_os_render_mode_for_job('sadtalker',
      '{"contractVersion":"standard-narration-v1","tier":"STANDARD","providerCapability":"cinematic_avatar"}'::jsonb) is null;`), 't');
    assert.equal(await query(`select video_os_render_mode_for_job('sadtalker',
      '{"contractVersion":"standard-narration-v1","tier":"STANDARD","renderMode":"standard_narration_v1","lookBindings":[]}'::jsonb) is null;`), 't');
    assert.equal(await query("select video_os_render_mode_for_job('unknown', '{}'::jsonb) is null;"), 't');
    await job('old-app-insert', 'heygen', {});
    assert.equal(await query("select render_mode from video_jobs where id='old-app-insert';"), 'premium');
    await rejected("update video_jobs set render_mode='luxified' where id='scripted-standard';", /conflicts with source input/);
    await rejected("update video_jobs set input='{\"contractVersion\":\"scripted-photo-v1\",\"tier\":\"PREMIUM\"}'::jsonb where id='scripted-standard';", /conflicts with source input/);
    await rejected(`insert into video_jobs(id,account_id,project_id,idempotency_key,correlation_id,provider,status,title,format,cost_credits,input)
      values('invalid',${q(account)},${q(project)}::uuid,'key-invalid','synthetic','heygen','reserved',
      'Synthetic','landscape',7,'{"renderMode":"unknown"}'::jsonb);`, /cannot be classified/);
    await rejected(`insert into video_jobs(id,account_id,project_id,idempotency_key,correlation_id,provider,status,title,format,cost_credits,input)
      values('partial-tier',${q(account)},${q(project)}::uuid,'key-partial','synthetic','heygen','reserved',
      'Synthetic','landscape',7,'{"tier":"STANDARD"}'::jsonb);`, /cannot be classified/);
    await rejected(`insert into video_jobs(id,account_id,project_id,idempotency_key,correlation_id,provider,status,title,format,cost_credits,input)
      values('unknown-contract',${q(account)},${q(project)}::uuid,'key-unknown-contract','synthetic','heygen','reserved',
      'Synthetic','landscape',7,'{"contractVersion":"unknown-v1"}'::jsonb);`, /cannot be classified/);
    assert.equal(await query('select count(*) from video_jobs where render_mode is null;'), '0');

    await required(['exec', name, 'createdb', '-U', 'postgres', 'invalid_history']);
    for (const file of files.slice(0, 15)) {
      result = await apply(file, 'invalid_history');
      assert.equal(result.code, 0, `${file}: ${result.stderr.slice(-700)}`);
    }
    await seed('invalid_history');
    await job('unknown-contract', 'heygen', { contractVersion: 'unknown-v1' }, 'invalid_history');
    result = await apply(files[15], 'invalid_history');
    assert.equal(result.code, 0, result.stderr.slice(-700));
    result = await apply(files[16], 'invalid_history', true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unclassifiable render modes/);
    assert.equal(await query("select count(*) from information_schema.columns where table_name='video_jobs' and column_name='render_mode';", 'invalid_history'), '0');
    return { postgres: version, migrations: files.length, classifiedJobs: 9,
      invalidHistoryRejected: true, failedMigrationRolledBack: true };
  } finally {
    if (created && (await docker(['stop', name])).code !== 0) throw new Error('Disposable container cleanup requires attention.');
  }
}
main().then(x => process.stdout.write(`${JSON.stringify(x)}\n`))
  .catch(error => { process.stderr.write(`0015/0016 rehearsal failed: ${error.message}\n`); process.exitCode = 1; });
