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

const maintained = (await collectTestFiles(LIB)).map(repoPath).sort();
const registrySource = await readFile(REGISTRY, 'utf8');
const registered = [...registrySource.matchAll(/source:\s*['"]([^'"]+\.test\.js)['"]/g)]
  .map(match => match[1])
  .sort();

const counts = new Map();
for (const source of registered) counts.set(source, (counts.get(source) || 0) + 1);
const duplicates = [...counts.entries()].filter(([, count]) => count !== 1).map(([source]) => source);
const maintainedSet = new Set(maintained);
const registeredSet = new Set(registered);
const missing = maintained.filter(source => !registeredSet.has(source));
const stale = [...registeredSet].filter(source => !maintainedSet.has(source)).sort();

if (missing.length || stale.length || duplicates.length) {
  console.error(JSON.stringify({ ok: false, maintained_count: maintained.length, registered_count: registered.length, missing, stale, duplicates }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, maintained_count: maintained.length, registered_count: registered.length }));
