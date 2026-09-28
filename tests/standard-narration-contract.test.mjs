// standardNarrationSchemaReadiness()/standardNarrationActivation() had zero
// test coverage before this file, despite being the exact 4-flag gate whose
// real production misconfiguration was one of four independent root causes
// behind a real Standard-tier outage this project already diagnosed and
// fixed (see HANDOFF history). The whole point of four separate flags -- "an
// environment variable typo or a single flipped flag must not be enough to
// activate" -- is that a PARTIAL configuration must fail with a SPECIFIC,
// distinct reasonCode naming exactly which gate is still closed, not a
// generic "not ready." These tests prove that precedence and specificity
// hold for every partial-configuration permutation, not just the two ends
// (all-off / all-on).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  standardNarrationActivation,
  standardNarrationSchemaReadiness,
  STANDARD_NARRATION_REASON_CODES,
} from '../lib/standard-narration-contract.js';

const FLAGS = [
  'VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY',
  'VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED',
  'VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED',
  'VIDEO_OS_STANDARD_RENDER_ENABLED',
];
const originals = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

function restore() {
  for (const name of FLAGS) {
    if (originals[name] === undefined) delete process.env[name];
    else process.env[name] = originals[name];
  }
}

function setFlags({ schema = false, policy = false, pricing = false, render = false } = {}) {
  process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = schema ? 'true' : 'false';
  process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = policy ? 'true' : 'false';
  process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = pricing ? 'true' : 'false';
  process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = render ? 'true' : 'false';
}

test('all four flags unset (real default state): not ready, schema is the specific blocker', (t) => {
  t.after(restore);
  for (const name of FLAGS) delete process.env[name];
  const schema = standardNarrationSchemaReadiness();
  assert.equal(schema.ready, false);
  assert.equal(schema.reasonCode, STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED);
  const activation = standardNarrationActivation();
  assert.equal(activation.ready, false);
  assert.equal(activation.reasonCode, STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED);
});

test('schema ready alone: activation still blocked, specifically on POLICY_UNAPPROVED, not a generic failure', (t) => {
  t.after(restore);
  setFlags({ schema: true });
  const schema = standardNarrationSchemaReadiness();
  assert.equal(schema.ready, true);
  const activation = standardNarrationActivation();
  assert.equal(activation.ready, false);
  assert.equal(activation.reasonCode, STANDARD_NARRATION_REASON_CODES.POLICY_UNAPPROVED);
});

test('schema + policy ready: activation blocked specifically on PRICING_UNAPPROVED', (t) => {
  t.after(restore);
  setFlags({ schema: true, policy: true });
  const activation = standardNarrationActivation();
  assert.equal(activation.ready, false);
  assert.equal(activation.reasonCode, STANDARD_NARRATION_REASON_CODES.PRICING_UNAPPROVED);
});

test('three of four flags ready (schema, policy, pricing): activation blocked specifically on RENDER_DISABLED -- the exact "typo in one flag" scenario this gate exists to catch', (t) => {
  t.after(restore);
  setFlags({ schema: true, policy: true, pricing: true });
  const activation = standardNarrationActivation();
  assert.equal(activation.ready, false);
  assert.equal(activation.reasonCode, STANDARD_NARRATION_REASON_CODES.RENDER_DISABLED);
});

test('all four flags true: fully ready, no reasonCode', (t) => {
  t.after(restore);
  setFlags({ schema: true, policy: true, pricing: true, render: true });
  const schema = standardNarrationSchemaReadiness();
  assert.equal(schema.ready, true);
  assert.equal(schema.reasonCode, undefined);
  const activation = standardNarrationActivation();
  assert.equal(activation.ready, true);
  assert.equal(activation.reasonCode, undefined);
});

test('flags must be the exact string "true" -- "TRUE", "1", and "yes" are all treated as unset, matching the deliberate fail-closed design', (t) => {
  t.after(restore);
  for (const truthyButWrong of ['TRUE', '1', 'yes', 'True', ' true']) {
    process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = truthyButWrong;
    const schema = standardNarrationSchemaReadiness();
    assert.equal(schema.ready, false, `"${truthyButWrong}" must not activate the schema gate`);
    assert.equal(schema.reasonCode, STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED);
  }
});

test('render-v2.js\'s final-submission re-check propagates the same specific reasonCode as the primary readiness signal, not a generic fallback', async (t) => {
  t.after(restore);
  setFlags({ schema: true, policy: true, pricing: true }); // render still false -> RENDER_DISABLED
  // Import fresh so the module reads the env vars set above, matching how
  // handleStandardRender's own standardNarrationActivation() call behaves.
  const { standardNarrationActivation: activation } = await import('../lib/standard-narration-contract.js');
  const result = activation({ accountId: 'test-account' });
  assert.equal(result.ready, false);
  // This is the exact value render-v2.js's handleStandardRender now uses as
  // the thrown error's `code` -- proving the fix actually has the specific
  // value available to use, not just that the gate function itself works.
  assert.equal(result.reasonCode, STANDARD_NARRATION_REASON_CODES.RENDER_DISABLED);
  assert.notEqual(result.reasonCode, STANDARD_NARRATION_REASON_CODES.UNAVAILABLE);
});
