import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditTestFile, createAuditIdentity, isAuditedTestPath } from './test-audit-core.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function repoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

async function walk(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(repoPath(root, absolute));
  }
  return files;
}

export async function discoverAuditedTestPaths(root) {
  const paths = [];
  for (const directory of ['lib', 'scripts']) {
    for (const path of await walk(root, join(root, directory))) {
      if (isAuditedTestPath(path)) paths.push(path);
    }
  }
  return paths.sort();
}

export async function auditRepository({ root, revision }) {
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new TypeError('repository audit requires an exact 40-character Git revision');
  }
  const normalizedRevision = revision.toLowerCase();
  const paths = await discoverAuditedTestPaths(root);
  const identities = [];
  const unresolved = [];

  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8');
    try {
      const classification = auditTestFile(path, source);
      if (classification.kind === 'unresolved') {
        unresolved.push(classification);
      } else {
        identities.push(createAuditIdentity(path, source, normalizedRevision));
      }
    } catch (error) {
      unresolved.push(Object.freeze({
        path,
        kind: 'unresolved',
        code: 'TEST_SHAPE_UNRESOLVED',
        reason: String(error?.message || error),
      }));
    }
  }

  const totals = identities.reduce((acc, identity) => ({
    files: acc.files + 1,
    tests: acc.tests + identity.expected_tests,
    skips: acc.skips + identity.expected_skips,
    todos: acc.todos + identity.expected_todos,
    cases: acc.cases + identity.expected_cases,
  }), { files: 0, tests: 0, skips: 0, todos: 0, cases: 0 });

  const manifestBody = JSON.stringify({ revision: normalizedRevision, identities });
  return Object.freeze({
    schema: 'overcenter-test-audit-v1',
    ok: unresolved.length === 0,
    revision: normalizedRevision,
    discovered_files: paths.length,
    totals: Object.freeze(totals),
    identities: Object.freeze(identities),
    unresolved: Object.freeze(unresolved),
    manifest_sha256: sha256(manifestBody),
  });
}

function currentRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await auditRepository({ root, revision: currentRevision(root) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
