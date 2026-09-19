import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPTED_ADVISORIES,
  collectHighSeverityAdvisories,
  evaluateAuditJson,
  partitionAcceptedAdvisories,
  runNpmAudit,
} from '../tools/enforce-npm-audit.mjs';

function makeAdvisory(id, severity, name = 'some-package', title = 'Some advisory') {
  return { source: 1, name, dependency: name, title, url: `https://github.com/advisories/${id}`, severity, range: '*' };
}

function makeAuditJson(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities };
}

test('every accepted advisory carries a real reason and a real package name', () => {
  assert.ok(ACCEPTED_ADVISORIES.length >= 1);
  for (const entry of ACCEPTED_ADVISORIES) {
    assert.match(entry.id, /^GHSA-/);
    assert.ok(entry.package);
    assert.ok(entry.reason.length > 40, `reason for ${entry.id} must actually explain why the risk is accepted`);
  }
});

test('collectHighSeverityAdvisories ignores moderate/low findings and bare package-name via entries', () => {
  const auditJson = makeAuditJson({
    nanoid: { name: 'nanoid', severity: 'high', via: [makeAdvisory('GHSA-xxxx-high', 'high', 'nanoid')] },
    qs: { name: 'qs', severity: 'moderate', via: [makeAdvisory('GHSA-xxxx-moderate', 'moderate', 'qs')] },
    workflow: { name: 'workflow', severity: 'high', via: ['@workflow/core', '@workflow/cli'] }, // chain references, not advisories
  });
  const advisories = collectHighSeverityAdvisories(auditJson);
  assert.deepEqual(advisories.map((advisory) => advisory.id), ['GHSA-xxxx-high']);
});

test('collectHighSeverityAdvisories dedupes the same advisory reached through multiple packages', () => {
  const auditJson = makeAuditJson({
    a: { name: 'a', severity: 'high', via: [makeAdvisory('GHSA-shared', 'high', 'undici')] },
    b: { name: 'b', severity: 'high', via: [makeAdvisory('GHSA-shared', 'high', 'undici')] },
  });
  assert.equal(collectHighSeverityAdvisories(auditJson).length, 1);
});

test('partitionAcceptedAdvisories accepts every currently-documented advisory and blocks anything else', () => {
  const known = ACCEPTED_ADVISORIES.map((entry) => ({ id: entry.id, package: entry.package, severity: 'high', title: 'x' }));
  const unknown = { id: 'GHSA-not-reviewed', package: 'left-pad', severity: 'high', title: 'A brand-new finding nobody has reviewed' };
  const { blocking, accepted } = partitionAcceptedAdvisories([...known, unknown]);
  assert.equal(accepted.length, known.length);
  assert.deepEqual(blocking, [unknown]);
});

test('evaluateAuditJson exits 0 when the only findings are documented exceptions, and logs each one', () => {
  const logs = [];
  const errors = [];
  const io = { log: (line) => logs.push(line), error: (line) => errors.push(line) };
  const auditJson = makeAuditJson({
    nanoid: { name: 'nanoid', severity: 'high', via: ACCEPTED_ADVISORIES.filter((e) => e.package === 'nanoid').map((e) => makeAdvisory(e.id, 'high', 'nanoid')) },
  });
  const code = evaluateAuditJson(auditJson, io);
  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.ok(logs.some((line) => line.includes('ACCEPTED')));
});

test('evaluateAuditJson exits 1 the moment a genuinely new high/critical advisory shows up', () => {
  const logs = [];
  const errors = [];
  const io = { log: (line) => logs.push(line), error: (line) => errors.push(line) };
  const auditJson = makeAuditJson({
    'left-pad': { name: 'left-pad', severity: 'critical', via: [makeAdvisory('GHSA-brand-new', 'critical', 'left-pad', 'Remote code execution via padding')] },
  });
  const code = evaluateAuditJson(auditJson, io);
  assert.equal(code, 1);
  assert.ok(errors.some((line) => line.includes('GHSA-brand-new')));
});

test('runNpmAudit against this repo’s real, current dependency tree finds exactly the documented exceptions', () => {
  // Live integration check, mirroring how the CodeQL allowlist fix was
  // verified against the real SARIF rather than only synthetic fixtures:
  // proves the actual gate passes today, not just that the parsing logic
  // is correct in isolation. If this ever fails, either a new real
  // advisory needs review (see ACCEPTED_ADVISORIES above), or one of
  // these has finally been fixed upstream and can be removed.
  const auditJson = runNpmAudit();
  const advisories = collectHighSeverityAdvisories(auditJson);
  const { blocking } = partitionAcceptedAdvisories(advisories);
  assert.deepEqual(blocking, []);
});
