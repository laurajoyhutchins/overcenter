import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyScriptTestLane,
  collectRunnerTestSelection,
  extractLiteralTestCases,
  stableAuditTestId,
} from './test-audit-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const SHA40 = /^[0-9a-f]{40}$/;
const TEST_SUFFIXES = ['.test.js', '.test.mjs', '.test.cjs', '.test.ts', '.test.mts', '.spec.js', '.spec.mjs', '.spec.cjs', '.spec.ts', '.spec.mts'];
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);

function fail(message) {
  console.error(`test-audit: ${message}`);
  process.exit(1);
}

function git(args) {
  return spawnSync('git', args, { cwd:root, encoding:'utf8' });
}

function exactRevision() {
  const result = git(['rev-parse', 'HEAD']);
  if (result.status !== 0) fail('cannot resolve git HEAD');
  const revision = String(result.stdout || '').trim().toLowerCase();
  if (!SHA40.test(revision)) fail('git HEAD is not an exact 40-character SHA');
  return revision;
}

function assertAuditSourceMatchesHead() {
  for (const args of [
    ['diff', '--quiet', '--', 'scripts', 'lib'],
    ['diff', '--cached', '--quiet', '--', 'scripts', 'lib'],
  ]) {
    const result = git(args);
    if (result.status !== 0) fail('tracked test or runner changes would make the census differ from HEAD');
  }
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', 'scripts', 'lib']);
  if (status.status !== 0) fail('cannot establish test-source working tree state');
  if (String(status.stdout || '').trim()) fail('untracked test or runner source would make the census differ from HEAD');
}

async function walkTests() {
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes:true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        found.push(relative(root, absolute).replaceAll('\\', '/'));
      }
    }
  }
  await visit(root);
  return found.sort();
}

function expandSelection(selection, testFiles) {
  const selected = new Set([...selection.files]);
  for (const prefix of selection.prefixes) {
    for (const file of testFiles) {
      if (file.startsWith('scripts/') && basename(file).startsWith(prefix) && file.endsWith('.test.mjs')) selected.add(file);
    }
  }
  return selected;
}

function verifierArtifacts(maintainedSource) {
  const matches = maintainedSource.matchAll(/['"](scripts\/verify-[^'"]+\.mjs)['"]/g);
  return [...new Set([...matches].map((match) => match[1]).filter((path) => !path.endsWith('.test.mjs')))].sort()
    .map((file) => ({ file, dialect:'standalone-verifier', lane:'maintained-preflight' }));
}

function verifyRegressionRegistry() {
  const result = spawnSync(process.execPath, ['scripts/verify-regression-suite-registry.mjs'], { cwd:root, encoding:'utf8' });
  if (result.status !== 0) fail(`regression-suite registry verification failed:\n${result.stderr || result.stdout || 'unknown error'}`);
  return true;
}

async function buildCensus(revision) {
  const [testFiles, maintainedSource, integrationSource] = await Promise.all([
    walkTests(),
    readFile(resolve(root, 'scripts/test.mjs'), 'utf8'),
    readFile(resolve(root, 'scripts/test-integration.mjs'), 'utf8'),
  ]);
  const maintained = expandSelection(collectRunnerTestSelection(maintainedSource), testFiles);
  const integration = expandSelection(collectRunnerTestSelection(integrationSource), testFiles);
  const registryVerified = verifyRegressionRegistry();
  const files = [];
  const tests = [];
  const unresolved = [];

  for (const file of testFiles) {
    let dialect = 'unknown';
    let lane = 'unclassified';
    if (file.startsWith('scripts/') && file.endsWith('.test.mjs')) {
      dialect = 'node-test';
      lane = classifyScriptTestLane(file, { maintained, integration });
    } else if (file.startsWith('lib/') && file.endsWith('.test.js')) {
      dialect = 'regression-suite';
      lane = 'regression-registry';
    } else {
      unresolved.push({ file, line:null, ordinal:null, dialect, lane, reason:'unclassified_test_location_or_extension' });
    }

    const source = await readFile(resolve(root, file), 'utf8');
    const extracted = extractLiteralTestCases(source, { file });
    for (const entry of extracted.cases) {
      tests.push({
        test_id:stableAuditTestId({ revision, file, name:entry.name, ordinal:entry.ordinal }),
        revision,
        file,
        line:entry.line,
        ordinal:entry.ordinal,
        name:entry.name,
        dialect,
        lane,
        modifier:entry.modifier,
      });
    }
    unresolved.push(...extracted.unresolved.map((entry) => ({ ...entry, dialect, lane })));
    if (extracted.cases.length === 0 && extracted.unresolved.length === 0) {
      unresolved.push({ file, line:null, ordinal:null, dialect, lane, reason:'no_test_cases_discovered' });
    }
    files.push({ file, dialect, lane, case_count:extracted.cases.length, unresolved_count:extracted.unresolved.length });
  }

  const verificationArtifacts = verifierArtifacts(maintainedSource);
  return {
    schema:'overcenter-test-audit-census-v1',
    revision,
    complete:unresolved.length === 0,
    registry_verified:registryVerified,
    summary:{
      file_count:files.length,
      test_count:tests.length,
      unresolved_count:unresolved.length,
      maintained_script_files:files.filter((entry) => entry.lane === 'maintained').length,
      integration_script_files:files.filter((entry) => entry.lane === 'integration').length,
      unregistered_script_files:files.filter((entry) => entry.lane === 'unregistered').length,
      regression_files:files.filter((entry) => entry.lane === 'regression-registry').length,
      verification_artifacts:verificationArtifacts.length,
    },
    files,
    tests,
    verification_artifacts:verificationArtifacts,
    unresolved,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive:true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function reviewSeed(census) {
  return census.tests.map((entry) => JSON.stringify({
    schema:'overcenter-test-audit-review-v1',
    test_id:entry.test_id,
    revision:census.revision,
    file:entry.file,
    line:entry.line,
    name:entry.name,
    intent:null,
    subject:null,
    invariants:[],
    authority:null,
    setup_validity:'UNKNOWN',
    assertion_strength:'UNKNOWN',
    identity_binding:'UNKNOWN',
    failure_behavior:'UNKNOWN',
    mutation_certainty:'UNKNOWN',
    concurrency_recovery:'UNKNOWN',
    determinism:'UNKNOWN',
    production_fidelity:'UNKNOWN',
    overlap:[],
    regression_lineage:[],
    disposition:'UNKNOWN',
    evidence:[],
    notes:null,
  })).join('\n') + '\n';
}

function runCoverage(census) {
  if (!census.complete) fail('coverage refused because the static census is incomplete');
  const files = census.files.filter((entry) => entry.lane === 'maintained').map((entry) => entry.file);
  if (files.length === 0) fail('no maintained tests were discovered');
  const result = spawnSync(process.execPath, ['--experimental-test-coverage', '--test', ...files], { cwd:root, stdio:'inherit' });
  process.exit(result.status ?? 1);
}

const args = new Set(process.argv.slice(2));
const revision = exactRevision();
assertAuditSourceMatchesHead();
const census = await buildCensus(revision);

if (args.has('--coverage')) runCoverage(census);
if (args.has('--write') || args.has('--init-review')) await writeJson(resolve(root, 'audit/tests/census.json'), census);
if (args.has('--init-review')) {
  await mkdir(resolve(root, 'audit/tests'), { recursive:true });
  await writeFile(resolve(root, 'audit/tests/review.jsonl'), reviewSeed(census), { encoding:'utf8', flag:'wx' });
}

console.log(JSON.stringify(census, null, args.has('--compact') ? 0 : 2));
if (!census.complete) process.exitCode = 2;