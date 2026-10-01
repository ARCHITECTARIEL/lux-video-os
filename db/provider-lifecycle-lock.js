import { sql } from 'drizzle-orm';

export const PROVIDER_LIFECYCLE_LOCK_NAMESPACE = 'provider-lifecycle-v1';

function invalidAccount() {
  return Object.assign(new Error('Provider lifecycle account is invalid.'), {
    statusCode: 400,
    failureCategory: 'VALIDATION',
    code: 'INVALID_PROVIDER_LIFECYCLE_ACCOUNT',
  });
}

export function providerLifecycleLockInput(accountId) {
  const value = String(accountId || '');
  if (!value || Buffer.byteLength(value, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidAccount();
  return `${PROVIDER_LIFECYCLE_LOCK_NAMESPACE}:${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export async function acquireProviderLifecycleLock(tx, accountId) {
  const lockInput = providerLifecycleLockInput(accountId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockInput}, 0))`);
  return lockInput;
}

