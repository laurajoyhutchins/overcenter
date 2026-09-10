import { createHash } from 'node:crypto';
import ts from 'typescript';

const AUDITED_TEST_PATHS = [
  /^lib\/[^/]+\.test\.mjs$/,
  /^lib\/regression-tests-[^/]+\.mjs$/,
  /^lib\/test-[^/]+\.mjs$/,
  /^scripts\/[^/]+\.test\.mjs$/,
];

const EXPLICIT_DYNAMIC_FORMS = new Map([
  ['lib/regression-suites.test.mjs', 'runtime-generated suite cases are audited through their static registry source'],
  ['lib/test-run-hooks.mjs', 'runtime hook module has no independently enumerable test cases'],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceFileFor(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length > 0) {
    const detail = file.parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
    throw new SyntaxError(`cannot audit syntactically invalid test source ${path}: ${detail}`);
  }
  return file;
}

function frozenIdentity(path, kind, counts, detail = undefined) {
  return Object.freeze({
    path,
    kind,
    expected_tests: counts.tests,
    expected_skips: counts.skips,
    expected_todos: counts.todos,
    expected_cases: counts.cases,
    ...(detail ? { detail } : {}),
  });
}

function detectTestCalls(path, source) {
  const file = sourceFileFor(path, source);
  const counts = { tests: 0, skips: 0, todos: 0, cases: 0 };
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && (expression.text === 'test' || expression.text === 'it')) {
        counts.tests += 1;
        counts.cases += 1;
      } else if (
        ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && (expression.expression.text === 'test' || expression.expression.text === 'it')
      ) {
        if (expression.name.text === 'skip') {
          counts.skips += 1;
          counts.cases += 1;
        } else if (expression.name.text === 'todo') {
          counts.todos += 1;
          counts.cases += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return counts;
}

function propertyName(property) {
  if (!property?.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) return property.name.text;
  return null;
}

function classifyRegressionModule(path, source) {
  const file = sourceFileFor(path, source);
  let cases = 0;
  let tests = 0;
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(propertyName).filter(Boolean));
      if (names.has('name') && names.has('test')) {
        cases += 1;
        tests += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (cases === 0) {
    return Object.freeze({
      path,
      kind: 'unresolved',
      code: 'TEST_SHAPE_UNRESOLVED',
      reason: 'regression case inventory is not statically enumerable as object literals containing name and test properties',
    });
  }
  return frozenIdentity(path, 'regression-module', { tests, skips: 0, todos: 0, cases });
}

export function isAuditedTestPath(path) {
  return AUDITED_TEST_PATHS.some((pattern) => pattern.test(path));
}

export function auditTestFile(path, source) {
  if (!isAuditedTestPath(path)) {
    return Object.freeze({ path, kind: 'unresolved', code: 'TEST_SHAPE_UNRESOLVED', reason: 'path is outside the audited test inventory' });
  }

  if (/^lib\/regression-tests-/.test(path)) return classifyRegressionModule(path, source);

  const counts = detectTestCalls(path, source);
  if (counts.cases > 0) return frozenIdentity(path, 'test-module', counts);

  const explicitReason = EXPLICIT_DYNAMIC_FORMS.get(path);
  if (explicitReason) return frozenIdentity(path, 'runtime-hook', { tests: 0, skips: 0, todos: 0, cases: 0 }, explicitReason);

  return Object.freeze({
    path,
    kind: 'unresolved',
    code: 'TEST_SHAPE_UNRESOLVED',
    reason: 'no statically auditable test shape or explicit dynamic-form exemption',
  });
}

export function assertAuditIdentity(identity) {
  if (!identity || identity.kind === 'unresolved' || identity.code === 'TEST_SHAPE_UNRESOLVED') {
    const path = identity?.path ?? '<unknown>';
    throw new Error(`TEST_SHAPE_UNRESOLVED: ${path}`);
  }
  for (const field of ['expected_tests', 'expected_skips', 'expected_todos', 'expected_cases']) {
    if (!Number.isInteger(identity[field]) || identity[field] < 0) {
      throw new TypeError(`invalid audit identity field ${field}`);
    }
  }
  return identity;
}

export function createAuditIdentity(path, source, revision) {
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new TypeError('audit identity requires an exact 40-character Git revision');
  }
  const classification = assertAuditIdentity(auditTestFile(path, source));
  const source_sha256 = sha256(source);
  const audit_id = sha256(`overcenter-test-audit-v1\0${revision.toLowerCase()}\0${path}\0${source_sha256}`);
  return Object.freeze({ ...classification, revision: revision.toLowerCase(), source_sha256, audit_id });
}
