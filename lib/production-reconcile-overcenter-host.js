import { reconcileProduction } from './production-reconcile-operation.js';
import { dispatchGitHubWorkflowWithGitHubApp } from './github-workflow-dispatch.js';

const SHA40 = /^[0-9a-f]{40}$/;
const VERIFICATION_WORKFLOW = 'exact-revision-v8.yml';
const MATERIALIZATION_WORKFLOW = 'production-materialization.yml';
const GITHUB_READ_HEADERS = Object.freeze({
  Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2026-03-10',
  'User-Agent':'Overcenter/1.0',
});

function fail(code, message, details = null, mayHaveMutated = false) {
  throw Object.assign(new Error(message), { code, details, may_have_mutated:mayHaveMutated, mayHaveMutated });
}

function repositoryParts(repo) {
  const value = typeof repo === 'string' ? repo.trim() : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) fail('PRODUCTION_RECONCILIATION_REQUEST_INVALID', 'repo must be owner/repository');
  return { repo:value, [Symbol.iterator]:function* () { yield* value.split('/'); } };
}

function bodyOf(response) {
  return response?.body && typeof response.body === 'object' ? response.body : response;
}

function exactSha(value, field) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) fail('PRODUCTION_RECONCILIATION_GITHUB_EVIDENCE_INVALID', `${field} is not an exact Git revision`);
  return revision;
}

function statusState(run) {
  const status = String(run?.status || '').toLowerCase();
  if (status === 'queued' || status === 'waiting' || status === 'requested') return 'queued';
  if (status === 'in_progress' || status === 'pending') return 'in_progress';
  return status;
}

function exactRuns(body, revision) {
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return runs
    .filter(run => typeof run?.head_sha === 'string' && run.head_sha.toLowerCase() === revision)
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
}

async function github(repo, capability, callback, withApp) {
  const clientFactory = withApp || (await import('./github-app-auth.js')).withGitHubAppApiClient;
  return clientFactory(repo, callback, { permissionProfile:capability });
}

export function productionReconciliationFor(options = {}) {
  if (options.ports) {
    return { reconcile:(input) => reconcileProduction(input, options.ports) };
  }
  const db = options.db;
  if (!db || typeof db.query !== 'function') fail('PRODUCTION_RECONCILIATION_RUNTIME_UNAVAILABLE', 'database binding is required');
  const withApp = options.withGitHubAppApiClient || null;
  const promotion = options.productionPromotion || null;
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const pollAttempts = Number.isSafeInteger(options.pollAttempts) && options.pollAttempts > 0 ? options.pollAttempts : 32;
  const pollDelayMs = Number.isSafeInteger(options.pollDelayMs) && options.pollDelayMs >= 0 ? options.pollDelayMs : 750;
  let trackedRuntimeRunId = null;

  async function withRuntimeGitHubApp(repo, callback, clientOptions) {
    if (withApp) return withApp(repo, callback, clientOptions);
    const { withGitHubAppApiClient } = await import('./github-app-auth.js');
    return withGitHubAppApiClient(repo, callback, clientOptions);
  }

  async function resolveBranchRoles(repo) {
    const result = await db.query(
      'SELECT development_branch, production_branch FROM portfolio_repository_branch_roles WHERE repository = $1 LIMIT 1',
      [repo],
    );
    const row = result?.rows?.[0];
    const development = typeof row?.development_branch === 'string' ? row.development_branch.trim() : '';
    const production = typeof row?.production_branch === 'string' ? row.production_branch.trim() : '';
    if (!development || !production || development === production) fail('PRODUCTION_RECONCILIATION_BRANCH_ROLES_INVALID', 'repository branch roles are unavailable or invalid');
    return { development, production };
  }

  async function readRef(repo, branch) {
    const { repo:value } = repositoryParts(repo);
    const [owner, name] = value.split('/');
    const response = await github(value, 'project_facts', client => client.call('github', {
      method:'GET',
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
      headers:GITHUB_READ_HEADERS,
    }), withApp);
    return exactSha(bodyOf(response)?.object?.sha, `refs/heads/${branch}`);
  }

  async function readBranchHeads(repo, roles) {
    const [development_revision, production_revision] = await Promise.all([
      readRef(repo, roles.development),
      readRef(repo, roles.production),
    ]);
    return { development_revision, production_revision };
  }

  async function listWorkflowRuns(repo, workflow, branch) {
    const { repo:value } = repositoryParts(repo);
    const [owner, name] = value.split('/');
    const response = await github(value, 'actions_storage_read', client => client.call('github', {
      method:'GET',
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
      query:{ branch, per_page:100 },
      headers:GITHUB_READ_HEADERS,
    }), withApp);
    return bodyOf(response);
  }

  async function readWorkflowRun(repo, runId) {
    const { repo:value } = repositoryParts(repo);
    const [owner, name] = value.split('/');
    const response = await github(value, 'actions_storage_read', client => client.call('github', {
      method:'GET',
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`,
      headers:GITHUB_READ_HEADERS,
    }), withApp);
    return bodyOf(response);
  }

  async function readWorkflowRunJobs(repo, runId) {
    const { repo:value } = repositoryParts(repo);
    const [owner, name] = value.split('/');
    const response = await github(value, 'actions_storage_read', client => client.call('github', {
      method:'GET',
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}/jobs`,
      headers:GITHUB_READ_HEADERS,
    }), withApp);
    return bodyOf(response);
  }

  async function materializationMutationAttempted(repo, runId) {
    const body = await readWorkflowRunJobs(repo, runId);
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    const job = jobs.find(candidate => String(candidate?.name || '').trim() === 'materialize');
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const step = steps.find(candidate => String(candidate?.name || '').trim() === 'Materialize exact production revision');
    const conclusion = String(step?.conclusion || '').trim().toLowerCase();
    if (conclusion === 'skipped') return false;
    if (conclusion === 'success') return true;
    fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'successful materialization workflow lacks an exact materialization-step outcome');
  }

  async function verifyDevelopmentRevision(repo, revision, roles) {
    const body = await listWorkflowRuns(repo, VERIFICATION_WORKFLOW, roles.development);
    const run = exactRuns(body, revision).find(candidate => String(candidate?.event || '') === 'push'
      && String(candidate?.status || '') === 'completed'
      && String(candidate?.conclusion || '') === 'success');
    if (!run) return { revision, verified:false, verification_ref:null };
    return { revision, verified:true, verification_ref:`github-actions-run:${run.id}` };
  }

  async function observeRuntime(repo, revision, roles) {
    if (!Number.isSafeInteger(trackedRuntimeRunId) || trackedRuntimeRunId < 1) {
      return { revision:null, verified:false, verification_ref:null, deployment_version:null };
    }
    const run = await readWorkflowRun(repo, trackedRuntimeRunId);
    validateTrackedRun(run, trackedRuntimeRunId, revision, roles);
    if (String(run?.status || '') !== 'completed' || String(run?.conclusion || '') !== 'success') {
      return { revision:null, verified:false, verification_ref:null, deployment_version:null };
    }
    return {
      revision,
      verified:true,
      verification_ref:`github-actions-run:${trackedRuntimeRunId}`,
      deployment_version:null,
    };
  }

  function validateTrackedRun(run, runId, revision, roles) {
    if (Number(run?.id) !== runId) {
      fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'GitHub returned a different workflow run than the tracked observation');
    }
    const observedRevision = exactSha(run?.head_sha, 'materialization_run.head_sha');
    if (observedRevision !== revision) {
      fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'tracked workflow run is not bound to the selected production revision');
    }
    const branch = typeof run?.head_branch === 'string' ? run.head_branch.trim() : '';
    if (branch && branch !== roles.production) {
      fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'tracked workflow run is not bound to the declared production branch');
    }
    const event = String(run?.event || '').trim();
    if (!['push','workflow_dispatch'].includes(event)) {
      fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'tracked workflow run has an unsupported trigger');
    }
  }

  async function pollTrackedRun(repo, runId, revision, roles, mutationAttempted) {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const run = await readWorkflowRun(repo, runId);
      validateTrackedRun(run, runId, revision, roles);
      const state = statusState(run);
      if (state === 'completed') {
        if (String(run?.conclusion || '') !== 'success') {
          return { state:'failed', revision, run_ref:`github-actions-run:${runId}`, mutation_attempted:mutationAttempted };
        }
        const materializationMutation = await materializationMutationAttempted(repo, runId);
        trackedRuntimeRunId = runId;
        return {
          state:'succeeded',
          revision,
          verification_ref:`github-actions-run:${runId}`,
          deployment_version:null,
          run_ref:`github-actions-run:${runId}`,
          mutation_attempted:materializationMutation,
        };
      }
      if (!['queued','in_progress'].includes(state)) {
        fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', `tracked workflow run has unsupported state ${state || 'unknown'}`);
      }
      if (attempt + 1 < pollAttempts) await sleep(pollDelayMs);
    }
    return { state:'pending', revision, run_ref:`github-actions-run:${runId}`, mutation_attempted:mutationAttempted };
  }

  async function dispatchObservation(repo, revision, roles) {
    const { repo:value } = repositoryParts(repo);
    try {
      const dispatch = await dispatchGitHubWorkflowWithGitHubApp({
        repo:value,
        workflow:MATERIALIZATION_WORKFLOW,
        ref:roles.production,
        expected_head:revision,
        inputs:{ exact_revision:revision },
      }, {
        withGitHubAppApiClient:withRuntimeGitHubApp,
        sleep,
      });
      const runId = Number(dispatch?.workflow_run_id || 0);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        fail(
          'PRODUCTION_RECONCILIATION_MATERIALIZATION_DISPATCH_INDETERMINATE',
          'GitHub dispatch identity confirmation returned no trackable workflow run id',
          null,
          true,
        );
      }
      return pollTrackedRun(value, runId, revision, roles, true);
    } catch (error) {
      if (error && typeof error === 'object') {
        error.code = error.code || 'PRODUCTION_RECONCILIATION_MATERIALIZATION_DISPATCH_INDETERMINATE';
        error.may_have_mutated = error.may_have_mutated !== false;
        error.mayHaveMutated = error.may_have_mutated;
      }
      throw error;
    }
  }

  async function reconcileRuntime(repo, revision, roles) {
    const body = await listWorkflowRuns(repo, MATERIALIZATION_WORKFLOW, roles.production);
    const runs = exactRuns(body, revision);
    const active = runs.find(run => ['queued','in_progress'].includes(statusState(run)));
    if (active) {
      const runId = Number(active?.id);
      if (!Number.isSafeInteger(runId) || runId < 1) {
        fail('PRODUCTION_RECONCILIATION_MATERIALIZATION_RUN_MISMATCH', 'active materialization run has no stable identity');
      }
      return pollTrackedRun(repo, runId, revision, roles, true);
    }
    return dispatchObservation(repo, revision, roles);
  }

  async function verifyFinalState(repo, revision, roles) {
    const heads = await readBranchHeads(repo, roles);
    return {
      development_revision:heads.development_revision,
      production_revision:heads.production_revision,
      runtime:await observeRuntime(repo, revision, roles),
    };
  }

  const ports = {
    resolveBranchRoles,
    readBranchHeads,
    verifyDevelopmentRevision,
    observeRuntime,
    promote:async (input) => {
      if (promotion) return promotion.promote(input);
      const { productionPromotionFor } = await import('./production-promotion-overcenter-host.js');
      return productionPromotionFor({ db }).promote(input);
    },
    reconcileRuntime,
    verifyFinalState,
  };
  return { reconcile:(input) => reconcileProduction(input, ports) };
}