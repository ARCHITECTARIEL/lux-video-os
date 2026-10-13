# Diagnostic maintenance admission gate

This candidate adds a **default-off** application gate for a separately
approved diagnostic maintenance deployment. With
`VIDEO_OS_DIAGNOSTIC_MAINTENANCE=true`, every deployed API function
returns a no-store `503 diagnostic_maintenance_active` response except
the byte-exact `GET /api/video-os-lite/admin?operation=db-binding` route.
That route continues through its existing dedicated-Bearer,
short-lived, target/deployment/source-bound read-only diagnostic. The
gate never treats an ordinary admin token, cron token or cookie as
diagnostic authorization. Absent or literal `false` preserves ordinary
behavior. Any other configured value fails closed with
`503 maintenance_configuration_invalid`.
The diagnostic's **successful binding attestation now additionally
requires** this maintenance mode to be active. It returns a boolean
`maintenanceAdmissionActive`; absent, false or malformed mode prevents
the DB query and a success receipt. This closes a false-attestation
path where all older render/billing flags were off but other write
routes remained reachable.

The admission check is the first handler statement in all nine Vercel
`api/` function files. It runs before handler-side request parsing,
rate-limit writes, account/job/credit changes, Blob operations,
external provider/Stripe/AI calls and Workflow starts. The workspace
function checks before dispatching its eleven nested route handlers.
The exact diagnostic URL has no optional query fields, encodings or
trailing slash at this boundary. Direct function-file paths and other
methods remain blocked. The maintenance mode has **no automatic
expiry**: if the diagnostic token/window expires, all other API paths
stay blocked until a separately reviewed cleanup or deployment change.

## Callback and schedule handling for a future window

- A blocked Stripe webhook receives non-2xx `503` before event parsing,
  credit grant or acknowledgement, with `Retry-After: 60`. This signals
  retry rather than reporting an unprocessed payment as credited.
  Provider retry duration is not assumed. Before any maintenance window,
  inventory pending paid sessions/events; afterward compare Stripe's
  paid sessions to the DB event/credit ledger through read-only evidence.
  Missing events or grants require a separate reconciliation/repair
  decision; do not manually replay or issue credits under this gate.
- A blocked Vercel Blob enrollment-upload callback receives `503`
  before `handleUpload`, DB acceptance or Workflow dispatch. Previously
  issued direct multipart tokens may still upload an object to Blob,
  and callback retry is not assumed. Inventory unexpired capabilities
  before the window; after it, reconcile exact private object identity,
  enrollment row/state and callback delivery. Cleanup or acceptance is
  separate authorized work.
- Magic-link/Google callbacks receive `503` and may need a fresh user
  sign-in attempt after the window. The gate blocks their account,
  entitlement, credit, token-consumption and sign-in writes.
- The watchdog and Stripe GitHub schedules must be paused under a
  separate approval, with no queued or running invocation before the
  protected window. Disabling future triggers does not stop an already
  running request. On restoration, verify the alias and application
  state first, then restore only those two workflows; do not replay a
  failed scheduled run without its own review.

## Scope limits and release boundary

This gate applies only to **new HTTP requests on deployments that
include and activate it**. It does not change the old active deployment
or historical unique URLs, revoke issued Blob upload tokens, stop an
already-running HTTP invocation, Vercel Workflow, provider job or VPS
worker, or suppress direct privileged console/CLI writes. A maintenance
error injected into existing Workflow steps might enter failure paths
that release credits, so this candidate deliberately does not alter
those steps. Fresh exact-job, all-consumer, upload-capability and
provider/credit receipts are required before any production transition.

The gate is one containment layer for a diagnostic-only, production-target
staging plan. It does **not** attest deployed source bytes, prove the old
active app's database binding, grant a diagnostic exception, authorize an
alias transition, repair a canceled job, release credits, enable provider
creation/rendering/billing/enrollment, or satisfy ordinary P0/MVP gates.
If the stable alias is rolled back to the old deployment, this gate no
longer protects that alias and the new deployment's binding receipt is
invalid for subsequent repair.

For local production-target packaging, the browser-client generator
leaves tracked vendor files untouched when its output differs only by
checkout LF/CRLF representation. The diagnostic build compares source
identity before and after generation and rejects a dirty or changed
source. Its exact path policy includes only this guard, tests, review
note, and previously reviewed diagnostic files. Packaging still records
`database.verified:false`, `exceptionGranted:false` and
`releaseAuthorized:false` until separate evidence and approvals exist.
