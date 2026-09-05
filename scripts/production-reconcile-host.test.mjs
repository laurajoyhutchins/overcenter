import test from 'node:test';
import assert from 'node:assert/strict';
import { productionReconciliationFor } from '../lib/production-reconcile-overcenter-host.js';

const SHA = 'a'.repeat(40);

test('Overcenter production reconciliation host exposes repo-only convergence while deriving mechanical ports internally', async () => {
  const calls = [];
  const service = productionReconciliationFor({
    ports: {
      resolveBranchRoles: async repo => { calls.push(['roles', repo]); return { development:'dev', production:'main' }; },
      readBranchHeads: async repo => { calls.push(['heads', repo]); return { development_revision:SHA, production_revision:SHA }; },
      verifyDevelopmentRevision: async (_repo, revision) => ({ revision, verified:true, verification_ref:'github-actions-run:1' }),
      observeRuntime: async (_repo, revision) => ({ revision, verified:true, verification_ref:'github-actions-run:2', deployment_version:null }),
      promote: async () => { throw new Error('already converged should not promote'); },
      reconcileRuntime: async () => { throw new Error('already converged should not dispatch materialization'); },
      verifyFinalState: async () => ({ development_revision:SHA, production_revision:SHA, runtime:{ revision:SHA, verified:true, verification_ref:'github-actions-run:2', deployment_version:null } }),
    },
  });
  const result = await service.reconcile({ repo:'laurajoyhutchins/overcenter' });
  assert.equal(result.outcome, 'already_converged');
  assert.equal(result.repo, 'laurajoyhutchins/overcenter');
  assert.deepEqual(calls[0], ['roles', 'laurajoyhutchins/overcenter']);
});