# P0 evidence candidate contract

This directory contains the offline, fail-closed portion of the future P0
collector. It does not replace tools/verify-p0-release-gate.mjs, contact
production, submit a render, create a receipt, or clear P0.

Expected private run directory:

    manifest.json
    observations/01.json ... observations/09.json
    artifacts/private-stored-final.mp4
    artifacts/authorized-customer-download.mp4

These paths are mandatory, not examples. Observation IDs map exactly to
observations/01.json through observations/09.json, and the two artifact
filenames are fixed as shown. Arbitrary filenames and extra path segments are
rejected so private identifiers cannot enter candidate pathnames.

The manifest version is video-os-p0-evidence-candidate/v2. It binds the
server-generated proof ID, correlation/job/provider IDs, account hash,
deployment and source digests, final private-path digest, exhaustive provider
preflight digest, exact P0 title, proof window, nine evidence-file hashes, and
two separate regular MP4 files. It also binds the direct private-Blob request
target digest to the stored-artifact and denial claims.
directBlobTargetDigest is the lowercase SHA-256 of the exact credential-free
request-target string used for the denial probe, computed before the raw target
is discarded. The storage capture and denial probe must hash the same bytes;
the checker performs no URL normalization or target substitution.

Every observation uses video-os-p0-observation/v2 and repeats the full proof
binding. Its declared source claims are listed in schema.mjs. The checker uses
strict key allowlists for the manifest, descriptors, observations, bindings,
probes, and facts. It rejects raw URLs and query strings, account IDs, emails,
cookies, tokens, scripts, private pathnames, provider bodies, similarly named
sensitive fields, and self-asserted APPROVED or VERIFIED labels.

The offline check:

- hashes every observation and media file;
- rejects path traversal, symlinks, duplicate evidence paths, and a single
  filesystem object presented as both media files;
- fully decodes both MP4s with the repository media validator;
- compares stored and authorized-download bytes and SHA-256;
- checks that submitted primary/fresh-session claims are internally distinct;
- enforces anonymous 401, wrong-account 404, and direct private-Blob denial;
- requires exactly one provider submission, provider create, credit debit,
  final event, and final asset, with no repair event.

Run:

    node tools/p0-evidence/check-candidate.mjs --run-dir <private-run-directory>

A structurally complete candidate exits 3 with
STRUCTURALLY_COMPLETE_UNAUTHENTICATED, authenticated=false, and
releaseGateCleared=false. Incomplete or altered evidence exits 2. The command
writes nothing.

Offline checking cannot establish where JSON or media came from. Two copied
files, historical media renamed as the two artifacts, or fabricated observation
JSON can satisfy structural checks if their internal hashes and claims agree.
Live capture authentication and independent review remain separate,
owner-approved work.
