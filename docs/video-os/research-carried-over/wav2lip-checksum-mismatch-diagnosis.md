# Wav2Lip Checksum Mismatch Diagnosis

**Authority:** L0 read-only investigation. No download retry, commit, worker/validation/workflow change, authorization change, or risk-acceptance change was performed.  
**Subject:** Failed local acquisition of `wav2lip.pth` during the prior Stage-A attempt.

## 1. Failed-download provenance

### Requested canonical URL — CONFIRMED

The actual acquisition command requested:

```text
https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2/wav2lip.pth
```

It used `curl.exe -L --fail --retry 2 -o <local-file>`, followed by PowerShell MD5/SHA-256 calculation. The initial transfer was interrupted by the execution surface, then a second `curl.exe -C -` command resumed it.

### Redirect chain — CONFIRMED

The retained header capture for the actual canonical request records:

1. `https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2/wav2lip.pth`
2. `302 Found` to `https://release-assets.githubusercontent.com/github-production-release-asset/569518584/8a07a75d-a62c-4c7c-b0f3-3aedb0a3d86f?...`
3. `200 OK` from the signed Azure-backed GitHub release asset.

The signed query string is intentionally omitted from this record because it is time-limited access material; the release-asset path above identifies the redirect target. A separate earlier HEAD-only probe of the legacy `Winfredy/SadTalker` URL observed a `301` to the same `OpenTalker/SadTalker` canonical URL before its release-asset redirect. That legacy probe was not the file-producing GET.

### Captured response headers — CONFIRMED

The retained `curl -I -L` capture for the actual canonical request reports:

| Header | Value |
|---|---|
| First response | `302 Found` |
| First-response server | `github.com` |
| First-response content length | `0` |
| Final response | `200 OK` |
| Final-response server | `Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0` |
| Content-Length | `435807851` bytes |
| Last-Modified | `Sat, 08 Apr 2023 10:37:47 GMT` |
| ETag | `"0x8DB381D4B58AFD7"` |
| Blob creation time | `Sat, 08 Apr 2023 10:37:47 GMT` |
| Content-MD5 equivalent | `x-ms-blob-content-md5: jZ3Xuviy5MEZXHfGW2KpZQ==` |
| Accept-Ranges | `bytes` |
| Content-Disposition | `attachment; filename=wav2lip.pth` |
| Content-Type | `application/octet-stream` |

The full retained header capture is local transient evidence at `.tmp-sadtalker-checksums/wav2lip.headers.txt`; it is not a committed artifact.

## 2. Provenance of the expected MD5

**CONFIRMED:** `jZ3Xuviy5MEZXHfGW2KpZQ==` came from the final Azure release-asset response header `x-ms-blob-content-md5` in the retained `curl -I -L` capture. It was not copied from the decision brief, an issue, or a checksum page.

**LIKELY:** The header probe and file-producing GET were separate HTTP requests, even though both used the same canonical GitHub release URL. The header capture obtains one signed redirect; the subsequent `curl -L` GET obtains its own redirect/asset request. The captured header therefore corroborates the named release asset and declared content length, but does not by itself prove the GET received the same signed-response instance.

## 3. Local mismatch facts

| Value | Result | Confidence |
|---|---|---|
| Declared final-response length | `435807851` bytes | CONFIRMED |
| Retained local-file length | `445384299` bytes | CONFIRMED |
| Difference | `9576448` bytes larger than declared | CONFIRMED |
| Header MD5 | `jZ3Xuviy5MEZXHfGW2KpZQ==` | CONFIRMED |
| Local-file MD5 | `wRjg4ouWue+dmsElRRAiKw==` | CONFIRMED |
| Local-file SHA-256 | `50D461B2E0C79973B2AF4645FDFEA2DB779C20863745A90ED0FE07FDC825B19F` | CONFIRMED, but not trusted as an artifact pin |

## 4. Corruption versus different-artifact assessment

**LIKELY — transfer/resume corruption:** The local file exceeds the response `Content-Length` by 9,576,448 bytes. A valid copy of the exact response body cannot have that size. The first transfer was interrupted by the execution surface. After the interruption, a read-only size check observed `321249280` bytes, while the resume command later reported `** Resuming transfer from byte position 400257024**`. This is direct evidence that the first transfer continued after its caller returned or that the file changed before resume. The second resume then wrote to a file whose transfer state was not exclusively controlled by that command. Concurrent/overlapping transfer behavior is consistent with the oversized result and MD5 mismatch.

**UNKNOWN — silently changed artifact or wrong source:** The evidence does not prove the release asset changed. The canonical GitHub release URL, release-asset ID, declared `Content-Length`, `Last-Modified`, and ETag in the captured response identify a stable-looking artifact, but the GET response headers were not separately retained. Because the expected MD5 came from a separate header request, the local evidence alone cannot completely rule out a different response body in the later GET. The size mismatch, however, makes ordinary transfer corruption the stronger explanation.

## 5. Known-issue search

**UNKNOWN:** Targeted GitHub issue searches of `OpenTalker/SadTalker` and `Rudrabha/Wav2Lip` returned checkpoint loading, missing-file, and generic runtime issues, but no result metadata identifying this exact MD5 (`jZ3Xuviy5MEZXHfGW2KpZQ==`), this local MD5, a release re-upload, or a documented hash mismatch. The search results do not prove absence of such a report; they only provide no positive evidence for one.

Relevant upstream issue searches surfaced checkpoint/load-path problems such as [SadTalker #132](https://github.com/OpenTalker/SadTalker/issues/132), [SadTalker #134](https://github.com/OpenTalker/SadTalker/issues/134), and [Wav2Lip #441](https://github.com/Rudrabha/Wav2Lip/issues/441). None of their result metadata establishes a hash or release-reupload explanation for this incident.

## 6. Upstream-referenced alternate sources

| Source | Finding | Confidence |
|---|---|---|
| `SadTalker/scripts/download_models.sh` | The upstream script names the legacy `Winfredy/SadTalker` release URL for `wav2lip.pth`; that URL redirects to the canonical `OpenTalker/SadTalker` release URL above. | CONFIRMED |
| Official Wav2Lip README | The upstream README links its Wav2Lip checkpoint folder at `https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM?usp=share_link`. | CONFIRMED |
| Equivalence of the Google Drive checkpoint and SadTalker release asset | The reviewed evidence does not establish byte identity, filename identity, or hash equivalence. | UNKNOWN |

## Conclusion boundary

This document records the mismatch and its most-supported transfer explanation only. It does not decide whether to retry, choose an alternate source, trust an artifact, resume implementation, or alter any authorization/risk-acceptance record.
