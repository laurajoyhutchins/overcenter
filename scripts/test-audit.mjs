import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const TEST_FILE = /\.(?:test|spec)\.(?:js|mjs)$/;
const LEGACY_TEST_FN = /^test[A-Z][A-Za-z0-9_$]*$/;

async function filesUnder(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const next = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function literalText(node) {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) return `${node.expression.expression.text}.${node.expression.name.text}`;
  return null;
}

function stableId(revision, file, kind, name, ordinal) {
  return createHash('sha256').update(`${revision}\0${file}\0${kind}\0${name}\0${ordinal}`).digest('hex');
}

function auditFile({ file, source, revision }) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) return { cases:[], unresolved:[{ file, kind:'parse_error', detail:parsed.parseDiagnostics.map((entry) => String(entry.messageText)).join('; ') }] };
  const cases = [];
  const unresolved = [];
  const legacy = new Set();
  for (const statement of parsed.statements) if (ts.isFunctionDeclaration(statement) && statement.name && LEGACY_TEST_FN.test(statement.name.text)) legacy.add(statement.name.text);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (['test','it','test.only','test.skip','it.only','it.skip'].includes(name)) {
        const title = node.arguments.length ? literalText(node.arguments[0]) : null;
        if (title === null) unresolved.push({ file, kind:'dynamic_test_title', detail:name });
        else cases.push({ file, kind:'node_test', name:title });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const name of [...legacy].sort()) cases.push({ file, kind:'legacy_named_test', name });
  const counts = new Map();
  return {
    cases:cases.map((entry) => {
      const key = `${entry.kind}\0${entry.name}`;
      const ordinal = (counts.get(key) || 0) + 1;
      counts.set(key, ordinal);
      return { ...entry, ordinal, audit_id:stableId(revision, entry.file, entry.kind, entry.name, ordinal) };
    }),
    unresolved,
  };
}

export async function auditRepositoryTests({ root, revision }) {
  if (!/^[0-9a-f]{40}$/i.test(String(revision || ''))) throw new Error('test audit requires an exact 40-character Git revision');
  const exactRevision = String(revision).toLowerCase();
  const testFiles = (await filesUnder(root)).filter((file) => TEST_FILE.test(file)).sort();
  const cases = [];
  const unresolved = [];
  for (const file of testFiles) {
    const result = auditFile({ file, source:await readFile(path.join(root, file), 'utf8'), revision:exactRevision });
    cases.push(...result.cases);
    unresolved.push(...result.unresolved);
  }
  return { schema:'overcenter-test-audit-v1', revision:exactRevision, test_files:testFiles, test_file_count:testFiles.length, case_count:cases.length, unresolved_shape_count:unresolved.length, cases, unresolved };
}
