import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createStandardNarrationRepository } from '../db/standard-narration-repository.js';
import { STANDARD_CONTRACT_VERSION, STANDARD_NARRATION_POLICY_VERSION } from '../lib/standard-narration-contract.js';

const id = '11111111-1111-4111-8111-111111111111';
const accountId = 'lock-test-owner';
const dialect = new PgDialect();

for (const action of ['grantConsent', 'revokeConsent', 'reserveRender']) {
  test(`Standard ${action} cannot reach row locks or writes before the account lifecycle guard`, async () => {
    const blocked = new Error('account lifecycle lock unavailable');
    let transactions = 0;
    const statements = [];
    const tx = {
      async execute(statement) {
        statements.push(dialect.sqlToQuery(statement));
        throw blocked;
      },
      select() { assert.fail('Row access preceded the account lifecycle guard.'); },
      insert() { assert.fail('Insert preceded the account lifecycle guard.'); },
      update() { assert.fail('Update preceded the account lifecycle guard.'); },
    };
    const repository = createStandardNarrationRepository({
      getDatabase: () => ({
        transaction(callback) {
          transactions++;
          // reserveRender first performs a read-only idempotency lookup. Model
          // its no-existing-job result, then exercise the real write callback.
          if (action === 'reserveRender' && transactions === 1) return Promise.resolve(null);
          return callback(tx);
        },
      }),
      activation: () => ({ ready: true }),
      schemaReadiness: () => ({ ready: true }),
    });
    const call = action === 'grantConsent'
      ? () => repository.grantConsent(accountId, accountId, {
        idempotencyKey: id, projectId: id, identityId: id, audioAssetId: id,
        policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true,
      })
      : action === 'revokeConsent'
        ? () => repository.revokeConsent(accountId, accountId, { consentId: id })
        : () => repository.reserveRender({
          jobId: id, accountId, idempotencyKey: id, correlationId: id, title: 'Lock ordering', format: 'vertical',
          input: {
            contractVersion: STANDARD_CONTRACT_VERSION, initiatingUser: accountId,
            quoteId: id, narrationConsentId: id, projectId: id, identityId: id,
            audioReference: { assetId: id },
          },
        });
    await assert.rejects(call, error => error === blocked);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /pg_advisory_xact_lock\(hashtextextended\(/);
    assert.deepEqual(statements[0].params, [`provider-lifecycle-v1:${Buffer.byteLength(accountId)}:${accountId}`]);
  });
}
