import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProduction } from '../lib/production-reconcile-operation.js';

const DEV = 'a'.repeat(40);
const PROD = 'b'.repeat(40);

function runtime(revision, version = 506) {
  return { revision, verified:true, verification_ref:`immutable-runtime:prod:${version}:manifest`, deployment_version:version };
}

test('repo intent alone converges verified dev through promotion, authoritative reread, and exact runtime materialization', async () => {
  const calls = [];
  let production = PROD;
  let currentRuntime = runtime(PROD, 505);
  const result = await reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, {
    resolveBranchRoles: async () => ({ development:'dev', production:'main' }),
    readBranchHeads: async () => { calls.push(['heads', production]); return { development_revision:DEV, production_revision:production }; },
    verifyDevelopmentRevision: async (_repo, revision) => { calls.push(['verify', revision]); return { revision, verified:true, verification_ref:'github-actions-run:42' }; },
    observeRuntime: async (_repo, revision) => { calls.push(['runtime', revision, currentRuntime.revision]); return currentRuntime; },
    promote: async (intent) => { calls.push(['promote', Object.keys(intent).sort()]); production = DEV; return { ok:true, source_revision:DEV, production_revision:DEV, verification_ref:'github-actions-run:42' }; },
    reconcileRuntime: async (_repo, revision) => {
      calls.push(['reconcile-runtime', revision]);
      assert.equal(production, DEV, 'runtime reconciliation must follow authoritative production readback');
      currentRuntime = runtime(DEV, 507);
      return { state:'succeeded', revision:DEV, verification_ref:currentRuntime.verification_ref, deployment_version:507 };
    },
    verifyFinalState: async (_repo, revision) => { calls.push(['final', revision]); return { production_revision:production, runtime:currentRuntime }; },
  });

  assert.deepEqual(calls.find(([name]) => name === 'promote')[1], ['repo']);
  const promote = calls.findIndex(([name]) => name === 'promote');
  const reread = calls.findIndex(([name], index) => name === 'heads' && index > promote);
  const materialize = calls.findIndex(([name]) => name === 'reconcile-runtime');
  assert.ok(promote >= 0 && reread > promote && materialize > reread);
  assert.deepEqual(result, {
    ok:true,
    outcome:'converged',
    repo:'laurajoyhutchins/overcenter',
    development_revision:DEV,
    production_revision:DEV,
    runtime_revision:DEV,
    development_verification_ref:'github-actions-run:42',
    runtime_verification_ref:'immutable-runtime:prod:507:manifest',
    deployment_version:507,
  });
});