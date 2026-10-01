# Bridge consent UI review

Date: September 30, 2026  
Scope: `public/identity.*`, `public/enrollment-client.js`, and scoped identity tests only

## Review findings

1. The current wizard already supplies the right hierarchy, previews, keyboard containment, and account-scoped recovery. A sixth wizard step would add friction and weaken source-to-consent continuity.
2. The existing provider-processing line is too broad to disclose public-link exposure. The exposure permission must remain separate and unchecked.
3. Public-link access, reusable identity retention, and backup retention are three distinct facts. Combining them would obscure the decision.
4. Cleanup status must not replace identity readiness. The card and ready panel need a secondary server-backed lifecycle message where the DTO provides it.
5. Re-consent should open the existing consent panel with owned previews and locked source identity. Browser storage remains limited to the existing enrollment ID and idempotency keys.

## Arbiter decision

Preserve the current wizard and consent-card language pattern. Add one concise disclosure panel plus a visually distinct sixth consent row, use six-permission validation, and integrate only the backend's frozen DTO/action names. Status copy will be a small secondary line driven by explicit readiness/deletion flags.

## Rejected directions

- A separate legal wall before the wizard: rejected because it separates disclosure from the exact media and permissions being authorized.
- Folding exposure into provider-processing consent: rejected because it would silently broaden an existing scope.
- Auto-checking the new permission for prior customers: rejected because old consent is not `identity-provider-bridge-v2` consent.
- Showing provider URLs or receipt hashes as proof: rejected because they are sensitive implementation evidence and not customer-facing verification.
- Treating removal requested or API absence as full deletion: rejected because backup retention and URL denial are independent facts.

## Implementation readback

- Fresh enrollment keeps the existing `consent` action and sends policy `identity-provider-bridge-v2` plus the sixth explicit exposure literal only after all six unchecked controls are selected.
- Ready legacy identities expose a separate `Review provider consent` action. It uses the three exact account-owned DTO hashes, sends no `File` or URL payload, stores no hashes in browser storage, and does not invoke identity/provider submission.
- An uncertain re-consent result performs a DTO readback before the UI reports success; it does not submit a second request automatically.
- Identity cards fail closed when v2 consent is absent or the owned sources are unavailable. Lifecycle labels come only from the safe server state and never render blockers, provider URLs, evidence references, or hashes.
- The mobile re-consent footer uses a full-width action after screenshot review found and corrected a half-width wrapped button.

## Verification

- Focused Node contracts: 14 passed.
- Identity interaction suite: 19 passed on isolated port 4197 and output `test-results-bridge-consent-ui-agent`.
- Scoped visual suite: 4 passed; ten desktop/mobile evidence images and SHA-256 values are recorded in `bridge-consent-screenshot-manifest.json`.
- Client privacy scanner: passed unchanged.
- Visual verdict: 94/pass in `.omx/state/bridge-consent-ui/ralph-progress.json`.

The screenshots use mocked owned media and establish UI behavior only. They do not prove real provider readiness, cleanup, URL denial, backup purge, production schema state, or deployment.
