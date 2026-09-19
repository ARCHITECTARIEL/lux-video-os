import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Documented, reviewed exceptions for currently-unfixable high/critical
// transitive vulnerabilities, all pulled in by `workflow` (the durable
// workflow CLI/runtime -- see WORKFLOW_DISPATCH_MODE in
// api/video-os-lite/render-v2.js) and `@vercel/sandbox` (used only by the
// optional, disabled-by-default HyperFrames compositor -- see
// finishingEngine() in workflows/video-render.js; plain ffmpeg is the
// default). Neither sits in the untrusted-request-handling path (auth,
// uploads, billing, render dispatch): this app's own outbound HTTP calls
// go to fixed, first-party endpoints (Stripe, HeyGen, Resend, Google), not
// attacker-controlled hosts or attacker-supplied cache directives, which
// is what these specific advisories require to be exploitable.
//
// Verified 2026-09-19: `npm audit fix` (semver-safe only) and `npm audit
// fix --force` (allows breaking changes), and manually matching the
// versions the open Dependabot PRs propose, all made the vulnerability
// count WORSE (19 -> 53, 61, and 57 respectively) rather than better --
// every newer resolvable version of `workflow`/`vercel` right now pulls in
// an even rockier pre-release (5.0.0-beta.x) dependency tree. There is
// currently no available fix that doesn't regress the security posture.
// Revisit this list whenever `workflow` or `@vercel/sandbox` cut a stable
// release with these transitive versions patched.
export const ACCEPTED_ADVISORIES = [
  {
    id: 'GHSA-28wg-ghj8-5hjv',
    package: 'nanoid',
    reason: 'Non-secure generator can loop indefinitely with a negative size argument. This app never calls nanoid with an attacker-controlled size; it is an internal implementation detail of workflow/@workflow/core’s run-id generation.',
  },
  {
    id: 'GHSA-xwg4-73v4-xw9w',
    package: 'nanoid',
    reason: 'Integer overflow/wraparound in nanoid, same non-attacker-reachable usage as GHSA-28wg-ghj8-5hjv above.',
  },
  {
    id: 'GHSA-mh99-v99m-4gvg',
    package: 'brace-expansion',
    reason: 'DoS via unbounded brace-expansion length. Reachable only through glob/pattern-matching call sites inside workflow/vercel CLI tooling operating on this repo’s own source tree, not on attacker-supplied input.',
  },
  {
    id: 'GHSA-rgw5-rvv9-x895',
    package: 'brace-expansion',
    reason: 'DoS via unbounded intermediate arrays bypassing an earlier brace-expansion mitigation; same non-attacker-reachable usage as GHSA-mh99-v99m-4gvg above.',
  },
  {
    id: 'GHSA-4cwx-7wf7-3272',
    package: 'undici',
    reason: 'Cross-user information disclosure via degenerate Cache-Control directives. Exploitable when an app both makes outbound requests to attacker-influenced hosts and shares an undici cache across users; this app’s outbound fetches go only to fixed first-party endpoints (Stripe, HeyGen, Resend, Google), never attacker-supplied hosts or cache directives.',
  },
];

function normalizeVia(via) {
  return Array.isArray(via) ? via : [via];
}

export function collectHighSeverityAdvisories(auditJson) {
  const advisories = new Map();
  for (const vulnerability of Object.values(auditJson?.vulnerabilities || {})) {
    for (const via of normalizeVia(vulnerability?.via)) {
      if (!via || typeof via !== 'object') continue; // a bare package-name string, not an advisory itself
      if (!['high', 'critical'].includes(via.severity)) continue;
      const id = String(via.url || '').trim().split('/').pop();
      if (!id) continue;
      advisories.set(id, { id, package: via.name || vulnerability.name, severity: via.severity, title: via.title || '' });
    }
  }
  return [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function partitionAcceptedAdvisories(advisories) {
  const blocking = [];
  const accepted = [];
  for (const advisory of advisories) {
    const entry = ACCEPTED_ADVISORIES.find((candidate) => candidate.id === advisory.id);
    if (entry) accepted.push({ advisory, entry });
    else blocking.push(advisory);
  }
  return { blocking, accepted };
}

export function evaluateAuditJson(auditJson, io = console) {
  const { blocking, accepted } = partitionAcceptedAdvisories(collectHighSeverityAdvisories(auditJson));
  for (const { advisory, entry } of accepted) {
    io.log(`ACCEPTED (documented risk) ${advisory.id} ${advisory.package} -- ${entry.reason}`);
  }
  if (blocking.length) {
    for (const advisory of blocking) io.error(`${advisory.id} ${advisory.severity} ${advisory.package} -- ${advisory.title}`);
    io.error(`npm audit gate found ${blocking.length} blocking high/critical advisory(ies) (${accepted.length} accepted).`);
    return 1;
  }
  io.log(`npm audit gate found 0 blocking high/critical advisories (${accepted.length} accepted).`);
  return 0;
}

export function runNpmAudit(cwd = process.cwd()) {
  try {
    // shell: true is required for npm's .cmd wrapper to be spawnable at all
    // on Windows (plain execFileSync fails with EINVAL); safe here despite
    // the shell-escaping warning it triggers since every argument is a
    // hardcoded literal, never interpolated from external input.
    const stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd, encoding: 'utf8', maxBuffer: 20_000_000, shell: true });
    return JSON.parse(stdout);
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything, --json output
    // included; only a genuinely broken invocation lacks stdout entirely.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

export function main(io = console) {
  return evaluateAuditJson(runNpmAudit(), io);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}
