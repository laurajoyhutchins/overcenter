import test from 'node:test';
import assert from 'node:assert/strict';
import { observeProductionRuntimeViaWorkflow } from './production-reconcile-overcenter-host.js';
import { dispatchGitHubWorkflowWithGitHubApp } from './github-workflow-dispatch.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_ID = 4242;

function response(status, body = null) { return { status, body }; }

test('canonical workflow dispatch recovers exact run identity after GitHub returns 204 with no body', async () => {
  const calls = [];
  const withGitHubAppApiClient = async (_repo, callback) => callback({
    async call(_provider, request) {
      calls.push(request);
      if (request.method === 'POST') return response(204);
      if (request.path.endsWith('/git/ref/heads/main')) return response(200, { object:{ sha:SHA } });
      if (request.path.endsWith('/runs')) return response(200, { workflow_runs:[{ id:RUN_ID, head_sha:SHA, event:'workflow_dispatch', created_at:new Date().toISOString(), status:'queued', conclusion:null }] });
      throw new Error(`unexpected request ${request.method || 'GET'} ${request.path}`);
    },
  });
  const result = await dispatchGitHubWorkflowWithGitHubApp({ repo:'acme/widgets', workflow:'production-runtime-observation.yml', ref:'main', expected_head:SHA, inputs:{ exact_revision:SHA } }, { withGitHubAppApiClient, sleep:async()=>{} });
  assert.equal(result.workflow_run_id, RUN_ID);
  assert.equal(result.mutation_certainty, 'confirmed');
  assert.equal(calls.some(call => call.method === 'POST'), true);
});

test('fresh runtime observation proves an already-current immutable deployment without process-local history', async () => {
  const result = await observeProductionRuntimeViaWorkflow({ repo:'acme/widgets', revision:SHA, roles:{ production:'main' } }, {
    dispatchWorkflow: async () => ({ workflow_run_id:RUN_ID, workflow_run_head_sha:SHA, mutation_certainty:'confirmed' }),
    readWorkflowRun: async () => ({ id:RUN_ID, head_sha:SHA, head_branch:'main', event:'workflow_dispatch', status:'completed', conclusion:'success' }),
    readWorkflowJobs: async () => ({ jobs:[{ steps:[{ name:'Confirm current runtime', conclusion:'success' }, { name:'Confirm stale runtime', conclusion:'skipped' }] }] }),
    sleep: async () => {},
  });
  assert.deepEqual(result, { revision:SHA, verified:true, verification_ref:`github-actions-run:${RUN_ID}`, deployment_version:null });
});

test('fresh runtime observation reports stale without converting observation into production mutation', async () => {
  const result = await observeProductionRuntimeViaWorkflow({ repo:'acme/widgets', revision:SHA, roles:{ production:'main' } }, {
    dispatchWorkflow: async () => ({ workflow_run_id:RUN_ID, workflow_run_head_sha:SHA, mutation_certainty:'confirmed' }),
    readWorkflowRun: async () => ({ id:RUN_ID, head_sha:SHA, head_branch:'main', event:'workflow_dispatch', status:'completed', conclusion:'success' }),
    readWorkflowJobs: async () => ({ jobs:[{ steps:[{ name:'Confirm current runtime', conclusion:'skipped' }, { name:'Confirm stale runtime', conclusion:'success' }] }] }),
    sleep: async () => {},
  });
  assert.deepEqual(result, { revision:null, verified:false, verification_ref:null, deployment_version:null });
});

test('fresh runtime observation fails closed when workflow completion lacks an authoritative marker', async () => {
  await assert.rejects(
    observeProductionRuntimeViaWorkflow({ repo:'acme/widgets', revision:SHA, roles:{ production:'main' } }, {
      dispatchWorkflow: async () => ({ workflow_run_id:RUN_ID, workflow_run_head_sha:SHA, mutation_certainty:'confirmed' }),
      readWorkflowRun: async () => ({ id:RUN_ID, head_sha:SHA, head_branch:'main', event:'workflow_dispatch', status:'completed', conclusion:'success' }),
      readWorkflowJobs: async () => ({ jobs:[{ steps:[] }] }),
      sleep: async () => {},
    }),
    error => error?.code === 'PRODUCTION_RECONCILIATION_RUNTIME_OBSERVATION_INVALID' && error?.may_have_mutated === true,
  );
});