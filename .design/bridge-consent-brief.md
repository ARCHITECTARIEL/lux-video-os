# Bridge consent UI brief

Status: approved for the scoped local UI lane  
Date: September 30, 2026

## Purpose

Extend the existing five-step identity wizard for consent policy `identity-provider-bridge-v2`. Keep the five existing permissions and add one separate, initially unchecked `temporaryPublicProviderExposureAuthorization` permission. Existing consent must never be treated as this permission.

## Reference evidence

- Existing LUX consent screenshots and `.design/visual-brief.md` remain the visual source of truth: Geist, white surfaces, blue actions, bordered consent rows, visible focus, and the same desktop/mobile wizard.
- Existing Sprig and Edits references support explaining why access is needed before requesting it and keeping controls explicit.
- [Lazyweb consent reference set](https://www.lazyweb.com/agentic-search/ac2536f0-ee93-46aa-9b1b-7404c285d144) adds three interaction precedents: plain-language third-party sharing disclosure, a short detail block before action, and purpose-before-permission hierarchy. Patterns only; no brand or copy is reused.

## Product direction

- Add a compact disclosure block immediately before the authorization list so the public-link consequence is read before the new checkbox.
- Say plainly that the temporary provider photo and voice files can be accessed by anyone with the link.
- State separately that the reusable provider identity remains for future scripts until withdrawal and that API/access removal does not certify deletion from provider backups.
- Keep all six permissions individually selectable and unchecked. Declining or leaving any permission unchecked stops the flow before any provider upload.
- Re-consent must reuse the account-owned photo/video source when still valid; it must not ask for a new recording or store source/hash/provider details in browser storage.
- Never place provider URLs, receipt IDs, technical hashes, or private account data in the DOM.

## Status language

Use only server-reported facts. Customer labels may include `Preparing presenter`, `Removing temporary provider files`, `Ready`, `Removal requested`, and `Needs attention`. A ready identity may still show temporary-file removal pending. Never say `deleted everywhere`, `backup purged`, or imply a provider call happened because a checkbox was checked.

## Layout and accessibility

- Reuse current consent cards and responsive modal. Add no new dependency or navigation step.
- Disclosure text is at least 14px/1.5 and does not collapse behind an interaction.
- New checkbox joins the existing keyboard order, error focus, source-change clearing, and account-scoped resume behavior.
- Preserve native camera cleanup and the photo/video previews.

## Acceptance

- Six unchecked authorizations are required under `identity-provider-bridge-v2`; the sixth request field is `temporaryPublicProviderExposureAuthorization: true` only after explicit selection.
- Legacy enrollment states route to re-consent when the server marks it required, using owned previews/sources without rerecording.
- Refusal or incomplete consent cannot call a provider action.
- Readiness and cleanup-pending UI derive only from backend flags and survive refresh without local invention.
- Focused Node contract tests and Playwright tests cover unchecked consent, disclosure, payload, re-consent, redaction, mobile overflow, and preserved media behavior.
