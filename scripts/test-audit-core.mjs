import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const TEST_FILE = /\.(?:test|spec)\.(?:js|mjs|cjs)$/;
const TEST_CALLS = new Set(['test', 'it']);

async function filesUnder(root, relative = '.') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const next = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules'].includes(entry.name)) files.push(...await filesUnder(root, next));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      files.push(next.replaceAll(path.sep, '/'));
    }
  }
  return files.sort();
}

function literalName(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'test') return 'test';
  return null;
}

function auditFile(file, source, revision) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const cases = [];
  const unresolved = [];
  let ordinal = 0;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name && TEST_CALLS.has(name)) {
        ordinal += 1;
        const title = node.arguments[0] ? literalName(node.arguments[0]) : null;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (title === null) unresolved.push({ file, line, reason:'non-literal-test-name' });
        else {
          const id = createHash('sha256').update(`${revision}\0${file}\0${title}\0${ordinal}`).digest('hex').slice(0, 20);
          cases.push({ id, file, line, title, ordinal });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { cases, unresolved };
}

export async function auditTestCensus({ root, revision }) {
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`expected exact Git revision, got ${revision}`);
  const files = await filesUnder(root);
  const cases = [];
  const unresolved = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    const result = auditFile(file, source, revision);
    cases.push(...result.cases);
    unresolved.push(...result.unresolved);
  }
  return { schema:'overcenter-test-audit-v1', revision:revision.toLowerCase(), files, cases, unresolved };
}