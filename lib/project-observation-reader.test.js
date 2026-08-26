import { createProjectObservationReader } from './project-observation-reader.js';

function assert(value, message) { if (!value) throw new Error(message); }

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

function facts(overrides = {}) {
  return {
    schema:'project-repository-facts-v1',
    repository:'laurajoyhutchins/overcenter',
    revision:REVISION,
    default_branch:'main',
    pull_requests:[{
      number:57,
      state:'open',
      draft:true,
      mergeable:true,
      head_sha:HEAD,
      base_sha:REVISION,
      checks:[{ name:'repository-static', status:'completed', conclusion:'success' }],
    }],
    ...overrides,
  };
}

export async function runProjectObservationReaderTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('derives deterministic exact-revision observations from GitHub authority facts', async()=>{
    const read = createProjectObservationReader();
    const result = await read({
      project_ref:'github:laurajoyhutchins/overcenter#pull/57',
      repository:'laurajoyhutchins/overcenter',
      revision:REVISION,
      facts:facts(),
      nodes:[],
    });
    assert(result.length === 3, 'unexpected observation count');
    assert(result[0].kind === 'github.repository_revision', 'repository observation missing');
    assert(result[0].revision === REVISION, 'repository observation lost exact revision');
    assert(result[1].kind === 'github.pull_request' && result[1].pull_request === 57, 'pull request observation missing');
    assert(result[2].kind === 'github.check_run' && result[2].head_sha === HEAD, 'check observation missing');
  });

  await test('sorts pull requests and checks deterministically', async()=>{
    const read = createProjectObservationReader();
    const input = facts({ pull_requests:[
      {
        number:58,
        state:'open',
        draft:false,
        mergeable:null,
        head_sha:HEAD,
        base_sha:REVISION,
        checks:[{ name:'zeta', status:'queued', conclusion:null }, { name:'alpha', status:'completed', conclusion:'failure' }],
      },
      facts().pull_requests[0],
    ] });
    const result = await read({ project_ref:'github:laurajoyhutchins/overcenter', repository:input.repository, revision:REVISION, facts:input, nodes:[] });
    const keys = result.map((entry)=>entry.observation_key);
    assert(JSON.stringify(keys) === JSON.stringify([...keys].sort()), 'observations are not deterministically ordered');
  });

  await test('fails closed when facts are not attributable to the resolved exact revision', async()=>{
    const read = createProjectObservationReader();
    let code = null;
    try {
      await read({
        project_ref:'github:laurajoyhutchins/overcenter',
        repository:'laurajoyhutchins/overcenter',
        revision:REVISION,
        facts:facts({ revision:HEAD }),
        nodes:[],
      });
    } catch (error) { code = error?.code || null; }
    assert(code === 'PROJECT_OBSERVATIONS_AUTHORITY_MISMATCH', 'revision mismatch did not fail closed');
  });

  await test('does not accept caller-supplied lifecycle conclusions', async()=>{
    const read = createProjectObservationReader();
    let code = null;
    try {
      await read({
        project_ref:'github:laurajoyhutchins/overcenter',
        repository:'laurajoyhutchins/overcenter',
        revision:REVISION,
        facts:facts(),
        nodes:[],
        observations:[{ kind:'done' }],
      });
    } catch (error) { code = error?.code || null; }
    assert(code === 'PROJECT_OBSERVATIONS_INPUT_INVALID', 'caller-supplied observations were accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
