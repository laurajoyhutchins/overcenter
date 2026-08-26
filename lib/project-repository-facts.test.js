import { normalizeProjectRepositoryFacts } from './project-repository-facts.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

function candidate(overrides = {}) {
  return {
    schema:'project-repository-facts-v1',
    repository:'laurajoyhutchins/overcenter',
    revision:REVISION,
    default_branch:'main',
    pull_requests:[{
      number:41,
      state:'open',
      draft:true,
      mergeable:true,
      head_sha:HEAD,
      base_sha:REVISION,
      checks:[
        { name:'repository-static', status:'completed', conclusion:'failure' },
        { name:'another-check', status:'queued', conclusion:null },
      ],
    }],
    ...overrides,
  };
}

export async function runProjectRepositoryFactsTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('normalizes exact revision-attributed repository and pull-request facts', async()=>{
    const result = normalizeProjectRepositoryFacts(candidate());
    assert(result.schema === 'project-repository-facts-v1', 'schema mismatch');
    assert(result.repository === 'laurajoyhutchins/overcenter', 'repository mismatch');
    assert(result.revision === REVISION, 'revision mismatch');
    assert(result.pull_requests.length === 1, 'pull request count mismatch');
    assert(result.pull_requests[0].head_sha === HEAD, 'head attribution mismatch');
    assert(result.pull_requests[0].checks[0].name === 'another-check', 'checks were not normalized deterministically');
  });

  await test('rejects ambiguous or inexact repository authority', async()=>{
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ repository:'overcenter' })), 'implicit repository accepted');
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ revision:'main' })), 'symbolic revision accepted');
  });

  await test('rejects unsupported facts instead of silently extending graph authority', async()=>{
    expectFailure(()=>normalizeProjectRepositoryFacts({ ...candidate(), issues:[] }), 'unsupported issue facts accepted');
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ schema:'project-repository-facts-v2' })), 'unsupported schema accepted');
  });

  await test('rejects duplicate pull-request identities', async()=>{
    const value = candidate();
    value.pull_requests = [value.pull_requests[0], { ...value.pull_requests[0] }];
    expectFailure(()=>normalizeProjectRepositoryFacts(value), 'duplicate pull request number accepted');
  });

  await test('rejects malformed check state and conclusion attribution', async()=>{
    const badStatus = candidate();
    badStatus.pull_requests[0].checks = [{ name:'x', status:'waiting', conclusion:null }];
    expectFailure(()=>normalizeProjectRepositoryFacts(badStatus), 'unsupported check status accepted');

    const earlyConclusion = candidate();
    earlyConclusion.pull_requests[0].checks = [{ name:'x', status:'queued', conclusion:'success' }];
    expectFailure(()=>normalizeProjectRepositoryFacts(earlyConclusion), 'conclusion accepted before completion');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
