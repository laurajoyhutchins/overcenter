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

const maintained = (await collectTestFiles(LIB)).map(repoPath).sort();
const registrySource = await readFile(REGISTRY, 'utf8');
const registered = registeredTestSources(registrySource);
const suites = registeredSuites(registrySource);

const counts = new Map();
for (const source of registered) counts.set(source, (counts.get(source) || 0) + 1);
const duplicates = [...counts.entries()].filter(([, count]) => count !== 1).map(([source]) => source);
const maintainedSet = new Set(maintained);
const registeredSet = new Set(registered);
const missing = maintained.filter(source => !registeredSet.has(source));
const stale = [...registeredSet].filter(source => !maintainedSet.has(source)).sort();

const requiredArchitectureClassifications = [
  { source:'lib/orchestration-advance-boundary.test.js', name:'orchestration_advance_production_path' },
  { source:'lib/project-dispatch.test.js', name:'project_dispatch_isolated_contract' },
  { source:'lib/project-dynamic-replan.test.js', name:'project_dynamic_replan_isolated_contract' },
  { source:'lib/project-lifecycle-resume.test.js', name:'project_lifecycle_resume_isolated_contract' },
];
const architectureClassificationMissing = requiredArchitectureClassifications
  .filter((expected) => !suites.some((entry) => entry.source === expected.source && entry.name === expected.name));
const obsoleteArchitectureSources = [
  'lib/project-controller.test.js',
  'lib/project-controller-runtime.test.js',
].filter((source) => maintainedSet.has(source) || registeredSet.has(source));

if (missing.length || stale.length || duplicates.length || architectureClassificationMissing.length || obsoleteArchitectureSources.length) {
  console.error(JSON.stringify({
    ok:false,
    maintained_count:maintained.length,
    registered_count:registered.length,
    missing,
    stale,
    duplicates,
    architecture_classification_missing:architectureClassificationMissing,
    obsolete_architecture_sources:obsoleteArchitectureSources,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok:true,
  maintained_count:maintained.length,
  registered_count:registered.length,
  architecture_classifications:requiredArchitectureClassifications,
}));
