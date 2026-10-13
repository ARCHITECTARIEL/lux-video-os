# Video OS pricing status

This is an internal pricing decision record, corrected on 2026-10-12 against source `673cd0198cebaac8b46032fc91a9d0cc53d6f9c7`. It describes local contracts, an owner package proposal, and dated provider research. It is not evidence that billing, these prices, or the zero-credit policy are active in production.

## Current LUX-credit contracts

Video OS assigns render prices in **LUX credits**, using a server-issued quote before confirmation. The current source does not establish one universal render price:

| Workflow | Local price contract | Status boundary |
| --- | --- | --- |
| Scripted-photo Premium | Fixed at **90 LUX credits** in `lib/scripted-photo-contract.js` | Applies only to this workflow when its feature and release gates are enabled. |
| Scripted-photo Standard | A positive integer from `VIDEO_OS_STANDARD_SCRIPTED_CREDITS` | There is no default. Missing or invalid configuration makes Standard unavailable. The value must be verified at the exact deployment before it is published. |
| Legacy Standard narration | Fixed at **90 LUX credits** in `lib/standard-narration-contract.js` | Its pricing and policy versions remain `-proposed`, and its activation gates default closed. It is not proof of an approved or generally available 90-credit Standard price. |
| LUXIFY | Separate, held mode with resolution-specific configured LUX-credit quotes | The held LUXIFY candidate is outside this committed baseline and the Welcome offer. Its draft pricing must remain separate from Standard and Premium claims until it is integrated, approved, and verified. |

Do not describe every Standard or Premium render as 90 credits, and do not derive pack-level video counts from that assumption. Public copy should say that the current workflow and format receive a quote before confirmation.

## LUX credits and provider credits are different units

- **LUX credits** are the application's customer-facing ledger and quote unit.
- **HeyGen API credits** are a provider billing unit reported in HeyGen's pricing material.
- There is no approved exchange rate between the two. A quote of 90 LUX credits does not mean 90 HeyGen API credits.
- There is no global **$0.06 per LUX credit** decision. The owner package proposal below implies $0.060 for Starter and $0.048 for Growth and Studio, before promotions, fees, refunds, or other adjustments.

## Dated HeyGen cost evidence

`services/heygen.js` submits `POST /v3/videos` with `type: "avatar"` and currently omits `engine`. The code shape alone does not identify the billed engine. The local official-source capture says that omission selected Avatar IV when researched, while a completed photo-avatar look separately reports its supported API engines. The actual default, account eligibility, and account-specific billing still require fresh qualification before paid activation. An explicit supported engine should be bound to the request and pricing gate, or economics should use a freshly qualified documented default.

The repository's official-source capture records the following **dated evidence**, from a HeyGen pricing article marked updated 2026-09-16:

| Provider operation | Published self-serve rate on that date |
| --- | ---: |
| Photo Avatar creation | **$1.32 / 26 HeyGen API credits per call** |
| Avatar IV Photo Avatar video | **$2.31 / 46 HeyGen API credits per generated minute**, charged by actual seconds |
| Avatar III Photo Avatar video | **$0.99 / 20 HeyGen API credits per generated minute**, charged by actual seconds |
| Starfish text-to-speech | **$0.12 / 2 HeyGen API credits per generated minute** |

Sources: `docs/execution-notes/heygen-release-20260930/heygen-official-research.md` and `docs/execution-notes/heygen-binding-20261001/official-research.md`. These records are research snapshots, not current account or checkout evidence. The captured pricing table has no distinct instant-voice-clone creation rate, so no zero-cost assumption is valid.

The 900-character script limit is a text validation limit. It does not establish a 90-second or other maximum generated duration. Provider cost depends on actual generated seconds and may also include avatar creation, voice lifecycle costs, retries or failed attempts, finishing, storage, delivery, payment fees, promotions, refunds, and support. No gross-margin percentage is approved until those costs and the actual LUX-credit sale price are measured together.

The current shared scripted MVP selects HeyGen for Standard and Premium. RunPod cost projections in `docs/LOW-COST-RENDERING-RESEARCH.md` are separate alternative-provider research; they are not an active Standard price basis or margin proof.

## Owner package proposal, not active checkout proof

The current owner proposal is encoded in `tools/setup-stripe-products.mjs`:

| Pack | LUX credits | Proposed price | Implied proposed price per LUX credit |
| --- | ---: | ---: | ---: |
| Starter | 500 | $30 USD | $0.060 |
| Growth | 1,000 | $48 USD | $0.048 |
| Studio | 2,000 | $96 USD | $0.048 |

These dollar amounts are planned setup inputs. Runtime checkout in `api/video-os-lite/checkout-v2.js` knows only the pack credit quantity and an opaque `STRIPE_PRICE_ID_*`; it does not verify a dollar amount against this document. Billing remains deferred for the Welcome work. Before any public dollar price or purchase-ready call to action is treated as live, read back the intended Stripe account and mode, active one-time Price IDs, USD amounts, package metadata, webhook configuration, and `VIDEO_OS_BILLING_ENABLED` at the exact target.

## New-account credit policy: local candidate only

The local source sets `DEFAULT_TRIAL_CREDITS = 0` for regular new accounts. Internal tester grants use a separate path, and this policy change does not zero balances already held by existing accounts.

This is a local, undeployed policy candidate. It does not prove the current production source, environment, or a fresh production account balance. The backend policy and customer copy must ship from the same reviewed source, followed by stable-target verification that a fresh regular account starts at zero and an existing credited account keeps its balance.

## Decisions still required

1. Approve the final credit-pack offer and decide whether dollar amounts remain off Welcome until checkout is verified.
2. Set and verify the scripted-photo Standard LUX-credit price; keep workflow-specific quotes instead of declaring a universal price.
3. Keep LUXIFY outside Standard/Premium pricing until its separate mode, prices, and release status are approved.
4. Bind or freshly qualify the HeyGen engine, supported account capabilities, current provider rates, and actual-duration policy.
5. Build a complete unit-economics model before approving margin claims.
6. When billing work resumes, verify the exact checkout configuration and webhook before treating the proposed packs as purchasable.
7. Promote and verify the zero-default-credit policy before describing it as live.
