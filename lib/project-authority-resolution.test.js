import { normalizeProjectAuthorityResolutionContract } from './project-authority-resolution.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

export async function runProjectAuthorityResolutionTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('default-branch authority contract normalizes deterministic repository binding', async()=>{
    const result = normalizeProjectAuthorityResolutionContract({
      project_ref:'project:busbar',
      repository:'laurajoyhutchins/busbar',
      revision_policy:'default_branch_head',
      derivation:'busbar-project-graph-v1',
    });
    assert(result.schema === 'project-authority-resolution-v1', 'schema mismatch');
    assert(result.project_ref === 'project:busbar', 'project_ref mismatch');
    assert(result.repository === 'laurajoyhutchins/busbar', 'repository mismatch');
    assert(result.revision_policy === 'default_branch_head', 'revision policy mismatch');
    assert(result.derivation === 'busbar-project-graph-v1', 'derivation mismatch');
    assert(!Object.prototype.hasOwnProperty.call(result, 'pull_request'), 'default-branch contract retained pull request state');
  });

  await test('pull-request authority contract requires exact PR coordinate', async()=>{
    const result = normalizeProjectAuthorityResolutionContract({
      project_ref:'project:busbar-pr41',
      repository:'laurajoyhutchins/busbar',
      revision_policy:'pull_request_head',
      pull_request:41,
      derivation:'busbar-project-graph-v1',
    });
    assert(result.pull_request === 41, 'pull request coordinate was not preserved');
  });

  await test('contract rejects ambiguous or non-GitHub repository coordinates', async()=>{
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'busbar', revision_policy:'default_branch_head', derivation:'d' }), 'ownerless repository accepted');
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'https://github.com/laurajoyhutchins/busbar', revision_policy:'default_branch_head', derivation:'d' }), 'URL repository accepted');
  });

  await test('contract rejects unsupported revision policy', async()=>{
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/busbar', revision_policy:'latest', derivation:'d' }), 'unsupported revision policy accepted');
  });

  await test('pull-request coordinate is required only for pull-request policy', async()=>{
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/busbar', revision_policy:'pull_request_head', derivation:'d' }), 'missing pull request accepted');
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/busbar', revision_policy:'default_branch_head', pull_request:41, derivation:'d' }), 'extraneous pull request accepted');
  });

  await test('contract rejects empty semantic identities', async()=>{
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'', repository:'laurajoyhutchins/busbar', revision_policy:'default_branch_head', derivation:'d' }), 'empty project_ref accepted');
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/busbar', revision_policy:'default_branch_head', derivation:'' }), 'empty derivation accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
