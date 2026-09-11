import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyExactRevision } from './exact-revision-verification.js';

test('attributes successful regression evidence to the requested exact revision', async () => {
  const calls = [];
  const runtime = {
    resolveRevision:async ({ repository, revision }) => {
      calls.push(['RESOLVE', repository, revision]);
      return { repository, revision };
    },
    executeRevisionRegression:async ({ repository, revision }) => {
      calls.push(['EXECUTE', repository, revision]);
      return { repository, revision, result:{ ok:true, schema:'regression-verification-v1', passed:12, failed:0, suite_count:3, registered_suite_count:5, suites:{} } };
    },
  };
  const result = await verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, runtime);
  assert.equal(result.ok, true);
  assert.equal(result.schema, 'exact-revision-verification-v1');
  assert.equal(result.repository, 'laurajoyhutchins/busbar');
  assert.equal(result.revision, 'abc123');
  assert.equal(result.regression?.passed, 12);
  assert.deepEqual(calls, [['RESOLVE','laurajoyhutchins/busbar','abc123'], ['EXECUTE','laurajoyhutchins/busbar','abc123']]);
});

test('fails before execution when requested revision does not resolve exactly', async () => {
  let executed = false;
  await assert.rejects(
    verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
      resolveRevision:async () => ({ repository:'laurajoyhutchins/busbar', revision:'def456' }),
      executeRevisionRegression:async () => { executed = true; return {}; },
    }),
    (error) => error?.code === 'EXACT_REVISION_MISMATCH',
  );
  assert.equal(executed, false);
});

test('rejects regression evidence attributed to another revision', async () => {
  await assert.rejects(
    verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
      resolveRevision:async ({ repository, revision }) => ({ repository, revision }),
      executeRevisionRegression:async ({ repository }) => ({ repository, revision:'def456', result:{ ok:true, schema:'regression-verification-v1' } }),
    }),
    (error) => error?.code === 'EXACT_REVISION_EVIDENCE_MISMATCH',
  );
});

test('fails closed when exact revision executor is unavailable', async () => {
  await assert.rejects(
    verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
      resolveRevision:async ({ repository, revision }) => ({ repository, revision }),
    }),
    (error) => error?.code === 'EXACT_REVISION_EXECUTOR_UNAVAILABLE',
  );
});
