import { createProjectAuthorityResolver, normalizeProjectAuthorityResolutionContract, parseProjectAuthorityRef } from './project-authority-resolution.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

const REVISION = '1234567890abcdef1234567890abcdef12345678';

export async function runProjectAuthorityResolutionTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('default-branch authority contract normalizes deterministic repository binding', async()=>{
    const result = normalizeProjectAuthorityResolutionContract({ project_ref:'project:overcenter', repository:'laurajoyhutchins/overcenter', revision_policy:'default_branch_head', derivation:'overcenter-project-graph-v1' });
    assert(result.schema === 'project-authority-resolution-v1', 'schema mismatch');
    assert(result.repository === 'laurajoyhutchins/overcenter', 'repository mismatch');
    assert(!Object.prototype.hasOwnProperty.call(result, 'pull_request'), 'default-branch contract retained pull request state');
  });

  await test('pull-request authority contract requires exact PR coordinate', async()=>{
    const result = normalizeProjectAuthorityResolutionContract({ project_ref:'project:overcenter-pr57', repository:'laurajoyhutchins/overcenter', revision_policy:'pull_request_head', pull_request:57, derivation:'overcenter-project-graph-v1' });
    assert(result.pull_request === 57, 'pull request coordinate was not preserved');
  });

  await test('self-describing project ref resolves repository and revision policy without registry state', async()=>{
    const base = parseProjectAuthorityRef('github:laurajoyhutchins/overcenter');
    const pull = parseProjectAuthorityRef('github:laurajoyhutchins/overcenter#pull/57');
    assert(base.repository === 'laurajoyhutchins/overcenter' && base.revision_policy === 'default_branch_head', 'default project ref mismatch');
    assert(pull.pull_request === 57 && pull.revision_policy === 'pull_request_head', 'pull project ref mismatch');
    expectFailure(()=>parseProjectAuthorityRef('project:overcenter'), 'opaque project ref accepted without authority coordinates');
  });

  await test('production resolver binds default branch head to repository-owned derivation manifest', async()=>{
    const calls = [];
    const resolve = createProjectAuthorityResolver({
      readRepository:async (input)=>{ calls.push(['repo', input]); return { default_branch_head:REVISION }; },
      readPullRequest:async ()=>{ throw new Error('unexpected pull read'); },
      readDerivationManifest:async (input)=>{ calls.push(['manifest', input]); return { schema:'project-graph-derivation-v1', derivation:'overcenter-project-graph-v1' }; },
    });
    const result = await resolve({ project_ref:'github:laurajoyhutchins/overcenter' });
    assert(result.kind === 'github', 'authority kind mismatch');
    assert(result.revision === REVISION, 'exact revision mismatch');
    assert(result.derivation === 'overcenter-project-graph-v1', 'derivation mismatch');
    assert(calls[1][1].revision === REVISION, 'manifest was not read at exact revision');
  });

  await test('production resolver binds pull request head to repository-owned derivation manifest', async()=>{
    const resolve = createProjectAuthorityResolver({
      readRepository:async ()=>{ throw new Error('unexpected repository read'); },
      readPullRequest:async (input)=>({ head_sha:REVISION, number:input.pull_request }),
      readDerivationManifest:async ()=>'{"schema":"project-graph-derivation-v1","derivation":"overcenter-project-graph-v1"}',
    });
    const result = await resolve({ project_ref:'github:laurajoyhutchins/overcenter#pull/57' });
    assert(result.pull_request === 57, 'pull request identity missing');
    assert(result.revision === REVISION, 'pull request exact head mismatch');
  });

  await test('resolver fails closed on non-exact revision or malformed derivation manifest', async()=>{
    const badRevision = createProjectAuthorityResolver({
      readRepository:async ()=>({ default_branch_head:'main' }),
      readPullRequest:async ()=>null,
      readDerivationManifest:async ()=>({ schema:'project-graph-derivation-v1', derivation:'d' }),
    });
    let failedRevision = false;
    try { await badRevision({ project_ref:'github:laurajoyhutchins/overcenter' }); } catch (error) { failedRevision = error?.code === 'PROJECT_AUTHORITY_RESOLUTION_FAILED'; }
    assert(failedRevision, 'non-exact revision accepted');

    const badManifest = createProjectAuthorityResolver({
      readRepository:async ()=>({ default_branch_head:REVISION }),
      readPullRequest:async ()=>null,
      readDerivationManifest:async ()=>({ schema:'wrong', derivation:'d' }),
    });
    let failedManifest = false;
    try { await badManifest({ project_ref:'github:laurajoyhutchins/overcenter' }); } catch (error) { failedManifest = error?.code === 'PROJECT_AUTHORITY_RESOLUTION_FAILED'; }
    assert(failedManifest, 'malformed derivation manifest accepted');
  });

  await test('contract rejects ambiguous or unsupported coordinates', async()=>{
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'overcenter', revision_policy:'default_branch_head', derivation:'d' }), 'ownerless repository accepted');
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/overcenter', revision_policy:'latest', derivation:'d' }), 'unsupported revision policy accepted');
    expectFailure(()=>normalizeProjectAuthorityResolutionContract({ project_ref:'x', repository:'laurajoyhutchins/overcenter', revision_policy:'pull_request_head', derivation:'d' }), 'missing pull request accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
