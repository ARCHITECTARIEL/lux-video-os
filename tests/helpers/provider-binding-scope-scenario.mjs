import assert from 'node:assert/strict';
import { mock } from 'node:test';

import * as schema from '../../db/schema.js';

const accountId = 'provider-scope-owner';
const jobId = 'provider-scope-job';
const providerBinding = Object.freeze({ fixture: 'branded-binding' });
const authority = Object.freeze({
  bindingId: 'binding-current',
  originScopeKey: 'a'.repeat(64),
  verifiedAccountScopeId: 'scope-current',
});

mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
  assertFreshHeygenProviderClaimTx: (tx, input) => {
    assert.ok(tx); assert.equal(input.accountId, accountId); assert.equal(input.providerBinding, providerBinding);
    return authority;
  },
  assertHeygenProviderReceiptTx: () => authority,
} });

const { assertProviderJobReferencesActiveTx } = await import('../../db/provider-reconciliation-repository.js');

function executor(resource) {
  let referenceReads = 0;
  const reference = { resourceId: resource.id, consumerKind: 'job', consumerId: jobId, state: 'active' };
  const tx = {
    select() {
      let table;
      const query = {
        from(value) { table = value; return query; },
        where() { return query; },
        for() { return query; },
        limit: async () => {
          if (table === schema.providerResources) return [resource];
          if (table === schema.providerConsumerReferences) { referenceReads += 1; return [reference]; }
          throw new Error('unexpected table');
        },
      };
      return query;
    },
  };
  return { tx, referenceReads: () => referenceReads };
}

const baseResource = {
  id: 'resource-look',
  applicationAccountId: accountId,
  bindingId: authority.bindingId,
  originScopeKey: authority.originScopeKey,
  verifiedAccountScopeId: authority.verifiedAccountScopeId,
  kind: 'avatar_look',
  providerResourceId: 'provider-look',
  state: 'ready',
  tombstonedAt: null,
};

for (const [field, value] of [
  ['bindingId', 'binding-old'],
  ['originScopeKey', 'b'.repeat(64)],
  ['verifiedAccountScopeId', 'scope-old'],
]) {
  const fixture = executor({ ...baseResource, [field]: value });
  await assert.rejects(assertProviderJobReferencesActiveTx(fixture.tx, {
    accountId,
    jobId,
    providerBinding,
    expectedResources: [{ kind: 'avatar_look', providerResourceId: 'provider-look' }],
  }), { code: 'PROVIDER_RESOURCE_SCOPE_CONFLICT' });
  assert.equal(fixture.referenceReads(), 0, `${field} mismatch must fail before accepting the job reference`);
}

const matching = executor(baseResource);
assert.equal(await assertProviderJobReferencesActiveTx(matching.tx, {
  accountId,
  jobId,
  providerBinding,
  expectedResources: [{ kind: 'avatar_look', providerResourceId: 'provider-look' }],
}), true);
assert.equal(matching.referenceReads(), 1);
