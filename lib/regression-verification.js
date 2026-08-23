import { REGRESSION_GROUP_ORDER, REGRESSION_SUITES } from 'lib/regression-suite-registry.js';

function count(result, field) {
  return Number(result?.[field] || 0);
}

function total(result) {
  if (Number.isFinite(Number(result?.total))) return Number(result.total);
  if (Array.isArray(result?.tests)) return result.tests.length;
  if (Array.isArray(result?.results)) return result.results.length;
  return count(result, 'passed') + count(result, 'failed');
}

function aggregate(entries) {
  if (entries.length === 1) return entries[0].result;
  const suites = Object.fromEntries(entries.map(({ descriptor, result }) => [descriptor.name, result]));
  const values = Object.values(suites);
  return {
    ok: values.every((suite) => suite?.ok === true),
    passed: values.reduce((sum, suite) => sum + count(suite, 'passed'), 0),
    failed: values.reduce((sum, suite) => sum + count(suite, 'failed'), 0),
    total: values.reduce((sum, suite) => sum + total(suite), 0),
    suites,
  };
}

export async function runRegressionVerification() {
  const executed = await Promise.all(REGRESSION_SUITES.map(async (descriptor) => ({
    descriptor,
    result: await descriptor.run(),
  })));

  const suites = Object.fromEntries(REGRESSION_GROUP_ORDER.map((group) => [
    group,
    aggregate(executed.filter(({ descriptor }) => descriptor.group === group)),
  ]));
  const values = Object.values(suites);

  return {
    ok: values.every((suite) => suite?.ok === true),
    schema: 'regression-verification-v1',
    suites,
    passed: values.reduce((sum, suite) => sum + count(suite, 'passed'), 0),
    failed: values.reduce((sum, suite) => sum + count(suite, 'failed'), 0),
    suite_count: values.length,
    registered_suite_count: REGRESSION_SUITES.length,
  };
}
