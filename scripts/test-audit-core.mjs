import { createHash } from 'node:crypto';
import ts from 'typescript';

function parse(source, file) {
  const kind = /\.(?:ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if (parsed.parseDiagnostics.length) {
    const message = parsed.parseDiagnostics.map((entry) => String(entry.messageText)).join('; ');
    throw new Error(`${file}: unable to parse test source: ${message}`);
  }
  return parsed;
}

function testCallee(call) {
  if (ts.isIdentifier(call.expression) && ['test', 'it'].includes(call.expression.text)) {
    return { base:call.expression.text, modifier:null };
  }
  if (ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression)
      && ['test', 'it'].includes(call.expression.expression.text)
      && ['skip', 'todo', 'only'].includes(call.expression.name.text)) {
    return { base:call.expression.expression.text, modifier:call.expression.name.text };
  }
  return null;
}

function literalName(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

export function extractLiteralTestCases(source, { file = 'unknown.test.js' } = {}) {
  const parsed = parse(source, file);
  const cases = [];
  const unresolved = [];
  let ordinal = 0;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = testCallee(node);
      if (callee) {
        const currentOrdinal = ordinal++;
        const name = literalName(node.arguments[0]);
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
        if (name === null) {
          unresolved.push(Object.freeze({
            file,
            line,
            ordinal:currentOrdinal,
            reason:'non_literal_test_name',
            callee:callee.base,
            modifier:callee.modifier,
          }));
        } else {
          cases.push(Object.freeze({
            file,
            line,
            ordinal:currentOrdinal,
            name,
            callee:callee.base,
            modifier:callee.modifier,
          }));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return Object.freeze({ cases:Object.freeze(cases), unresolved:Object.freeze(unresolved) });
}

export function stableAuditTestId({ revision, file, name, ordinal }) {
  const normalizedRevision = String(revision || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedRevision)) throw new Error('revision must be a full 40-character Git SHA');
  if (typeof file !== 'string' || !file.trim()) throw new Error('file must be a non-empty string');
  if (typeof name !== 'string') throw new Error('name must be a string');
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error('ordinal must be a non-negative integer');
  const digest = createHash('sha256')
    .update(JSON.stringify([normalizedRevision, file.replaceAll('\\', '/'), name, ordinal]))
    .digest('hex');
  return `test_${digest.slice(0, 16)}`;
}

export function classifyScriptTestLane(file, { maintained = [], integration = [] } = {}) {
  const normalized = String(file).replaceAll('\\', '/');
  const memberships = [];
  if (new Set(maintained.map((entry) => String(entry).replaceAll('\\', '/'))).has(normalized)) memberships.push('maintained');
  if (new Set(integration.map((entry) => String(entry).replaceAll('\\', '/'))).has(normalized)) memberships.push('integration');
  if (memberships.length > 1) throw new Error(`${normalized} belongs to multiple execution lanes: ${memberships.join(', ')}`);
  return memberships[0] || 'unregistered';
}

export function collectRunnerTestSelection(source, { file = 'scripts/test.mjs' } = {}) {
  const parsed = parse(source, file);
  const explicit = new Set();
  const prefixes = new Set();

  function variableName(initializer) {
    return ts.isVariableDeclaration(initializer) && ts.isIdentifier(initializer.name) ? initializer.name.text : null;
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)
        && variableName(node) === 'maintainedTests'
        && node.initializer
        && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if ((ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) && element.text.endsWith('.test.mjs')) {
          explicit.add(element.text);
        }
      }
    }
    if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression)) {
      const declaration = node.initializer;
      const declarationList = ts.isVariableDeclarationList(declaration) ? declaration.declarations : [];
      const loopName = declarationList.length === 1 && ts.isIdentifier(declarationList[0].name) ? declarationList[0].name.text : null;
      if (loopName === 'prefix') {
        for (const element of node.expression.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) prefixes.add(element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return Object.freeze({
    explicit:Object.freeze([...explicit].sort()),
    prefixes:Object.freeze([...prefixes].sort()),
  });
}