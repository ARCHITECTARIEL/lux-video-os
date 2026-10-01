# Bridge design advisory review record

September 30, 2026. Scope: design/local implementation handoff only.

Two independent working native agents reviewed the design sequentially using installed architecture and critic guidance. The preset researcher/architect models were unavailable in this session; no formal native-role Ralplan consensus gate is claimed. No live provider operation or release approval follows from these reviews.

## Architecture

Initial required changes: exact consent-v2 and exposure permission; distinct withdrawal authority and old-consent handling; versioned/expiring account/API/engine qualification; normalized durable execution ledger; complete reference/tombstone graph; separate private URL custody; explicit proposed/verified/activated states.

Steelman alternative: retain provider raw assets for identity lifetime to avoid breaking derivatives, at the cost of prolonged exposure and a changed owner promise. A contracted private provider arrangement is another fallback with unverified availability/cost. Neither is an automatic fallback.

After revisions: APPROVE design/local implementation handoff. The per-account metadata serialization cost is acceptable for MVP. Canonical lock-key derivation and signature-byte/key-rotation contracts remain required implementation details before execution.

## Independent risk review

Initial verdict ITERATE: freeze a compatible account-first lock/tombstone order and establish approval authority beyond CLI digests/booleans.

After sequential architecture rereview and root revisions: APPROVE design/local implementation handoff. The design now defines account guard/order/cutover and a separate Ed25519 approval issuer with exact scope, nonce consumption, revocation and bounded resume. Tests 36-39 cover these; test 40 clarifies retained preview-URL exposure under the existing privacy proof principle.

## Limits

No actual source-dependency, CDN denial, API-key account, remote deletion, training opt-out, production migration, CI publication or P0 evidence is manufactured by review. The new deletion executor, consent UI and ledger remain planned. Read the canonical design and test specification before implementation.
