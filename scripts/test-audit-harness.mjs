import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /(?:\.test\.(?:js|mjs)|\.spec\.js)$/;
const LITERAL_CASE = /\b(?:test|it|t)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const LEGACY_RUNNER = /\b(?:export\s+)?(?:async\s+)?function\s+(run[A-Z][A-Za-z0-9_$]*(?:Tests|Spec))\b|\bexport\s+const\s+(run[A-Z][A-Za-z0-9_$]*(?:Tests|Spec))\b/g;
const SHA = /^[0-9a-f]{40}$/;

function stableId(kind, revision, ...parts) {
  const digest = createHash('sha256').update([revision, ...parts].join('\0')).digest('hex').slice(0, 24);
  return `${kind}:${digest}`;
}

async function walk(directory, rootPath, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, rootPath, files);
    else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(path.relative(rootPath, absolute).replaceAll(path.sep, '/'));
  }
}

function literalCases(source) {
  const cases = [];
  for (const match of source.matchAll(LITERAL_CASE)) cases.push({ name: match[2], offset: match.index ?? 0 });
  return cases;
}

function legacyRunners(source) {
  const runners = [];
  for (const match of source.matchAll(LEGACY_RUNNER)) runners.push(match[1] || match[2]);
  return runners;
}

export async function auditTestRepository({ root, revision }) {
  if (!SHA.test(String(revision || ''))) throw new TypeError('revision must be an exact 40-character Git SHA');
  const rootPath = fileURLToPath(root);
  const paths = [];
  for (const directory of ['lib', 'scripts']) await walk(path.join(rootPath, directory), rootPath, paths);
  paths.sort();

  const files = [];
  const cases = [];
  const unresolved = [];
  for (const relative of paths) {
    const source = await readFile(path.join(rootPath, relative), 'utf8');
    const detected = literalCases(source);
    const runners = legacyRunners(source);
    files.push({ id: stableId('file', revision, relative), path: relative, case_count: detected.length });
    detected.forEach((entry, index) => cases.push({
      id: stableId('case', revision, relative, String(index), entry.name),
      file: relative,
      name: entry.name,
      ordinal: index,
    }));
    if (detected.length === 0) unresolved.push({ file: relative, reason: 'no-literal-test-case-detected' });
    for (const runner of runners) unresolved.push({ file: relative, reason: 'legacy-exported-runner', runner });
    if (relative.endsWith('.spec.js')) unresolved.push({ file: relative, reason: 'legacy-spec-file' });
  }

  return {
    schema: 'overcenter-test-audit-v1',
    revision,
    files,
    cases,
    unresolved,
    summary: {
      files: files.length,
      cases: cases.length,
      unresolved: unresolved.length,
    },
  };
}