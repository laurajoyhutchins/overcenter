import { verifyExactRevision } from './exact-revision-verification.js';

function assert(value, message) { if (!value) throw new Error(message); }

export async function runExactRevisionVerificationTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('attributes successful regression evidence to the requested exact revision', async()=>{
    const calls = [];
    const runtime = {
      resolveRevision:async ({ repository, revision }) => {
        calls.push(['RESOLVE', repository, revision]);
        return { repository, revision };
      },
      executeRevisionRegression:async ({ repository, revision }) => {
        calls.push(['EXECUTE', repository, revision]);
        return {
          repository,
          revision,
          result:{ ok:true, schema:'regression-verification-v1', passed:12, failed:0, suite_count:3, registered_suite_count:5, suites:{} },
        };
      },
    };
    const result = await verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, runtime);
    assert(result.ok === true, 'verification did not succeed');
    assert(result.schema === 'exact-revision-verification-v1', 'wrong schema');
    assert(result.repository === 'laurajoyhutchins/busbar', 'repository attribution missing');
    assert(result.revision === 'abc123', 'revision attribution missing');
    assert(result.regression?.passed === 12, 'regression result missing');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['RESOLVE','laurajoyhutchins/busbar','abc123'],
      ['EXECUTE','laurajoyhutchins/busbar','abc123'],
    ]), 'verification did not resolve then execute exact revision');
  });

  await test('fails before execution when requested revision does not resolve exactly', async()=>{
    let executed = false;
    let code = null;
    try {
      await verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
        resolveRevision:async () => ({ repository:'laurajoyhutchins/busbar', revision:'def456' }),
        executeRevisionRegression:async () => { executed = true; return {}; },
      });
    } catch (error) { code = error?.code || null; }
    assert(code === 'EXACT_REVISION_MISMATCH', 'revision mismatch did not fail closed');
    assert(executed === false, 'mismatched revision was executed');
  });

  await test('rejects regression evidence attributed to another revision', async()=>{
    let code = null;
    try {
      await verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
        resolveRevision:async ({ repository, revision }) => ({ repository, revision }),
        executeRevisionRegression:async ({ repository }) => ({ repository, revision:'def456', result:{ ok:true, schema:'regression-verification-v1' } }),
      });
    } catch (error) { code = error?.code || null; }
    assert(code === 'EXACT_REVISION_EVIDENCE_MISMATCH', 'misattributed evidence was accepted');
  });

  await test('fails closed when exact revision executor is unavailable', async()=>{
    let code = null;
    try {
      await verifyExactRevision({ repository:'laurajoyhutchins/busbar', revision:'abc123' }, {
        resolveRevision:async ({ repository, revision }) => ({ repository, revision }),
      });
    } catch (error) { code = error?.code || null; }
    assert(code === 'EXACT_REVISION_EXECUTOR_UNAVAILABLE', 'missing executor did not fail closed');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
