# Canary scope check

This is a local operator procedure. It does not activate provider creation or prove that a production deployment is running this code. The diagnostic reads environment gates only; it opens no database connection and makes no provider call.

1. Establish the reviewed deployment ID (`VERCEL_DEPLOYMENT_ID`), Git commit SHA (`VERCEL_GIT_COMMIT_SHA`), project ID (`VERCEL_PROJECT_ID`), and target manifest SHA-256 independently. The deployment ID is the exact value used by the DB binding diagnostic. Use the stable alias host `lux-video-os.vercel.app`, or the unique `VERCEL_URL` host with `--deployment-url-sha256` equal to SHA-256 of that lowercase host. Do not put a token or pin in the URL.
2. Put the intended account ID in a local, restricted pin file. Set `VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN` in the owner's local process without printing it. This dedicated token must differ from the admin and cron tokens.
3. Open `VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED=true` with `VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT` and `VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT` in UTC, no more than 30 minutes apart. The diagnostic accepts production `GET` only. Keep diagnostic maintenance admission active for `canaryScopeAsExpected=true`.

At the admin dispatch, a non-GET request with `operation=canary-scope` returns 405 with `Allow: GET`. A GET outside production (`VERCEL_ENV` unset, `development`, or `preview`) returns 404 with `diagnostic_unavailable` before operator authentication.
4. Run a dry run first. It prints the URL and non-sensitive request headers; the bearer token, pin, nonce, and MAC are not printed. Treat the nonce and MAC as sensitive request credentials. The command generates a fresh 32-byte nonce and computes HMAC-SHA256 locally over `vos-canary-pin/v1|SHA256(VERCEL_DEPLOYMENT_ID)|issued-at|trim(pin)`. The server accepts an ISO UTC timestamp within 60 seconds.

```powershell
node tools/canary-scope-check.mjs --url https://lux-video-os.vercel.app/api/video-os-lite/admin --pin-file C:\path\to\canary-pin.txt --deployment-id DEPLOYMENT_ID --git-commit COMMIT_SHA --project-id PROJECT_ID --target-manifest-sha256 MANIFEST_SHA256
```

5. Run the same command with `--send` to make **one GET**. It prints only response booleans and SHA-256 of the raw response body. Record those values and the deployment identity in the P0 evidence. The diagnostic returns 200 only when `canaryScopeAsExpected` is true; a 409 with booleans identifies a failed scope condition. A mismatched expected deployment, commit, project or target manifest returns 409 with all booleans false. Failures otherwise return only `{ok:false,code}`.
6. Close the window and rotate the operator token after the check. The in-memory nonce and rate counters are per server instance; a new instance can lose replay history. The 60-second timestamp, deployment binding, five authenticated requests per minute and 20 per window provide the remaining bounds.

Audit events `admin.canary_scope.checked` and `admin.db_binding.checked` currently emit one structured console line with only allow-listed boolean and code keys. This is console-only audit; a durable `ops_events` row for these event names remains open until OBS-001 is wired. Add the `DETAIL_KEYS` allow-list from `lib/operator-diagnostic-audit.js` to that durable sink and keep anonymous denials in the console. Never add the pin, a pin digest, nonce, MAC, token, flag string, count, or error text to audit details.
