import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductionRuntimeObservationHttpCli } from './production-runtime-observation-http.mjs';
const SHA = 'a'.repeat(40);
function env() { return { GITHUB_REPOSITORY:'laurajoyhutchins/overcenter', PRODUCTION_BRANCH:'main', EXACT_REVISION:SHA, OVERCENTER_HATCHABLE_PRODUCTION_PROJECT:'proj_test', HATCHABLE_TOKEN:'secret' }; }
test('fresh runtime observer binds current immutable Hatchable evidence to the exact production revision', async () => {
  let closed = false;
  const result = await runProductionRuntimeObservationHttpCli(env(), { connectHatchableRemoteMcp:async () => ({ callTool:async () => {}, close:async () => { closed = true; } }), createProductionRuntimeAdapter:() => ({ inspect:async (project, context) => { assert.equal(project, 'proj_test'); assert.deepEqual(context, { repository:'laurajoyhutchins/overcenter', branch:'main' }); return { version:506, verified_revision:SHA, verification_ref:'immutable-runtime:proj_test:506:manifest' }; } }), write:() => {} });
  assert.deepEqual(result, { ok:true, schema:'production-runtime-observation-v1', repository:'laurajoyhutchins/overcenter', branch:'main', revision:SHA, runtime_ref:'proj_test', deployment_version:506, verification_ref:'immutable-runtime:proj_test:506:manifest' }); assert.equal(closed, true);
});
test('fresh runtime observer rejects current Hatchable evidence for a different revision', async () => { await assert.rejects(runProductionRuntimeObservationHttpCli(env(), { connectHatchableRemoteMcp:async () => ({ callTool:async () => {}, close:async () => {} }), createProductionRuntimeAdapter:() => ({ inspect:async () => ({ version:506, verified_revision:'b'.repeat(40), verification_ref:'immutable-runtime:other' }) }), write:() => {} }), error => error?.code === 'PRODUCTION_RUNTIME_OBSERVATION_MISMATCH'); });