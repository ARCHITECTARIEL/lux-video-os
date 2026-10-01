# HeyGen application-key qualification research

Date: 2026-10-01  
Status: **official documentation verified; no HeyGen API request was made in this research lane**

This note answers only what HeyGen's current public documentation can prove before the application's exact API key is read. It does not treat the connected HeyGen UI/connector identity as the application's credential, and it does not infer a workspace identity from mutable profile fields.

## Qualification result

The documented read-only checks are:

1. `GET https://api.heygen.com/v3/api_keys/self` with `X-Api-Key` identifies the exact credential. Its documented response includes `key_id`, key metadata, status, scope mode, scopes, and expiration data. HeyGen says this endpoint works with any API key regardless of its scopes.
2. `GET https://api.heygen.com/v3/users/me` with the same `X-Api-Key` returns the authenticated profile and billing state. It requires `account:read`.

These checks qualify a credential and its capabilities, but they do **not** establish a canonical HeyGen account or workspace identifier. Neither documented response contains `user_id`, `workspace_id`, `team_id`, or `organization_id`. The current permission matrix, which HeyGen says is generated from its published OpenAPI metadata, exposes no separate public workspace/account-identity read endpoint. Searches of the official documentation for those identifiers returned no such endpoint.

Therefore:

- `key_id` may be used as the stable identity of the exact credential.
- `username`, email, names, plan, and balance must not become canonical provider-account authority. They are mutable and include private information.
- A hash of those profile fields is still only a hash of mutable fields; it does not repair the missing workspace identifier.
- Until independent workspace/account ownership evidence is supplied and reconciled, the normalized provider binding must remain **provisional/held**, even if both reads return `200`.

## Exact documented response shapes

[`GET /v3/api_keys/self`](https://developers.heygen.com/reference/get-current-api-key) returns a `data` wrapper with this documented example shape:

```json
{
  "data": {
    "key_id": "<string>",
    "key_name": "<string>",
    "status": "active",
    "scope_mode": "full",
    "scopes": ["<string>"],
    "created_at": "2023-11-07T05:31:56Z",
    "updated_at": "2023-11-07T05:31:56Z",
    "expires_at": "2023-11-07T05:31:56Z",
    "expires_in_seconds": 1
  }
}
```

The [API-key guide](https://developers.heygen.com/docs/api-key) defines `scope_mode` as `full`, `read_only`, or `custom`. The reference does not document every possible `status` value or clearly state timestamp nullability. A qualifier should require the known active state, parse timestamps strictly when present, and hold on unknown values instead of guessing.

[`GET /v3/users/me`](https://developers.heygen.com/reference/get-current-user) returns:

```json
{
  "data": {
    "username": "<string>",
    "email": "<string-or-null>",
    "first_name": "<string-or-null>",
    "last_name": "<string-or-null>",
    "billing_type": "wallet | subscription | usage_based | null",
    "wallet": {
      "currency": "usd | credits",
      "remaining_balance": 0,
      "auto_reload": {
        "enabled": false,
        "threshold_usd": null,
        "amount_usd": null
      }
    },
    "subscription": {
      "plan": "free | starter | creator | pro | team | enterprise | business_plus",
      "credits": {
        "premium_credits": { "remaining": 0, "resets_at": null },
        "add_on_credits": { "remaining": 0, "resets_at": null }
      }
    },
    "usage_based": {
      "spending_current_usd": 0,
      "spending_cap_usd": 0,
      "included_credits": 0,
      "remaining_credits": 0
    }
  }
}
```

Only the object selected by `billing_type` should be treated as authoritative. The user guide says the other billing objects are null. Profile and financial values belong in protected evidence, not stdout, Git, routine logs, or public receipts.

## Permission proof for this MVP

The official [API Key Permission Scopes](https://developers.heygen.com/docs/api-key-permissions) page says:

- `resource:write` also satisfies `resource:read` for that resource; read never satisfies write.
- Full-access keys use `*:*`.
- Read-only keys use `*:read`.
- Missing permission returns `403 insufficient_api_key_scope`.

The bridge's complete create/read/delete lifecycle needs:

| Purpose | Required documented scope |
| --- | --- |
| Read current user/billing | `account:read` |
| Upload, read, and later delete temporary assets | `assets:write` |
| Create, read, and later delete photo-avatar looks/groups | `avatars:write` |
| Clone, read, and later delete the instant voice | `voices:write` |
| Create, read, download, and later delete generated videos | `videos:write` |

A `read_only` key can support inventory checks but cannot support the MVP's create or deletion lifecycle. A `custom` key must have the exact resources above. This permission check proves declared key scope, not account-specific clone allowance or successful paid behavior.

## v2 versus v3

The official [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison) says v1/v2 remain operational only through **2026-10-31** and are legacy. Legacy responses carry `Deprecation: true`, a `Sunset: Sat, 31 Oct 2026 00:00:00 GMT` header, and a warning object. It maps:

`GET /v2/user/remaining_quota` -> `GET /v3/users/me`

The [Quick Start](https://developers.heygen.com/docs/quick-start) recommends v3 for new development. The qualifier should use only v3; the legacy quota endpoint is not fallback account proof.

## Photo-avatar and instant-voice fit

The official [Photo to Avatar guide](https://developers.heygen.com/docs/avatar-from-photo) documents:

- `POST /v3/avatars` with `type: "photo"` and one image supplied by public HTTPS URL, HeyGen `asset_id`, or inline base64.
- The returned `avatar_item.id` is the `avatar_id` used for video creation.
- Poll `GET /v3/avatars/looks/{look_id}` until processing ends.
- A completed look reports `supported_api_engines`; routing must use that readback rather than assuming an engine from a local tier name.
- Photo-avatar groups report `consent_status: null`, but HeyGen explicitly says the subject's permission is still required.

The official [Instant Voice Clone guide](https://developers.heygen.com/docs/voices/instant-voice-clone) documents:

- `POST /v3/voices/clone` accepts audio by public HTTPS URL, HeyGen `asset_id`, or inline base64 and returns `voice_clone_id`.
- Poll `GET /v3/voices/{voice_clone_id}` until `complete`, `failed`, or still `processing`.
- The clone uses HeyGen's Starfish engine and can narrate `POST /v3/videos` after completion.
- Each account has a clone allowance. Exceeding it returns `400 resource_limit_reached`; deleting a clone frees its slot.
- The published clone-create reference does not document an `Idempotency-Key` contract. An ambiguous create must be reconciled through read-only inventory rather than blindly retried.

These pages establish product/API fit. They do not prove that this exact credential has sufficient balance, clone allowance, engine availability, or successful output quality.

## Published API pricing

HeyGen's official [API Pricing Explained](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) article, marked last updated 2026-09-16 when scraped, says API purchasing is standalone pay-as-you-go and lists:

| Operation | Published self-serve rate |
| --- | ---: |
| Photo Avatar creation | **$1.32 / 26 credits per call** |
| Avatar IV Photo Avatar video | **$2.31 / 46 credits per generated minute**, charged by actual seconds |
| Avatar III Photo Avatar video | **$0.99 / 20 credits per generated minute**, charged by actual seconds |
| Starfish text-to-speech | **$0.12 / 2 credits per generated minute** |

The table has no distinct instant-voice-clone creation line, so this research does not assign it a zero or inferred price. It lists Avatar V pricing for Digital Twins but no Photo Avatar row; do not assume Photo Avatar V eligibility or price. The article also says self-serve API credits expire after 12 months, free API credits ended in February 2026, and the self-serve plan permits 10 concurrent video processes. Prices can change, so live qualification must store the publication date and require a fresh price gate before paid activation.

## Privacy and retention terms

The [Privacy Policy](https://www.heygen.com/privacy), last updated 2026-08-11 when scraped, says User Input can include voice, scripts, images, and videos. For non-enterprise service use, the policy describes model-improvement processing and an opt-out through `privacy@heygen.com`; HeyGen's [Security Practices](https://www.heygen.com/security) says Enterprise customer data is excluded from model training by default and non-enterprise customers may opt out.

The public policies do not establish that this account is Enterprise or that an opt-out has been applied to it. Those are separate account-bound evidence gates.

Published retention statements include:

- General personal information is kept as needed to provide/administer the service, maintain generated content, resolve disputes, enforce agreements, and protect safety/integrity.
- HeyGen says it strives to act on an information-deletion request within 72 hours unless retention is permitted or required by law.
- After information or an account is deleted, disaster-recovery backups retain it for 60 days before automatic permanent erasure.
- The [Biometric Information Privacy Notice](https://www.heygen.com/biometric-privacy-notice), last updated 2026-05-05, says verification-only biometric data is deleted promptly after comparison, typically within minutes.
- For EEA/UK/Swiss users, avatar-creation biometric data is retained while the avatar remains active and destroyed within 60 days after avatar deletion or account termination. Identifiable AI-training biometric data has a 60-day deletion target after an applicable objection/request, to the extent technically feasible; already non-extractable model weights are treated separately by the notice.

An API resource `DELETE 200` plus `GET 404` proves logical API absence only. It does not prove immediate physical purge, backup erasure, model-training exclusion, or revocation of a previously returned public CDN URL.

## Evidence boundary and next proof

Documented now:

- exact v3 qualification endpoints and `X-Api-Key` authentication;
- the credential's stable `key_id` field and declared scope metadata;
- the user/billing response structure;
- required MVP resource scopes;
- v1/v2 sunset date;
- photo-avatar and instant-clone API fit;
- public self-serve prices and privacy/retention statements.

Still unavailable until the exact application key is supplied through a protected runtime path:

- its real `key_id`, status, expiry, scope mode/scopes, and billing balance;
- whether the profile corresponds to the intended owner/workspace;
- a canonical provider workspace/account ID;
- real clone allowance, render engine eligibility, account-specific price treatment, or live output quality.

The safe first live action is a two-GET, read-only qualification capture against `/v3/api_keys/self` and `/v3/users/me`. It may create a credential-origin record and protected evidence, but it must not promote the provider binding to verified account/workspace ownership without separate stable account evidence.

## Research receipts

DeepAPI official-source discovery searches:

- account/key discovery: `673906d3-e942-4c1e-9071-f1535cc8af8e`, `9b9bbad2-5d88-42d2-8289-c7cb3d0a16d9`, `c79ddcb8-8771-4911-af6a-084ff94192ae`, `1d810187-1537-4275-be0e-2dca7594b0af`, `17c1818e-4a6f-4ff2-a460-9049aba5e298`
- workspace/organization field search: `21f35eae-2754-4a7d-b77a-e0ef88bd7c86`, `5c70cc33-0f90-4c2b-a91e-d8aa43ff1407`, `8c2950e3-2f6a-4118-b5a9-ea900b07af9d`, `c1e56ff1-0316-4704-a158-7b48e979c0a9`, `dc4ec197-7228-4703-8dab-9d47253d3598`
- v2/v3 discovery: `f2c67a61-3e90-44bd-9d11-4bce3d013990`, `768b7cd6-8bcc-4dc7-ba55-fd86e2d18391`, `777354e0-e11d-4081-a17a-7daa22a1d6e0`, `4bfdce34-9b37-461d-93fe-453d8d2d8914a1`, `119bf80b-261a-4810-b275-027d2d8914a1`

DeepAPI official-page scrapes:

- account/key/scopes: `e38a6a07-8263-449a-8d3d-d562b41e444e`
- exact reference schemas, capability, pricing, and privacy pages: `3ef260c8-5f0e-4f99-b1f8-03e538f3f108`
- version comparison, Quick Start, and changelog: `cfeddf92-ca80-4939-ade3-172989482ec1`

DeepAPI balance remained above the mandatory low-balance warning threshold. No HeyGen credential was read and no HeyGen request, upload, clone, render, deletion, feedback submission, or message was performed by this lane.
