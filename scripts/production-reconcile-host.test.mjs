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

test('historical successful materialization cannot authorize current runtime convergence', async () => {
  const calls = [];
  let materializationLists = 0;
  const db = {
    query: async () => ({ rows:[{ development_branch:'dev', production_branch:'main' }] }),
  };
  const withGitHubAppApiClient = async (_repo, callback) => callback({
    call: async (_provider, request) => {
      calls.push(request);
      if (request.path.includes('/git/ref/heads/')) {
        return { body:{ object:{ sha:SHA } } };
      }
      if (request.path.includes('/actions/workflows/exact-revision-v8.yml/runs')) {
        return { body:{ workflow_runs:[{ id:1, head_sha:SHA, event:'push', status:'completed', conclusion:'success' }] } };
      }
      if (request.path.includes('/actions/workflows/production-materialization.yml/runs')) {
        materializationLists += 1;
        return { body:{ workflow_runs:[{ id:2, head_sha:SHA, event:'push', status:'completed', conclusion:'success' }] } };
      }
      if (request.path.includes('/actions/workflows/production-materialization.yml/dispatches')) {
        return { body:{ workflow_run_id:99 } };
      }
      if (request.path.endsWith('/actions/runs/99')) {
        return { body:{ id:99, head_sha:SHA, event:'workflow_dispatch', status:'queued', conclusion:null } };
      }
      throw new Error(`unexpected GitHub request ${request.path}`);
    },
  });
  const service = productionReconciliationFor({
    db,
    withGitHubAppApiClient,
    productionPromotion:{ promote:async () => { throw new Error('already-current Git must not promote'); } },
  });
  const result = await service.reconcile({ repo:'laurajoyhutchins/overcenter' });
  assert.equal(result.outcome, 'materialization_pending');
  assert.equal(result.materialization_run_ref, 'github-actions-run:99');
  assert.ok(materializationLists >= 1);
  const dispatch = calls.find(request => request.path.includes('/dispatches'));
  assert.ok(dispatch, 'a fresh exact runtime observation must be dispatched');
  assert.equal(dispatch.body.inputs.observe_only, true);
  assert.ok(calls.some(request => request.path.endsWith('/actions/runs/99')), 'only the exact dispatched run may be polled for freshness');
});

test('fresh exact observation run can authorize final same-revision convergence', async () => {
  const calls = [];
  const db = { query:async () => ({ rows:[{ development_branch:'dev', production_branch:'main' }] }) };
  const withGitHubAppApiClient = async (_repo, callback) => callback({
    call:async (_provider, request) => {
      calls.push(request);
      if (request.path.includes('/git/ref/heads/')) return { body:{ object:{ sha:SHA } } };
      if (request.path.includes('/actions/workflows/exact-revision-v8.yml/runs')) {
        return { body:{ workflow_runs:[{ id:1, head_sha:SHA, event:'push', status:'completed', conclusion:'success' }] } };
      }
      if (request.path.includes('/actions/workflows/production-materialization.yml/runs')) {
        return { body:{ workflow_runs:[{ id:2, head_sha:SHA, event:'push', status:'completed', conclusion:'success' }] } };
      }
      if (request.path.includes('/actions/workflows/production-materialization.yml/dispatches')) {
        return { body:{ workflow_run_id:101 } };
      }
      if (request.path.endsWith('/actions/runs/101')) {
        return { body:{ id:101, head_sha:SHA, event:'workflow_dispatch', status:'completed', conclusion:'success' } };
      }
      throw new Error(`unexpected GitHub request ${request.path}`);
    },
  });
  const service = productionReconciliationFor({
    db,
    withGitHubAppApiClient,
    productionPromotion:{ promote:async () => { throw new Error('already-current Git must not promote'); } },
    sleep:async () => {},
  });
  const result = await service.reconcile({ repo:'laurajoyhutchins/overcenter' });
  assert.equal(result.outcome, 'converged');
  assert.equal(result.runtime_revision, SHA);
  assert.equal(result.runtime_verification_ref, 'github-actions-run:101');
  assert.ok(calls.some(request => request.path.endsWith('/actions/runs/101')));
});