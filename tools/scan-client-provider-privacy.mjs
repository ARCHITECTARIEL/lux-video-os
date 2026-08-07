import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const staticRoot = path.join(root, '.vercel', 'output', 'static');
const functionsRoot = path.join(root, '.vercel', 'output', 'functions');
const requireBuild = process.argv.includes('--require-build');
const textExtensions = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt']);
const configuredProviderIds = FEATURED_CAST.flatMap((item) => [item.avatarId, item.voiceId]);
const providerPreviewLiteral = /https:\/\/[^\s"'\`)]*(?:heygen|hygen|avatar)[^\s"'\`)]*\.(?:avif|gif|jpe?g|png|webp)(?:[?#][^\s"'\`)]*)?/i;
const privateTelemetryLiteral = /(?:privateLook(?:s)?Count|privateLooksPages|private[_-]looks|providerAccount(?:Complete|Completeness)|accountCompleteness|(?:provider|heygen)[^\r\n]{0,120}(?:configured\s*:|missing\s*:)|(?:configured\s*:|missing\s*:)[^\r\n]{0,120}(?:provider|heygen)|(?:nextToken|hasMore|complete|truncated)\s*:)/i;
const credentialLiteral = /(?:HEYGEN_API_KEY|HEYGEN_TOKEN|X-Api-Key|sk-[A-Za-z0-9_-]{20,})/i;

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function files(directory) {
  if (!await isDirectory(directory)) return [];
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await files(target));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) results.push(target);
  }
  return results;
}

function relative(filename) {
  return path.relative(root, filename).replaceAll('\\', '/');
}

function isClientAccessible(filename) {
  const value = relative(filename);
  return value.startsWith('public/') || value.startsWith('.vercel/output/static/');
}

function configuredMatches(source) {
  return configuredProviderIds.filter((id) => source.includes(id)).length;
}

const violations = [];
if (!await isDirectory(publicRoot)) violations.push('public: required client root is missing');
if (requireBuild && !await isDirectory(staticRoot)) violations.push('.vercel/output/static: required build root is missing');

const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const tracked = stdout.split('\0').filter(Boolean).map((name) => path.join(root, name)).filter((name) => textExtensions.has(path.extname(name).toLowerCase()));
const generated = [...await files(staticRoot), ...await files(functionsRoot)];
const allFiles = [...new Set([...tracked, ...generated])];
let clientFiles = 0;
let serverMappingFiles = 0;
let serverBundleFiles = 0;

for (const filename of allFiles) {
  const name = relative(filename);
  const source = await readFile(filename, 'utf8');
  const idMatches = configuredMatches(source);
  const client = isClientAccessible(filename);
  if (client) clientFiles += 1;

  if (idMatches) {
    if (client) violations.push(`${name}: configured provider identifier in client-accessible asset`);
    else if (name === 'lib/video-os-featured-cast.js' || name.startsWith('tests/')) serverMappingFiles += 1;
    else if (name.startsWith('.vercel/output/functions/')) serverBundleFiles += 1;
    else violations.push(`${name}: configured provider identifier outside the server-only mapping boundary`);
  }

  if (client && providerPreviewLiteral.test(source)) violations.push(`${name}: private provider preview URL literal`);
  if (client && privateTelemetryLiteral.test(source)) violations.push(`${name}: private provider/account telemetry literal`);
  if (client && credentialLiteral.test(source)) violations.push(`${name}: credential or provider-key literal`);
}

assert.deepEqual(violations, [], `Client privacy scan failed (values suppressed):\n${violations.join('\n')}`);
console.log(`Client privacy scan passed (values suppressed; tracked files ${tracked.length}, client files ${clientFiles}, server mapping files ${serverMappingFiles}, server function bundles ${serverBundleFiles}).`);
