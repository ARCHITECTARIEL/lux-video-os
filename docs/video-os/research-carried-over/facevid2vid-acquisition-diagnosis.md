# Facevid2vid Checkpoint Acquisition Diagnosis

**Authority:** L0 read-only investigation. No download was attempted, no commit was created, and no worker, validation, workflow, authorization, or risk-acceptance state was changed.

## Current evidence corrects the initial zero-byte observation

**CONFIRMED:** The two retained attempt directories now contain non-empty header captures and partial body files. The earlier zero-byte observation was a point-in-time observation while background `curl` transfers had not yet written a body/header file. It was not an HTTP `200` response with `Content-Length: 0`.

| Attempt directory | Local body size | Captured header size | Final declared content length | State |
|---|---:|---:|---:|---|
| `.tmp-sadtalker-clean-002` | `1314287616` bytes | `6090` bytes | `2112619148` bytes | Partial (short by `798331532` bytes) |
| `.tmp-sadtalker-clean-003` | `552611840` bytes | `6094` bytes | `2112619148` bytes | Partial (short by `1560007308` bytes) |

Neither retained file is complete or suitable for MD5/SHA-256 verification.

## 1. Exact attempted source and redirect chain

### Attempted URL — CONFIRMED

Both attempts used:

```text
https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2/facevid2vid_00189-model.pth.tar
```

### Captured redirect chain — CONFIRMED

1. The canonical OpenTalker release URL above returned `302 Found` from `github.com`.
2. It redirected to the signed GitHub release-asset path:

```text
https://release-assets.githubusercontent.com/github-production-release-asset/569518584/4ca10c74-1402-4aad-9f6b-115920ac98e1?...
```

3. The signed Azure-backed release asset returned `200 OK`.

The expiring signed query string is intentionally not preserved in this diagnosis. The release-asset path identifies the asset without retaining temporary access material.

### SadTalker-documented source — CONFIRMED

`SadTalker/scripts/download_models.sh` contains this legacy acquisition command (commented as a legacy link):

```bash
wget -nc https://github.com/Winfredy/SadTalker/releases/download/v0.0.2/facevid2vid_00189-model.pth.tar -O ./checkpoints/facevid2vid_00189-model.pth.tar
```

The script therefore documents a direct GitHub-release download, not a Google Drive/gdown flow. The investigated canonical OpenTalker URL is the corresponding current repository-release path. The active portion of the script instead prefers the newer `v0.0.2-rc` safetensor assets; it does not name an alternate facevid2vid archive.

## 2. Actual HTTP status and headers

**CONFIRMED:** Both retained response captures show the same meaningful final response, not a timeout/no-status response, `429`, `503`, or zero-length response.

| Header | Value |
|---|---|
| Redirect response | `302 Found` |
| Redirect server | `github.com` |
| Final response | `200 OK` |
| Final server | `Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0` |
| Content-Length | `2112619148` bytes |
| Last-Modified | `Sat, 08 Apr 2023 10:34:22 GMT` |
| ETag | `"0x8DB381CD126250E"` |
| MD5 equivalent | `x-ms-blob-content-md5: Db3zfwKj5+0hFd3uh4mzOg==` |
| Accept-Ranges | `bytes` |
| Content-Disposition | `attachment; filename=facevid2vid_00189-model.pth.tar` |
| Content-Type | `application/octet-stream` |

## 3. Documented acquisition method

**CONFIRMED:** SadTalker’s own legacy script uses `wget -nc` against the GitHub release URL. It does not invoke `gdown`, does not identify a Google Drive URL for this checkpoint, and does not document a confirmation-token flow for it.

**LIKELY:** The `-nc` option is an existing-file/no-clobber behavior, not an integrity protocol. The script does not provide a published SHA-256 or MD5 validation step for this asset.

## 4. Failure classification

**CONFIRMED:** Both local bodies are shorter than the `Content-Length` supplied by their own captured `200 OK` response. This is an incomplete-transfer condition, not evidence of an empty or removed asset.

**LIKELY:** The prior attempts were ended before the 2.11-GB transfer completed. The first transfer was observed after about 90 seconds and the retry after about 30 seconds; both were explicitly terminated while no body progress had yet been surfaced to the interactive status command. The subsequent retained files and headers show that the requests had in fact started and received valid release responses.

**UNKNOWN:** The retained evidence does not identify why interactive polling initially showed zero bytes. It does not support rate-limiting, a dead link, or an upstream asset replacement as an explanation.

## Conclusion boundary

No new acquisition method is asserted, no retry is performed, and no artifact is trusted. This diagnosis only establishes that the documented direct-release route is valid and that the observed failure was incomplete transfer rather than a zero-byte HTTP response.
