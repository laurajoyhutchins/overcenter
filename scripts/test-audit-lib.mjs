import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next']);
const TEST_FILE = /\.test\.(?:js|mjs)$/;

function stableId(revision, path, offset, name) {
  return createHash('sha256').update(`${revision}\0${path}\0${offset}\0${name}`).digest('hex');
}

function repoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function importedNodeTestAliases(sourceFile) {
  const aliases = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test') continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) aliases.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text || element.name.text;
        if (imported === 'test' || imported === 'it') aliases.add(element.name.text);
      }
    }
  }
  return aliases;
}

function nativeTestCallee(expression, aliases) {
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (!ts.isIdentifier(expression.expression) || !aliases.has(expression.expression.text)) return false;
  return ['only', 'skip', 'todo'].includes(expression.name.text);
}

export function auditTestSource({ source, path, revision }) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const aliases = importedNodeTestAliases(sourceFile);
  const cases = [];
  const unresolved = [];

  if (aliases.size === 0) {
    unresolved.push({ path, kind:'legacy-test-runner', detail:'test file does not import node:test' });
    return { path, cases, unresolved };
  }

  function visit(node) {
    if (ts.isCallExpression(node) && nativeTestCallee(node.expression, aliases)) {
      const name = node.arguments[0];
      if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) {
        cases.push({
          audit_id: stableId(revision, path, node.getStart(sourceFile), name.text),
          path,
          name:name.text,
          offset:node.getStart(sourceFile),
        });
      } else {
        unresolved.push({ path, kind:'nonliteral-test-name', offset:node.getStart(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (cases.length === 0 && unresolved.length === 0) {
    unresolved.push({ path, kind:'no-literal-native-tests', detail:'node:test is imported but no literal test()/it() cases were found' });
  }
  return { path, cases, unresolved };
}

async function collectTestFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTestFiles(root, absolute));
    else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(absolute);
  }
  return files;
}

export async function auditRepository({ root, revision }) {
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('test audit requires an exact 40-character Git revision');
  const files = (await collectTestFiles(root)).sort();
  const audits = [];
  for (const absolute of files) {
    const path = repoPath(root, absolute);
    audits.push(auditTestSource({ source:await readFile(absolute, 'utf8'), path, revision }));
  }
  const cases = audits.flatMap((audit) => audit.cases).sort((a, b) => a.audit_id.localeCompare(b.audit_id));
  const unresolved = audits.flatMap((audit) => audit.unresolved);
  return {
    schema:'overcenter-test-audit-v1',
    revision:revision.toLowerCase(),
    file_count:files.length,
    case_count:cases.length,
    unresolved_count:unresolved.length,
    files:audits.map(({ path }) => path),
    cases,
    unresolved,
  };
}
