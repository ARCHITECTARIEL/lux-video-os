import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ALLOWED_FINDINGS,
  collectCodeqlFindingsFromDirectory,
  collectCodeqlFindingsFromSarif,
  formatCodeqlFindings,
  partitionAllowedFindings,
} from '../tools/enforce-codeql-sarif.mjs';

const execFileAsync = promisify(execFile);
const toolPath = fileURLToPath(new URL('../tools/enforce-codeql-sarif.mjs', import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codeql-gate-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSarif(dir, name, payload) {
  await writeFile(path.join(dir, name), JSON.stringify(payload, null, 2));
}

function makeSarif(results, rules = []) {
  return {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeQL',
            rules,
          },
        },
        results,
      },
    ],
  };
}

function makeRule(id, securitySeverity = '8.1') {
  return {
    id,
    properties: {
      'security-severity': securitySeverity,
    },
  };
}

function makeResult(ruleId, file = 'server.py', line = 10, extra = {}) {
  return {
    ruleId,
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: file },
          region: { startLine: line },
        },
      },
    ],
    ...extra,
  };
}

test('CodeQL SARIF gate accepts zero-result output', async () => {
  await withTempDir(async (dir) => {
    await writeSarif(dir, 'empty.sarif', makeSarif([], [makeRule('py/path-injection')]));
    const summary = await collectCodeqlFindingsFromDirectory(dir);
    assert.deepEqual(summary.files, ['empty.sarif']);
    assert.deepEqual(summary.findings, []);
  });
});

test('CodeQL SARIF gate preserves one high-severity result', async () => {
  const findings = collectCodeqlFindingsFromSarif(
    makeSarif([makeResult('py/path-injection', 'server.py', 481)], [makeRule('py/path-injection', '7.5')]),
    'one-high.sarif',
  );
  assert.deepEqual(findings, [{ ruleId: 'py/path-injection', securitySeverity: '7.5', file: 'server.py', line: 481, lineHash: null }]);
  assert.deepEqual(formatCodeqlFindings(findings), ['py/path-injection severity=7.5 server.py:481']);
});

test('CodeQL SARIF gate accumulates findings across multiple runs and files', async () => {
  await withTempDir(async (dir) => {
    const multiRun = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'CodeQL', rules: [makeRule('js/insufficient-password-hash', '8.1')] } },
          results: [makeResult('js/insufficient-password-hash', 'api/video-os-lite/auth.js', 99)],
        },
        {
          tool: { driver: { name: 'CodeQL', rules: [makeRule('py/path-injection', '7.5')] } },
          results: [makeResult('py/path-injection', 'server.py', 481)],
        },
      ],
    };
    await writeSarif(dir, 'multi.sarif', multiRun);
    await writeSarif(dir, 'single.sarif', makeSarif([makeResult('py/clear-text-storage-sensitive-data', 'video_os_backend.py', 261)], [makeRule('py/clear-text-storage-sensitive-data', '7.5')]));
    const summary = await collectCodeqlFindingsFromDirectory(dir);
    assert.equal(summary.findings.length, 3);
    assert.deepEqual(summary.findings.map((finding) => finding.ruleId), [
      'js/insufficient-password-hash',
      'py/path-injection',
      'py/clear-text-storage-sensitive-data',
    ]);
  });
});

test('CodeQL SARIF gate fails closed on missing severity metadata', () => {
  assert.throws(
    () => collectCodeqlFindingsFromSarif(makeSarif([makeResult('py/path-injection')], [makeRule('py/path-injection', '')]), 'missing-severity.sarif'),
    /missing security severity metadata/i,
  );
});

test('CodeQL SARIF gate fails closed on malformed SARIF', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'broken.sarif'), '{not-json');
    await assert.rejects(() => collectCodeqlFindingsFromDirectory(dir), /Malformed CodeQL SARIF file broken\.sarif/i);
  });
});

test('CodeQL SARIF gate preserves duplicate results instead of collapsing them', () => {
  const findings = collectCodeqlFindingsFromSarif(
    makeSarif([
      makeResult('py/path-injection', 'server.py', 481),
      makeResult('py/path-injection', 'server.py', 481),
    ], [makeRule('py/path-injection', '7.5')]),
    'duplicates.sarif',
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], findings[1]);
});

test('CodeQL SARIF gate fails closed when no SARIF artifact exists', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, 'nested'));
    await assert.rejects(() => collectCodeqlFindingsFromDirectory(dir), /produced no SARIF output/i);
  });
});

test('the allowlist has at least one entry, and every entry carries a non-trivial reason', () => {
  assert.ok(ALLOWED_FINDINGS.length >= 1);
  for (const entry of ALLOWED_FINDINGS) {
    assert.ok(entry.ruleId);
    assert.ok(entry.file);
    assert.ok(entry.lineHash);
    assert.ok(entry.reason.length > 40, `allowlist reason for ${entry.ruleId} ${entry.file} must actually explain why it's a false positive`);
  }
});

test('partitionAllowedFindings excludes a finding that exactly matches a reviewed allowlist entry', () => {
  const [entry] = ALLOWED_FINDINGS;
  const finding = { ruleId: entry.ruleId, securitySeverity: '7.8', file: entry.file, line: 999, lineHash: entry.lineHash };
  const { blocking, allowed } = partitionAllowedFindings([finding]);
  assert.deepEqual(blocking, []);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].entry, entry);
});

test('partitionAllowedFindings still blocks the same rule/file if the line content (fingerprint) differs', () => {
  const [entry] = ALLOWED_FINDINGS;
  // Same ruleId and file as the reviewed exception, but a different
  // lineHash -- i.e. a *different* line's content, or the same line
  // edited since the exception was reviewed. Proves the allowlist can't
  // accidentally swallow a new or shifted finding just because it shares
  // a rule and file with an already-reviewed one.
  const finding = { ruleId: entry.ruleId, securitySeverity: '7.8', file: entry.file, line: 12345, lineHash: 'not-the-reviewed-fingerprint:0' };
  const { blocking, allowed } = partitionAllowedFindings([finding]);
  assert.deepEqual(allowed, []);
  assert.deepEqual(blocking, [finding]);
});

test('partitionAllowedFindings blocks an unrelated finding untouched', () => {
  const finding = { ruleId: 'py/path-injection', securitySeverity: '7.5', file: 'server.py', line: 481, lineHash: null };
  const { blocking, allowed } = partitionAllowedFindings([finding]);
  assert.deepEqual(allowed, []);
  assert.deepEqual(blocking, [finding]);
});

test('CodeQL SARIF CLI passes when the only finding matches the reviewed allowlist entry, and says so', async () => {
  await withTempDir(async (dir) => {
    const [entry] = ALLOWED_FINDINGS;
    await writeSarif(dir, 'allowed.sarif', makeSarif(
      [makeResult(entry.ruleId, entry.file, 40, { partialFingerprints: { primaryLocationLineHash: entry.lineHash } })],
      [makeRule(entry.ruleId, '7.8')],
    ));
    const cleanRun = await execFileAsync(process.execPath, [toolPath, dir]);
    assert.match(cleanRun.stdout, /found 0 result\(s\) \(1 allowed\)/i);
    assert.match(cleanRun.stdout, /ALLOWED \(reviewed false positive\)/);
  });
});

test('CodeQL SARIF CLI exits 0 for zero results and 1 for blocking findings', async () => {
  await withTempDir(async (dir) => {
    await writeSarif(dir, 'empty.sarif', makeSarif([], [makeRule('py/path-injection')]));
    const cleanRun = await execFileAsync(process.execPath, [toolPath, dir]);
    assert.match(cleanRun.stdout, /found 0 result\(s\)/i);

    await writeSarif(dir, 'finding.sarif', makeSarif([makeResult('py/path-injection', 'server.py', 481)], [makeRule('py/path-injection', '7.5')]));
    await assert.rejects(
      execFileAsync(process.execPath, [toolPath, dir]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /py\/path-injection severity=7\.5 server\.py:481/);
        return true;
      },
    );
  });
});