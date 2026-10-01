import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function fail(message) {
  const error = new Error(message);
  error.code = 'STRIPE_RECONCILIATION_GATE';
  return error;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw fail(`Response field ${field} must be a non-negative integer.`);
  }
  return value;
}

export function evaluateStripeReconciliationResponse({ httpStatus, body }) {
  const status = Number(httpStatus);
  if (!Number.isInteger(status) || status !== 200) {
    throw fail(`Reconciliation request returned HTTP ${Number.isInteger(status) ? status : 'unknown'}.`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw fail('Response body must be a JSON object.');
  }
  if (body.ok !== true) {
    throw fail('Response did not explicitly report ok=true.');
  }
  const reconciliation = body.reconciliation;
  if (!reconciliation || typeof reconciliation !== 'object' || Array.isArray(reconciliation)) {
    throw fail('Response is missing the reconciliation result object.');
  }

  const sessionsChecked = requireNonNegativeInteger(reconciliation.sessionsChecked, 'reconciliation.sessionsChecked');
  const creditTransactionsChecked = requireNonNegativeInteger(
    reconciliation.creditTransactionsChecked,
    'reconciliation.creditTransactionsChecked',
  );
  const mismatchCount = requireNonNegativeInteger(reconciliation.mismatchCount, 'reconciliation.mismatchCount');
  if (!Array.isArray(reconciliation.mismatches)) {
    throw fail('Response field reconciliation.mismatches must be an array.');
  }
  if (reconciliation.mismatches.length !== mismatchCount) {
    throw fail('Response mismatch count is inconsistent with the mismatch list.');
  }
  if (mismatchCount !== 0) {
    throw fail(`Reconciliation reported ${mismatchCount} mismatch(es); inspect protected operational notifications for details.`);
  }

  return { sessionsChecked, creditTransactionsChecked, mismatchCount };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw fail('Use --status <code> --file <response.json>.');
    values.set(flag, value);
  }
  if (!values.has('--status') || !values.has('--file')) throw fail('Use --status <code> --file <response.json>.');
  return { httpStatus: values.get('--status'), file: values.get('--file') };
}

async function main(argv = process.argv.slice(2), io = console) {
  const { httpStatus, file } = parseArguments(argv);
  let body;
  try {
    body = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw fail('Reconciliation response is missing or is not valid JSON.');
  }
  const summary = evaluateStripeReconciliationResponse({ httpStatus, body });
  io.log(
    `Stripe reconciliation clean: sessions=${summary.sessionsChecked}, `
    + `creditTransactions=${summary.creditTransactionsChecked}, mismatches=0.`,
  );
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    console.error(`::error::Stripe reconciliation gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
