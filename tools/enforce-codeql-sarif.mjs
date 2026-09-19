import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  const error = new Error(message);
  error.code = 'CODEQL_SARIF_GATE';
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getRuleMap(run) {
  const map = new Map();
  const drivers = [];
  if (Array.isArray(run?.tool?.driver?.rules)) drivers.push(...run.tool.driver.rules);
  for (const extension of run?.tool?.extensions || []) {
    if (Array.isArray(extension?.rules)) drivers.push(...extension.rules);
  }
  for (const rule of drivers) {
    if (rule?.id && !map.has(rule.id)) map.set(rule.id, rule);
  }
  return map;
}

function normalizeFinding(result, ruleMap, origin) {
  if (!isObject(result)) throw fail(`Malformed CodeQL result in ${origin}.`);
  const ruleId = String(result.ruleId || '').trim();
  if (!ruleId) throw fail(`CodeQL result is missing ruleId in ${origin}.`);
  const rule = ruleMap.get(ruleId);
  const securitySeverity = String(
    rule?.properties?.['security-severity']
      ?? result?.properties?.['security-severity']
      ?? ''
  ).trim();
  if (!securitySeverity) throw fail(`CodeQL result ${ruleId} is missing security severity metadata in ${origin}.`);
  const location = result.locations?.[0]?.physicalLocation;
  const file = String(location?.artifactLocation?.uri || '').trim();
  const line = Number(location?.region?.startLine || 0);
  if (!file || !Number.isFinite(line) || line <= 0) {
    throw fail(`CodeQL result ${ruleId} is missing a concrete file/line location in ${origin}.`);
  }
  // CodeQL's own content-based fingerprint for this exact flagged line,
  // used (only) to match against ALLOWED_FINDINGS below -- unlike `line`,
  // it stops matching the moment the flagged line's content changes, so a
  // reviewed exception can't silently keep covering a since-modified line.
  const lineHash = String(result.partialFingerprints?.primaryLocationLineHash || '').trim() || null;
  return { ruleId, securitySeverity, file, line, lineHash };
}

// This gate has no GitHub Code Scanning backend to process inline
// `codeql[rule-id]` suppression comments (.github/workflows/codeql.yml
// sets `upload: never` -- private repo, no Code Scanning entitlement), so
// suppression comments in source are never actually read by anything.
// This allowlist is the equivalent, working mechanism for this pipeline:
// each entry pins the exact rule, file, and line-content fingerprint (not
// just a line number, so it stops applying the moment that line's content
// changes) plus a required, reviewed reason. It does not change what
// CodeQL scans or reports -- only which already-reported findings this
// enforcement step treats as blocking. Every excluded finding is still
// logged (see main()), never silently dropped.
export const ALLOWED_FINDINGS = [
  {
    ruleId: 'js/xss-through-dom',
    file: 'public/identity.js',
    lineHash: '5ac89a4a69d37f7c:1',
    reason: "objectUrl always comes from URL.createObjectURL(file): a same-origin blob: reference the browser itself mints to in-memory binary data, never a string an attacker controls. Assigning it to .src loads media, never parsed as HTML. See setLocalPreviewSource() in public/identity.js.",
  },
];

function findAllowlistEntry(finding) {
  return ALLOWED_FINDINGS.find((entry) => entry.ruleId === finding.ruleId && entry.file === finding.file && entry.lineHash && entry.lineHash === finding.lineHash);
}

export function collectCodeqlFindingsFromSarif(sarif, origin = 'sarif') {
  if (!isObject(sarif) || !Array.isArray(sarif.runs)) {
    throw fail(`Malformed CodeQL SARIF in ${origin}: runs[] is required.`);
  }
  const findings = [];
  for (const [runIndex, run] of sarif.runs.entries()) {
    if (!isObject(run)) throw fail(`Malformed CodeQL SARIF run ${runIndex} in ${origin}.`);
    const ruleMap = getRuleMap(run);
    const results = run.results ?? [];
    if (!Array.isArray(results)) {
      throw fail(`Malformed CodeQL SARIF results in ${origin} run ${runIndex}.`);
    }
    for (const result of results) {
      findings.push(normalizeFinding(result, ruleMap, `${origin} run ${runIndex}`));
    }
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.ruleId.localeCompare(right.ruleId)
    || left.securitySeverity.localeCompare(right.securitySeverity)
  );
}

export async function collectCodeqlFindingsFromDirectory(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sarif')).sort();
  if (!names.length) {
    throw fail(`CodeQL produced no SARIF output in ${directory}.`);
  }
  const findings = [];
  for (const name of names) {
    const fullPath = path.join(directory, name);
    let sarif;
    try {
      sarif = JSON.parse(await readFile(fullPath, 'utf8'));
    } catch (error) {
      throw fail(`Malformed CodeQL SARIF file ${name}: ${error.message}`);
    }
    findings.push(...collectCodeqlFindingsFromSarif(sarif, name));
  }
  return { directory, files: names, findings };
}

export function formatCodeqlFindings(findings) {
  return findings.map((finding) => `${finding.ruleId} severity=${finding.securitySeverity} ${finding.file}:${finding.line}`);
}

export function partitionAllowedFindings(findings) {
  const blocking = [];
  const allowed = [];
  for (const finding of findings) {
    const entry = findAllowlistEntry(finding);
    if (entry) allowed.push({ finding, entry });
    else blocking.push(finding);
  }
  return { blocking, allowed };
}

export async function main(argv = process.argv.slice(2), io = console) {
  const directory = argv[0];
  if (!directory) throw fail('Usage: node tools/enforce-codeql-sarif.mjs <sarif-directory>');
  const summary = await collectCodeqlFindingsFromDirectory(directory);
  const { blocking, allowed } = partitionAllowedFindings(summary.findings);
  for (const { finding, entry } of allowed) {
    io.log(`ALLOWED (reviewed false positive) ${finding.ruleId} ${finding.file}:${finding.line} -- ${entry.reason}`);
  }
  const allowedSuffix = allowed.length ? ` (${allowed.length} allowed)` : '';
  if (blocking.length) {
    for (const line of formatCodeqlFindings(blocking)) {
      io.error(line);
    }
    io.error(`CodeQL SARIF gate inspected ${summary.files.length} file(s) and found ${blocking.length} result(s)${allowedSuffix}.`);
    return 1;
  }
  io.log(`CodeQL SARIF gate inspected ${summary.files.length} file(s) and found 0 result(s)${allowedSuffix}.`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}