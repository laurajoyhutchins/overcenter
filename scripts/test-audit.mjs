import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_ROOTS = Object.freeze(['api', 'lib', 'mcp', 'pages', 'scripts']);
const TEST_FILE = /\.test\.(?:js|mjs)$/;
const JAVASCRIPT_FILE = /\.(?:js|mjs)$/;
const LEGACY_RUNNER = /export\s+(?:async\s+)?function\s+(run[A-Za-z0-9_$]*Tests)\s*\(/g;
const NATIVE_LITERAL = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

function repositoryPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

async function javascriptFiles(root, directory) {
  let entries;
  try {
    entries = await readdir(resolve(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await javascriptFiles(root, child));
    else if (entry.isFile() && JAVASCRIPT_FILE.test(entry.name)) files.push(resolve(root, child));
  }
  return files;
}

function stableAuditId(revision, source, kind, name) {
  return createHash('sha256').update(`${revision}\0${source}\0${kind}\0${name}`).digest('hex');
}

function literalNativeCases(source) {
  return [...source.matchAll(NATIVE_LITERAL)]
    .filter((match) => match[1] !== '`' || !match[2].includes('${'))
    .map((match) => match[2]);
}

function legacyRunners(source) {
  return [...source.matchAll(LEGACY_RUNNER)].map((match) => match[1]);
}

export async function auditRepository({ root = DEFAULT_ROOT, revision }) {
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('revision must be an exact 40-character Git SHA');
  const absoluteRoot = resolve(root);
  const files = (await Promise.all(SOURCE_ROOTS.map((directory) => javascriptFiles(absoluteRoot, directory))))
    .flat()
    .sort();
  const tests = [];
  const unresolved = [];

  for (const absolute of files) {
    const sourcePath = repositoryPath(absoluteRoot, absolute);
    const source = await readFile(absolute, 'utf8');
    const cases = literalNativeCases(source);
    const runners = legacyRunners(source);
    if (!TEST_FILE.test(sourcePath) && runners.length === 0) continue;

    for (const name of cases) {
      tests.push({ audit_id: stableAuditId(revision, sourcePath, 'native_literal', name), source: sourcePath, kind: 'native_literal', name });
    }
    for (const name of runners) {
      unresolved.push({ audit_id: stableAuditId(revision, sourcePath, 'legacy_suite_runner', name), source: sourcePath, shape: 'legacy_suite_runner', name });
    }
    if (TEST_FILE.test(sourcePath) && cases.length === 0 && runners.length === 0) {
      unresolved.push({ audit_id: stableAuditId(revision, sourcePath, 'test_file_without_literal_native_case', sourcePath), source: sourcePath, shape: 'test_file_without_literal_native_case' });
    }
  }

  return Object.freeze({
    revision: revision.toLowerCase(),
    test_file_count: new Set([...tests, ...unresolved].map((entry) => entry.source).filter((source) => TEST_FILE.test(source))).size,
    literal_case_count: tests.length,
    unresolved_shape_count: unresolved.length,
    tests: Object.freeze(tests),
    unresolved: Object.freeze(unresolved),
  });
}

function cliRevision(argv, env) {
  const index = argv.indexOf('--revision');
  if (index >= 0) return argv[index + 1];
  return env.GITHUB_SHA;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditRepository({ revision: cliRevision(process.argv.slice(2), process.env) });
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--require-zero-unresolved') && report.unresolved_shape_count !== 0) process.exitCode = 1;
}
