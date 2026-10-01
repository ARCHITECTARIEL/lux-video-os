# Test specification: temporary provider bridge

Scope: proposed deletion/reconciliation implementation. These tests are acceptance requirements, not claimed current passes.

## Foundation coverage boundary (September 30)

The [foundation execution note](execution-notes/20260930-bridge-foundation.md) tracks the currently authorized implementation and exact results. Do not interpret a passing local suite as completion of all 40 requirements below.

| Area | Foundation coverage | Still required before activation |
| --- | --- | --- |
| Consent and browser | Explicit sixth permission, strict v2 payload, existing-source re-consent, safe lifecycle labels | Real-device and hosted flow proof; legal/product-claim review |
| Plan and approval | Canonical digest/signature, exact scope, expiry, trusted key, process-local verified approval | Production key custody/issuance, atomic application nonce/budget claims and resumable execution |
| Provider transport | Bounded GET parsing and mock-only DELETE response tests | App-key-bound real account/API behavior; deletion and source-dependency canaries |
| Ledger and lifecycle | Normalized provenance, immutable history, account guard, tombstone checks, read-only inventory | Final isolated database results are recorded in the execution note; cross-credential actions remain held |
| Retention proof | Distinct API absence, URL observation and retention outcomes | Old-URL denial, derivative preview exposure, private history survival, training/privacy terms and backup evidence |

The CLI's `execute` and `resume` remain disabled even with a syntactically valid signed envelope. External proof cases 24–29 and 40 remain independently gated.

October 1: an owner-approved, one-off neutral-asset probe verified key/profile/space association and exact asset DELETE acknowledgement plus API absence. It did not test public URL denial, derivative survival, other resource kinds or production P0. See [the scoped evidence](execution-notes/20261001-binding-readiness.md). Do not mark the full external cases complete from this subset.

## Unit and transport

1. Only exact server receipt paths produce candidates; malformed/unknown fields, names, raw URLs and client-provided IDs cannot grant deletion authority.
2. Changed account, target, policy, resource, source hash, plan digest or expiry rejects before DELETE.
3. Exact resource-specific404 codes are distinguished from401/403, wrong route,429,5xx and timeouts; ambiguous outcomes stay held.
4. Source assets wait for every derivative READY and a matching account/API/engine dependency qualification. Accepted creation is insufficient.
5. Operational cached asset IDs are not reused after deletion, while immutable audit evidence is retained.
6. Group cascade requires complete current provider membership; unknown/shared looks block group deletion. Last-look group absence is handled once.
7. Instant voice clone never assumes undocumented create idempotency. Professional voice PENDING and template-use blockers remain distinct.
8. API absence, public URL denial and backup retention are distinct; no success field conflates them.
9. Cleanup works with new-upload/render flags disabled, under separate withdrawal authorization.

## Real isolated database/storage

10. Concurrent deletion claims have one winner; no transaction spans HTTP.
11. New consumer attachment/submission during a deletion claim is blocked at its actual commit/submit boundary, including legacy identity-bound jobs.
12. Cross-identity/account/asset/receipt references and every nonterminal or ambiguous job block unsafe removal.
13. Provider success then DB write failure leaves a durable claim; exact resume records absence without recreating or losing the receipt.
14. A late provider acceptance or new ID after revocation changes the snapshot and invalidates an old plan. No no-ID ambiguity is declared complete.
15. Provider video cannot be deleted without accepted private final, exact hash/bytes and authorized-download evidence. Private history still works after provider removal.
16. Creation retry cannot overwrite an earlier remote resource/deletion journal; all attempts remain discoverable.

## Browser and consent

17. New exposure policy is explicit and unchecked; old consent cannot be upgraded silently. Declining sends no media to provider.
18. Re-consent uses existing owned byte hashes without another recording; changed source requires new authorization.
19. Neither raw provider URLs nor receipt/private account data enter DOM, browser storage or ordinary logs.
20. Ready/removal-requested/pending/observed-removed states remain truthful across reload and loss of connectivity; no duplicate creation.

## Observability

21. Every upload/delete/readback has correlation, timestamps, safe code and matching private receipt; telemetry uses digests, never secrets/media URLs.
22. Cleanup delay thresholds alert and contain as configured; tests use fake clock. Provider failure cannot be turned into an invented purge guarantee.
23. Reconciliation lists unknown operations, active references, template blockers and still-accessible URLs as actionable holds; no bulk-delete shortcut.

## External proof, separately authorized

24. App-key account/scopes are bound to the approved envelope; connector identity alone fails.
25. Disposable asset baseline anonymously yields exact fixture bytes; delete/readback and repeated old-URL denied responses are observed under the same account.
26. Ready avatar/voice remains usable after raw asset removal; one new-script job per enabled tier proves reuse and exactly-once charge.
27. Private validated output survives remote-video cleanup and fresh-session history/download/denial checks.
28. Revoked disposable identity cleanup proves look/group cascade and voice blockers without touching any pre-existing resource.
29. No unexpected credit usage or API count/retry expansion; stop on first boundary breach. Distinguish observed CDN denial from global/backup purge.

Final verifier binds the exact source ledger/build/project/target and all test/private receipt hashes. Production P0, database/storage migration and owner execution authorization remain independent gates.

## Architecture-review additions

30. Exact `identity-provider-bridge-v2` and `temporaryPublicProviderExposureAuthorization` are required for new exposure; legacy consent cannot grant it. Withdrawal works without active creation consent.
31. Normalized unique resource/operation rows prevent duplicate ownership/claims; append-only events survive retries and customer-record lifecycle decisions without losing origin IDs.
32. Qualification expiry, account/API/engine changes and changed request semantics close the gate; credential rotation requires account/scope rebind.
33. Raw URLs are separate private evidence objects with retention deadlines; audit/DTO/log outputs contain only digests/references.
34. Broader model-training opt-out/contract evidence is separate from customer-specific voice/avatar creation and from file deletion.
35. Per-enrollment raw uploads are not shared; unknown external/template consumers block automatic cleanup. Canonical lock order and tombstones are tested across every attach path.

## Independent risk-review additions

36. Real multi-session tests cover reserve versus delete, submit versus revoke, finalization versus cleanup, and attachment versus tombstone. All mutations take the account-lifecycle guard before row locks and follow the frozen order; no deadlocks, unsafe references or duplicate claims. Unconverted legacy paths fail closed.
37. Approval rejects missing/forged signatures, untrusted keys, changed plan/resource/candidate/account/verb/budget/cohort, expiry, revocation and nonce replay before provider access. Caller digests/env booleans cannot authorize.
38. Nonce consumption and deletion claim commit atomically. Exact resume cannot start another operation or reset signed call/spend budget. Worker credentials cannot issue owner/child approvals.
39. Automatic cohort/withdrawal issuance requires separately approved policy and independent evidence; a disposable canary cannot authorize general customer cleanup.

40. Canary inventory includes retained avatar/look/voice preview URLs. Raw-asset deletion cannot close unrelated derived-preview exposure; observed ongoing access returns the policy decision to the owner before activation.
