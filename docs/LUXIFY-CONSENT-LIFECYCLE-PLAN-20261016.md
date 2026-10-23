# LUXIFY cinematic consent renewal and withdrawal plan — October 16, 2026

**Status:** design for an optional, disabled feature. No consent capture, renewal, withdrawal or provider action was implemented or activated by this plan. This work is separate from the core Standard/Premium MVP and from the [0016 production compatibility preparation](PRODUCTION-0016-COMPATIBILITY-20261016.md).

## Current contract and gap

Migration `0015` adds `luxify_cinematic_consents` for an exact account, identity, source identity consent, private look, provider-space fingerprint, purpose, approval-evidence hash and expiry. No runtime route writes it. The pure eligibility resolver rejects expired or revoked cinematic consent, but it accepts a supplied consent projection; the future server repository must read and validate the source consent and evidence itself. The partial unique index treats a row as active while `revoked_at IS NULL`, even after expiry. An expired unrevoked row therefore blocks a new approval for the same look. Revoking an `identity_consents` source row does not update its cinematic children; the FK reacts to deletion, not a `revoked_at` update. Existing source withdrawal paths include `db/enrollment-repository.js` and `db/repositories.js`.

## Required additive schema decision

Preserve migration `0015` and every applied journal identity. Before activating renewal, add a separately reviewed **forward-only** migration after the current lineage. Do not claim index numbering until the Creative Base migration reservation is reconciled. Keep the current uniqueness guard. Add a terminal reason to distinguish `subject_withdrawal`, `source_withdrawal`, `renewed` and `expired_supersession` when setting `revoked_at`; add an optional predecessor link for an immutable renewal chain. A DB check/trigger should allow only a one-way active-to-terminal transition and prevent edits to account, identity, source-consent ID, look/space, policy, approval hash and acceptance/expiry evidence. Preserve all old rows; never overwrite an approval to renew it. Review the naming and customer-facing meaning of `revoked_at` and each reason with privacy counsel before freezing the migration.

## Capture and renewal transaction

1. The subject receives a private, separately worded cinematic-use request for the exact look and processing purpose. Authenticate the subject and bind a one-time challenge, policy version, notice version, evidence digest and source-consent identity. A client owner cannot manufacture the subject's approval. Retain evidence privately under an approved retention/deletion policy; a hash without a verifiable source is insufficient.
2. In one server transaction, take the existing account lifecycle advisory lock, then lock the owned identity, source consent, relevant look/resource and current cinematic rows in a documented order. Recheck account and subject authority, source-consent status and source-media hashes, look readiness, provider-space fingerprint and evidence. Use database time for `accepted_at` and an expiry no later than 365 days. Do not infer consent from a photo's lack of provider-side API consent status.
3. A same-key retry returns only an exact matching immutable receipt. A mismatched key or evidence conflicts. For a new, explicitly approved renewal, close the prior row with `renewed` or `expired_supersession` and insert a new row with a new idempotency key and evidence in the **same transaction**. An expired row stays unusable before that transaction, even though it occupies the current unique index. A new look, changed provider space or changed source consent requires fresh approval; never transfer an old grant by relabeling it.
4. Return a sanitized consent state to the subject and client. Quotes bind the exact consent ID/revision and look/space digest, but a signed quote is not authority by itself. Re-read the current consent and source state at quote, reservation, provider submission claim and final acceptance under the established lock order. A stale quote or old approval must fail closed without debit or provider mutation.

## Withdrawal and in-flight requests

Withdrawal is available to the subject through a private authenticated path, with a reviewed manual support path. Under the same account/identity lock order, make the transition idempotent, record actor/time/reason and close every affected active cinematic grant. Both existing source-consent revocation paths must close or invalidate dependent grants in the same transaction, and every downstream read must still join the live source-consent state. Keep historical receipts for the approved retention period; remove private evidence and provider resources through separately tracked deletion work.

After the transaction commits, no new quote, reservation, provider claim, retry, finishing or final acceptance may use the look. If a provider request is already in flight, do not pretend the external request stopped: mark the job/operation held or ambiguous, preserve its idempotency and provider request identity, reconcile late receipts, request provider cleanup where authorized, and block customer delivery. Do not automatically release credits while a billable outcome is unknown; settle exactly once after reconciliation or a documented manual decision. Existing provider and watchdog paths need explicit coverage for this race before activation.

## Acceptance tests and activation gates

- Exact subject approval; wrong subject/account/look/space/source denial; private evidence readback and retention; same-key replay and conflicting-key rejection.
- Expired-unrevoked renewal, early renewal, simultaneous renewals, renewal racing with subject/source withdrawal, and immutable predecessor/history checks on disposable PostgreSQL 18.6.
- Withdrawal at quote, reservation, claim, in-flight provider submission, late receipt, finalization and download; no new provider resource, leaked output or double credit settlement.
- Provider-space rotation, source-media replacement, revoked source consent, archived identity and removed look all fail closed. Verify owner, subject, anonymous and wrong-account views.
- Independent privacy/legal review of subject notice, evidence custody, withdrawal and deletion timing; real provider reconciliation and bounded pilot proof. Keep the feature flags off until these tests and approvals are recorded. Optional consent work must not block the core MVP release.

**Memory Protocol reversal:** revert this plan-only document after checking the worktree. No schema or external resource changed because of this document; do not treat its proposed migration or provider cleanup as authorized execution.
