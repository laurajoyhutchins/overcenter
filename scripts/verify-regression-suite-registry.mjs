import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const LIB = join(ROOT, 'lib');
const REGISTRY = join(LIB, 'regression-suite-registry.js');

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTestFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(absolute);
  }
  return files;
}

function repoPath(absolute) {
  return relative(ROOT, absolute).split(sep).join('/');
}

function registeredTestSources(source) {
  const objectStyle = [...source.matchAll(/source:\s*['\"]([^'\"]+\.test\.js)['\"]/g)].map(match => match[1]);
  const suiteStyle = [...source.matchAll(/suite\(\s*['\"][^'\"]+['\"]\s*,\s*['\"][^'\"]+['\"]\s*,\s*['\"]([^'\"]+\.test\.js)['\"]/g)].map(match => match[1]);
  return [...objectStyle, ...suiteStyle].sort();
}

function registeredSuites(source) {
  return [...source.matchAll(/suite\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+\.test\.js)['\"]/g)]
    .map(([, group, name, suiteSource]) => ({ group, name, source:suiteSource }));
}

function usesNativeNodeTest(source) {
  return /(?:from\s*['\"]node:test['\"]|require\(\s*['\"]node:test['\"]\s*\))/.test(source);
}

const maintainedFiles = await collectTestFiles(LIB);
const maintained = maintainedFiles.map(repoPath).sort();
const native = [];
const legacy = [];
for (const absolute of maintainedFiles) {
  const path = repoPath(absolute);
  const source = await readFile(absolute, 'utf8');
  (usesNativeNodeTest(source) ? native : legacy).push(path);
}
native.sort();
legacy.sort();

const registrySource = await readFile(REGISTRY, 'utf8');
const registered = registeredTestSources(registrySource);
const suites = registeredSuites(registrySource);

const counts = new Map();
for (const source of registered) counts.set(source, (counts.get(source) || 0) + 1);
const duplicates = [...counts.entries()].filter(([, count]) => count !== 1).map(([source]) => source);
const maintainedSet = new Set(maintained);
const registeredSet = new Set(registered);
const legacySet = new Set(legacy);
const nativeSet = new Set(native);
const missingLegacy = legacy.filter(source => !registeredSet.has(source));
const stale = [...registeredSet].filter(source => !maintainedSet.has(source)).sort();
const nativeStillRegistered = [...registeredSet].filter(source => nativeSet.has(source)).sort();

const requiredArchitectureClassifications = [
  { source:'lib/orchestration-advance-boundary.test.js', name:'orchestration_advance_production_path' },
  { source:'lib/project-dispatch.test.js', name:'project_dispatch_isolated_contract' },
  { source:'lib/project-dynamic-replan.test.js', name:'project_dynamic_replan_isolated_contract' },
  { source:'lib/project-lifecycle-resume.test.js', name:'project_lifecycle_resume_isolated_contract' },
];
const architectureClassificationMissing = requiredArchitectureClassifications
  .filter((expected) => legacySet.has(expected.source) && !suites.some((entry) => entry.source === expected.source && entry.name === expected.name));
const obsoleteArchitectureSources = [
  'lib/project-controller.test.js',
  'lib/project-controller-runtime.test.js',
].filter((source) => maintainedSet.has(source) || registeredSet.has(source));

if (missingLegacy.length || stale.length || duplicates.length || nativeStillRegistered.length || architectureClassificationMissing.length || obsoleteArchitectureSources.length) {
  console.error(JSON.stringify({
    ok:false,
    maintained_count:maintained.length,
    native_count:native.length,
    legacy_count:legacy.length,
    registered_count:registered.length,
    missing_legacy:missingLegacy,
    stale,
    duplicates,
    native_still_registered:nativeStillRegistered,
    architecture_classification_missing:architectureClassificationMissing,
    obsolete_architecture_sources:obsoleteArchitectureSources,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok:true,
  maintained_count:maintained.length,
  native_count:native.length,
  legacy_count:legacy.length,
  registered_count:registered.length,
  architecture_classifications:requiredArchitectureClassifications.filter((expected) => legacySet.has(expected.source)),
}));
