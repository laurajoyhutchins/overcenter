import { createHash } from 'node:crypto';

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

function detectTestCalls(source) {
  const tests = [...source.matchAll(/\b(?:test|it)\s*\(/g)].length;
  const skips = [...source.matchAll(/\b(?:test|it)\.skip\s*\(/g)].length;
  const todos = [...source.matchAll(/\b(?:test|it)\.todo\s*\(/g)].length;
  return { tests, skips, todos, cases: tests + skips + todos };
}

function classifyRegressionModule(path, source) {
  const cases = source
    .split(/\n\s{2}\},\n/)
    .filter((entry) => /\bname\s*:/.test(entry));
  const tests = [...source.matchAll(/\btest\s*:/g)].length;
  if (cases.length === 0 || tests !== cases.length) {
    return Object.freeze({
      path,
      kind: 'unresolved',
      code: 'TEST_SHAPE_UNRESOLVED',
      reason: `regression case inventory is not statically exhaustive (cases=${cases.length}, tests=${tests})`,
    });
  }
  return frozenIdentity(path, 'regression-module', { tests, skips: 0, todos: 0, cases: cases.length });
}

export function isAuditedTestPath(path) {
  return AUDITED_TEST_PATHS.some((pattern) => pattern.test(path));
}

export function auditTestFile(path, source) {
  if (!isAuditedTestPath(path)) {
    return Object.freeze({ path, kind: 'unresolved', code: 'TEST_SHAPE_UNRESOLVED', reason: 'path is outside the audited test inventory' });
  }

  if (/^lib\/regression-tests-/.test(path)) return classifyRegressionModule(path, source);

  const counts = detectTestCalls(source);
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
