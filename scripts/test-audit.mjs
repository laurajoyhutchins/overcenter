import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const TEST_SUFFIXES = Object.freeze(['.test.js', '.test.mjs']);
const TEST_ROOTS = Object.freeze(['lib', 'scripts']);
const SHA40 = /^[0-9a-f]{40}$/;

function repoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

async function collectTestFiles(root, directory) {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectTestFiles(root, repoPath(root, child)));
    else if (entry.isFile() && TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) files.push(child);
  }
  return files;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text;
  return null;
}

function stableAuditId({ revision, path, name, ordinal }) {
  return createHash('sha256')
    .update(`${revision}\0${path}\0${name}\0${ordinal}`)
    .digest('hex');
}

function inspectSource({ source, path, revision }) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const cases = [];
  const unresolved = [];
  let nativeCallCount = 0;
  let legacyRunCallCount = 0;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === 'test' || name === 'it') {
        nativeCallCount += 1;
        const title = node.arguments.length ? literalText(node.arguments[0]) : null;
        if (title === null) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          unresolved.push({ path, kind: 'dynamic-test-name', line: line + 1, column: character + 1 });
        } else {
          const ordinal = cases.length;
          cases.push({
            id: stableAuditId({ revision, path, name: title, ordinal }),
            path,
            name: title,
            ordinal,
          });
        }
      } else if (name === 'run' && node.arguments.length >= 2 && literalText(node.arguments[0]) !== null) {
        legacyRunCallCount += 1;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (nativeCallCount === 0) {
    unresolved.push({
      path,
      kind: legacyRunCallCount > 0 ? 'legacy-runner-only' : 'no-native-test-cases',
      legacy_literal_cases: legacyRunCallCount,
    });
  } else if (legacyRunCallCount > 0) {
    unresolved.push({ path, kind: 'legacy-runner-present', legacy_literal_cases: legacyRunCallCount });
  }
  return { cases, unresolved };
}

function gitRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().toLowerCase();
}

export async function auditRepository({ root = process.cwd(), revision = null } = {}) {
  const exactRevision = String(revision || gitRevision(root)).trim().toLowerCase();
  if (!SHA40.test(exactRevision)) throw new Error('test audit requires an exact 40-character Git revision');

  const files = [];
  for (const directory of TEST_ROOTS) files.push(...await collectTestFiles(root, directory));
  files.sort((a, b) => repoPath(root, a).localeCompare(repoPath(root, b)));

  const cases = [];
  const unresolved = [];
  for (const absolute of files) {
    const path = repoPath(root, absolute);
    const source = await readFile(absolute, 'utf8');
    const inspected = inspectSource({ source, path, revision: exactRevision });
    cases.push(...inspected.cases);
    unresolved.push(...inspected.unresolved);
  }

  return Object.freeze({
    schema: 'overcenter-test-audit-v1',
    revision: exactRevision,
    file_count: files.length,
    case_count: cases.length,
    unresolved_count: unresolved.length,
    files: files.map((absolute) => repoPath(root, absolute)),
    cases,
    unresolved,
  });
}

async function main() {
  const result = await auditRepository();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.argv.includes('--check') && result.unresolved_count !== 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}