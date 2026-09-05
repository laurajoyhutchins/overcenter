import { createHash } from 'node:crypto';
import ts from 'typescript';

const SHA40 = /^[0-9a-f]{40}$/;
const TEST_CALLEES = new Set(['test', 'it']);
const TEST_MODIFIERS = new Set(['skip', 'todo', 'only']);

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function calleeShape(expression) {
  if (ts.isIdentifier(expression) && TEST_CALLEES.has(expression.text)) {
    return { callee:expression.text, modifier:null };
  }
  if (ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && TEST_CALLEES.has(expression.expression.text)
      && TEST_MODIFIERS.has(expression.name.text)) {
    return { callee:expression.expression.text, modifier:expression.name.text };
  }
  return null;
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

export function extractLiteralTestCases(source, { file = 'test.js' } = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const cases = [];
  const unresolved = [];
  let ordinal = 0;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const shape = calleeShape(node.expression);
      if (shape) {
        const line = lineOf(sourceFile, node);
        const name = literalText(node.arguments[0]);
        if (name === null) {
          unresolved.push(Object.freeze({ file, line, ordinal, callee:shape.callee, modifier:shape.modifier, reason:'non_literal_test_name' }));
        } else {
          cases.push(Object.freeze({ file, line, ordinal, name, callee:shape.callee, modifier:shape.modifier }));
        }
        ordinal += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.freeze({ cases:Object.freeze(cases), unresolved:Object.freeze(unresolved) });
}

export function stableAuditTestId({ revision, file, name, ordinal }) {
  const normalizedRevision = String(revision || '').toLowerCase();
  if (!SHA40.test(normalizedRevision)) throw new Error('revision must be an exact 40-character Git SHA');
  if (typeof file !== 'string' || !file) throw new Error('file must be a non-empty string');
  if (typeof name !== 'string' || !name) throw new Error('name must be a non-empty string');
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error('ordinal must be a non-negative integer');
  const digest = createHash('sha256').update(`${normalizedRevision}\0${file}\0${name}\0${ordinal}`).digest('hex');
  return `test_${digest.slice(0, 16)}`;
}

export function classifyScriptTestLane(file, { maintained, integration }) {
  if (!(maintained instanceof Set) || !(integration instanceof Set)) throw new TypeError('maintained and integration must be Sets');
  const memberships = [];
  if (maintained.has(file)) memberships.push('maintained');
  if (integration.has(file)) memberships.push('integration');
  if (memberships.length > 1) throw new Error(`${file} belongs to multiple execution lanes: ${memberships.join(', ')}`);
  return memberships[0] || 'unregistered';
}

export function collectRunnerTestSelection(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const sourceFile = ts.createSourceFile('runner.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const files = new Set();
  const prefixes = new Set();

  function collectArrayStrings(node, target) {
    if (!ts.isArrayLiteralExpression(node)) return;
    for (const element of node.elements) {
      const value = literalText(element);
      if (value !== null) target.add(value);
    }
  }

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.endsWith('.test.mjs') && node.text !== '.test.mjs') {
        files.add(node.text.startsWith('scripts/') ? node.text : `scripts/${node.text}`);
      }
    }
    if (ts.isForOfStatement(node)
        && ts.isVariableDeclarationList(node.initializer)
        && node.initializer.declarations.length === 1) {
      const declaration = node.initializer.declarations[0];
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'prefix') {
        collectArrayStrings(node.expression, prefixes);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.freeze({ files, prefixes });
}