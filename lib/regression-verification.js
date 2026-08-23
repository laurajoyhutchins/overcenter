import { REGRESSION_SUITE_REGISTRY } from 'lib/regression-suite-registry.js';

function count(result, field) {
  return Number(result?.[field] || 0);
}

function caseCount(result) {
  const explicit = Number(result?.total);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return count(result, 'passed') + count(result, 'failed');
}

function aggregateGroup(entries) {
  const suites = Object.fromEntries(entries.map(({ descriptor, result }) => [descriptor.key, result]));
  const values = entries.map(({ result }) => result);
  return {
    ok: values.every((suite) => suite?.ok === true),
    passed: values.reduce((sum, suite) => sum + count(suite, 'passed'), 0),
    failed: values.reduce((sum, suite) => sum + count(suite, 'failed'), 0),
    total: values.reduce((sum, suite) => sum + caseCount(suite), 0),
    suites,
  };
}

export async function runRegressionVerification() {
  const executed = await Promise.all(REGRESSION_SUITE_REGISTRY.map(async (descriptor) => ({
    descriptor,
    result: await descriptor.run(),
  })));

  const grouped = new Map();
  for (const entry of executed) {
    if (!grouped.has(entry.descriptor.group)) grouped.set(entry.descriptor.group, []);
    grouped.get(entry.descriptor.group).push(entry);
  }

  const suites = {};
  for (const [group, entries] of grouped.entries()) {
    suites[group] = entries.length === 1 && entries[0].descriptor.direct === true
      ? entries[0].result
      : aggregateGroup(entries);
  }

  const passed = executed.reduce((sum, { result }) => sum + count(result, 'passed'), 0);
  const failed = executed.reduce((sum, { result }) => sum + count(result, 'failed'), 0);
  const total = executed.reduce((sum, { result }) => sum + caseCount(result), 0);

  return {
    ok: executed.every(({ result }) => result?.ok === true),
    schema: 'regression-verification-v1',
    suites,
    passed,
    failed,
    total,
    suite_count: REGRESSION_SUITE_REGISTRY.length,
    group_count: Object.keys(suites).length,
    test_file_count: REGRESSION_SUITE_REGISTRY.filter(({ source }) => source.endsWith('.test.js')).length,
  };
}
