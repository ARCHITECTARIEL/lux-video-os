# Persisted final-output acceptance contract

Introduced by Prompt 2, 2026-09-29. The read-side authority is `lib/video-os-output-acceptance.js`. Prompt 3 now implements real validation in `services/final-media-validation.js`, actual stored-byte verification in `services/accept-stored-final-output.js`, and atomic acceptance/debit in `db/repositories.js`.

## Producer and storage

The trusted server-side validator now writes `videoJobs.output.acceptance` together with the exact final artifact. No database migration is needed: output already persists JSON. Neither a client flag, provider response, status `ready`, header check, admin review nor successful upload may synthesize this record.

Required shape:

```js
output = {
  privatePathname, bytes, sha256, filename,
  acceptance: {
    version: 1,
    policy: 'video-os-media-v1',
    validatorVersion, // actual validator/tool version, never a client value
    status: 'accepted',
    accountId, jobId,
    privatePathname, bytes, sha256, // exact equality with final artifact
    validatedAt, // valid timestamp string
    media: {
      fullDecode: true,
      videoStreams, audioStreams, // positive integer counts
      width, height, // positive integers
      durationMs, // positive finite number
    },
    checks: { duration: true, dimensions: true, byteLimit: true },
  },
};
```

The pathname must exactly match `finalOutputPath(accountId, jobId, sha256)`, the existing writers' `video-os/finals/<safe account>/<safe job>-<sha256>.mp4` convention. SHA is lowercase 64-hex; bytes is a positive safe integer. Account/job/provider/status are server-held fields. Evidence binds to the same account, job, path, hash and byte count. Unsupported policy/version/provider, missing checks or mismatches fail closed.

The helper checks structural validity and binding of **persisted trusted evidence**. The read-side helper itself does not inspect bytes. The producer fully decodes actual stored media, checks H.264/AAC and policy, hashes it, and binds it before finalization; downloads separately hash every byte before responding. Boolean checks come from real validation, not synthetic test records.

## Consumers

- `jobDto`: supplies `tier` (`standard` for sadtalker, `premium` for heygen) and `outputAccepted`; hides internal evidence, private pathname, account binding and artifact digest.
- History: uses the real DTO for each owned record.
- Finalize/status: ready=true/200 only for accepted available output; pending acceptance remains ready=false/202; deleted output is 410.
- Download: repeats the shared predicate before reading storage, with anonymous 401, wrong owner 404, unvalidated 409 and deleted 410.
- Ready email: only newly completed, accepted, nondeleted output triggers notification.
- Browser: acceptance and availability are distinct. Deleted accepted output stays terminal but has no preview/download URL. Unvalidated ready output shows acceptance pending.

## Legacy and deployment consequences

Every existing ready output lacking this record is unaccepted. Prompt 3 now creates evidence at the shared repository boundary after re-reading and decoding the private final object. Legacy ready jobs still require separate revalidation; they are not silently backfilled. No automatic backfill, re-debit, refund, migration, email or synthetic approval is performed. Already charged legacy rows retain their accounting; remediation is a separate explicit task.

Prompt 3 enforces full decode, exactly one H.264 video/AAC audio stream, canonical dimensions, positive duration up to 180 seconds and positive size up to 100 MiB. Stream/source timing tolerance is max(500 ms, 5%). Final writes are immutable and canonical; actual stored bytes/hash are checked before atomic ready/debit and before downloads. Corrupt/replaced-object tests fail closed. Revalidating old ready jobs must use an explicit no-second-debit repair path with an audit event; the current finalize-ready early return is not that path.

Tests construct clearly labeled synthetic records at controlled persistence seams. Browser playback uses a local MP4 fixture. Neither is production acceptance evidence.


## Operational limits and remaining proof

Stored reads buffer at most 100 MiB before responding and have a 60-second deadline. Video/audio decoders are separately bounded to 120 seconds. Rejected private artifacts retain a safe digest/size for later quarantine/GC; automatic deletion is avoided because it could race with accepted retries. Local FFmpeg/filesystem and renderer checks pass, but isolated Neon/Blob concurrency now passes the documented live tests; production deployment capacity remains unverified. See the Prompt 3 execution note; the runtime dependency audit is now clean, while unrelated dev-tool advisories and the inherited Sandbox serialization warning remain release-review items.
