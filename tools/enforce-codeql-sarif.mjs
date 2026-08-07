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
  return { ruleId, securitySeverity, file, line };
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

export async function main(argv = process.argv.slice(2), io = console) {
  const directory = argv[0];
  if (!directory) throw fail('Usage: node tools/enforce-codeql-sarif.mjs <sarif-directory>');
  const summary = await collectCodeqlFindingsFromDirectory(directory);
  if (summary.findings.length) {
    for (const line of formatCodeqlFindings(summary.findings)) {
      io.error(line);
    }
    io.error(`CodeQL SARIF gate inspected ${summary.files.length} file(s) and found ${summary.findings.length} result(s).`);
    return 1;
  }
  io.log(`CodeQL SARIF gate inspected ${summary.files.length} file(s) and found 0 result(s).`);
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