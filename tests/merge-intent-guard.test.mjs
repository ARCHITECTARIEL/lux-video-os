import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { evaluateMergeIntent } from '../tools/merge-intent-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readWorkflow = () => readFileSync(resolve(root, '.github/workflows/merge-intent-guard.yml'), 'utf8').replaceAll('\r\n', '\n');
const evaluate = (overrides = {}) => evaluateMergeIntent({
  title: 'Video OS release candidate', labels: [], isDraft: false, ...overrides,
});

for (const title of [
  'RC-001: Video OS release candidate (DRAFT, CI only, do not merge)',
  'WIP: x', '[wip] x', 'Do-Not-Merge x', 'do not merge',
]) {
  test(`rejects title: ${title}`, () => {
    const result = evaluate({ title });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.length > 0);
  });
}

for (const label of ['do-not-merge', 'WIP']) {
  test(`rejects label: ${label}`, () => {
    assert.equal(evaluate({ labels: [label] }).ok, false);
  });
}

test('rejects draft boolean and string', () => {
  assert.equal(evaluate({ isDraft: true }).ok, false);
  assert.equal(evaluate({ isDraft: 'true' }).ok, false);
});

for (const title of ['Video OS release candidate', 'Drafting tool', 'Redraft copy', 'Wipe cache', 'Swipe gesture']) {
  test(`accepts clean title: ${title}`, () => {
    assert.deepEqual(evaluate({ title }), { ok: true, reasons: [] });
  });
}

test('workflow has the required check and event coverage', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^  merge-intent-guard:\s*$/m);
  assert.match(workflow, /^    name: merge-intent-guard\s*$/m);
  assert.equal(workflow.match(/^on:\r?\n([\s\S]*?)(?=^permissions:)/m)?.[1].trim(), [
    'pull_request_target:',
    '    types: [opened, edited, reopened, synchronize, labeled, unlabeled, ready_for_review]',
    '    branches: [main]',
  ].join('\n'));
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /run: node tools\/merge-intent-guard\.mjs/);
});

test('workflow executes the guard from the base commit with read-only permissions', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^on:\r?\n  pull_request_target:\r?\n/m);
  assert.match(workflow, /- uses: actions\/checkout@v7\r?\n        with:\r?\n          ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\r?\n          persist-credentials: false/);
  assert.doesNotMatch(workflow, /(?:head\.ref|head\.sha|head_ref|github\.head_ref)/);
  assert.deepEqual(
    workflow.match(/^permissions:\r?\n((?:  [^\r\n]+\r?\n)+)/m)?.[1].trim().split(/\r?\n/).map((line) => line.trim()).sort(),
    ['contents: read', 'pull-requests: read'].sort(),
  );
  assert.equal((workflow.match(/^permissions:/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /^[ \t]+permissions:/m);
  assert.doesNotMatch(workflow, /^\s*run:.*\$\{\{/m);
  assert.match(workflow, /^          TITLE: \$\{\{ github\.event\.pull_request\.title \}\}$/m);
  assert.match(workflow, /^          IS_DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}$/m);
  assert.match(workflow, /^          LABELS: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}$/m);
});

test('workflow has exactly one job with exactly the approved ordered steps', () => {
  const workflow = readWorkflow();
  const jobs = workflow.split(/^jobs:\r?\n/m)[1];
  assert.ok(jobs, 'missing jobs');
  assert.deepEqual(jobs.match(/^  [\w-]+:\s*$/gm), ['  merge-intent-guard:']);
  const steps = jobs.split(/^    steps:\r?\n/m)[1];
  assert.ok(steps, 'missing steps');
  assert.deepEqual(steps.trimEnd().split(/\r?\n/), [
    '      - uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.event.pull_request.base.sha }}',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '      - run: node tools/merge-intent-guard.mjs',
    '        env:',
    '          TITLE: ${{ github.event.pull_request.title }}',
    '          LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}',
    '          IS_DRAFT: ${{ github.event.pull_request.draft }}',
  ]);
});

test('CODEOWNERS assigns the guard surfaces to the maintainer', () => {
  const lines = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const path of ['/.github/', '/tools/merge-intent-guard.mjs', '/tests/merge-intent-guard.test.mjs', '/CODEOWNERS']) {
    assert.ok(lines.includes(path + ' @ARCHITECTARIEL'), 'missing owner for ' + path);
  }
});

test('CLI fails closed on a marked title', () => {
  const run = spawnSync(process.execPath, ['tools/merge-intent-guard.mjs'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, TITLE: 'WIP: x', LABELS: '[]', IS_DRAFT: 'false' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /::error::/);
});

test('CLI accepts clean intent', () => {
  const run = spawnSync(process.execPath, ['tools/merge-intent-guard.mjs'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, TITLE: 'Video OS release candidate', LABELS: '[]', IS_DRAFT: 'false' },
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^OK\s*$/);
});
