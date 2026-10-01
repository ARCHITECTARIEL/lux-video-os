> Later owner decision: HeyGen is selected for both MVP tiers, with lower-cost research separate. The shared backend foundation has since been implemented; see [the newer execution note](20260930-shared-heygen-backend.md). Findings below preserve the earlier qualification checkpoint.

# Record-once scripted photo workflow: qualification and first repair

September 30, 2026. HEAD remains `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; changes remain uncommitted. **Owner requirements recorded, provider options screened, staged plan prepared, one bounded Premium parser defect repaired. Main enrollment/Standard script migration is not implemented.**

## Owner requirements and implementation proposal

The owner explicitly confirmed: upload a phone photo and record a phone video once, then use scripts for both Standard and Premium. The final presenter must animate the photo's appearance. This supersedes repeated Standard narration uploads and direct-video-only LatentSync as the target experience.

The proposed implementation extracts an internal voice-sample asset from the setup recording under explicit subject consent. It does not add a third user capture, use the video as the visual source, infer voice rights from upload alone, or require a trained digital twin. The code mapper initially proposed a separate mandatory voice recording; that suggestion was rejected because it conflicts with the owner's two-input capture requirement. Distinct consent scopes can govern an internally derived voice asset without adding a user upload.

Read [the implementation plan](../SCRIPTED-PHOTO-MVP-PLAN.md) and [owner record](../standard-provider-provenance/owner-decision.json). Backend choice remains pending: reuse HeyGen for both tiers initially or qualify a new self-hosted Standard photo-animation engine. The first is recommended for minimum implementation because existing v3 adapters already match the needed photo/voice/script operations; account economics, clone allowance, terms and actual output quality are not verified.

## Independent mapping and primary-source research

The native contract specialist mapped existing photo/voice storage, ownership, consent, async provisioning, Premium scripts and durable finishing. It confirmed Standard v1 is tied to uploaded narration and needs a new versioned contract. Existing Premium also permits explicit saved-project shared-voice choices; that policy was not silently removed.

Primary provider documentation was read through DeepAPI. HeyGen's current developer domain documents photo-avatar creation, instant voice cloning and script rendering, matching `services/heygen.js`. The legacy docs URLs initially returned no usable page; the official index led to the current pages, all of which returned content. Photo-avatar engine compatibility and account clone limits must be checked rather than inferred from tier names.

Self-hosted screening covered LivePortrait, InfiniteTalk, and the newer LongCat-Video-Avatar-1.5 path. The latter two document genuine image/audio generation, but are not qualified runtime replacements in this checkout. LivePortrait alone does not establish new-script speech/lip sync. No model weights, images or GPU resources were downloaded/built/run. [Sanitized source index](scripted-photo-20260930/provider-screening-evidence.json) preserves URLs, request IDs and hashes; raw responses stay outside Git. One initial InfiniteTalk `LICENSE` request returned 404; its temporary stale-response copy was replaced with an explicit failure record, and the actual `LICENSE.txt` was subsequently retrieved successfully. No failed request is counted as license evidence.

## Bounded code repair

Files changed:

- `lib/video-os-validation.js`: accept only optional literal `tier: 'PREMIUM'`, then remove the marker from canonical parsed output. Preserve strict validation and legacy omitted-tier payload semantics.
- `tests/render-request-validation.test.mjs`: regressions for the real browser marker, canonical equivalence/stripping, invalid/null/lowercase/Standard tier rejection, provider/identity/UUID constraints and rejected server-owned fields.

The new acceptance regression failed first with an unrecognized `tier` key. After the repair, focused Node validation tests passed 9/9, Vitest passed 4/4, imports passed for all eight API handlers, syntax checks passed and Git whitespace checks passed. The separate Standard schema, entitlements, authorized voice overrides, provider configuration and dependencies are unchanged. The implementation simplifies the boundary by normalizing a known client marker; it does not make provider/cost selection client-controlled.

Final `npm run test:unit` exited 0: **379 Node passes, 42 credential-dependent skips, zero failures; four Vitest passes**. `npm run build:preview` exited 0 with 39 routes, 93 steps and two workflows. [Verification receipt](scripted-photo-20260930/verification.json) records private log paths/hashes; [build summary](scripted-photo-20260930/build-review-summary.json) and [source ledger](scripted-photo-20260930/source-files.json) bind the exact candidate. The source comparison to Prompt 4 found only the two authorized repair files changed, and the project link is unchanged. Review output is quarantined and `.vercel/output` is absent. A successful preview does not clear the known Sandbox or production release gates. This candidate's source hash differs from Prompt 4 because of the two-file repair; retain the old receipts as dated evidence and use the new source/build record for subsequent work.

## Next implementation boundary

After recording the backend choice, execute the plan's bounded slices: private phone-video enrollment and derived-audio consent bindings; idempotent reusable avatar/voice provisioning; a shared script contract; versioned Standard migration; phone-first UI; isolated integration and separately authorized hosted proof. Do not reopen the settled record-once or scripts-for-both-tiers requirements.

No provider enrollment/render call, voice clone creation, customer-media upload to a provider, production migration, image publication, deployment or live billing activation occurred. Existing production DB/storage/Sandbox/CI/P0 prerequisites remain open.

Independent final review accepted the product/decision boundaries; its request for explicit test totals and a concrete receipt link was resolved above.
