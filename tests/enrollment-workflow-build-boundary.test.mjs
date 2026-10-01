import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applySwcTransform } from '../node_modules/@workflow/builders/dist/apply-swc-transform.js';
import {
  identityEnrollmentHashWorkflowMetadata,
  identityEnrollmentExtractionWorkflowMetadata,
  identityEnrollmentCleanupWorkflowMetadata,
  identityEnrollmentExpiryWorkflowMetadata,
} from '../workflows/identity-enrollment-metadata.js';

test('real Workflow transform keeps enrollment I/O and the legacy poller in server steps', async () => {
  const enrollmentPath = 'workflows/identity-enrollment.js';
  const enrollment = await applySwcTransform(enrollmentPath, await readFile(enrollmentPath, 'utf8'), 'workflow');
  assert.doesNotMatch(enrollment.code, /from ['"](?:node:|\.\.\/(?:db|lib|services)\/)/);
  for (const [name, metadata] of Object.entries({
    identityEnrollmentHashWorkflow: identityEnrollmentHashWorkflowMetadata,
    identityEnrollmentExtractionWorkflow: identityEnrollmentExtractionWorkflowMetadata,
    identityEnrollmentCleanupWorkflow: identityEnrollmentCleanupWorkflowMetadata,
    identityEnrollmentExpiryWorkflow: identityEnrollmentExpiryWorkflowMetadata,
  })) assert.equal(enrollment.workflowManifest.workflows[enrollmentPath][name].workflowId, metadata.workflowId);

  const standardPath = 'workflows/standard-render.js';
  const standard = await applySwcTransform(standardPath, await readFile(standardPath, 'utf8'), 'workflow');
  assert.doesNotMatch(standard.code, /from ['"](?:node:|\.\.\/db\/)/);
  assert.equal(standard.workflowManifest.steps[standardPath].driveStandardJob.stepId, 'step//./workflows/standard-render//driveStandardJob');
});
