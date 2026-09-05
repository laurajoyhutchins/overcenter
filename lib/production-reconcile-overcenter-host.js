import { reconcileProduction } from './production-reconcile-operation.js';

const SHA40 = /^[0-9a-f]{40}$/;
const VERIFICATION_WORKFLOW = 'exact-revision-v8.yml';
const MATERIALIZATION_WORKFLOW = 'production-materialization.yml';

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
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
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
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
      query:{ branch, per_page:100 },
    }), withApp);
    return bodyOf(response);
  }

  async function verifyDevelopmentRevision(repo, revision, roles) {
    const body = await listWorkflowRuns(repo, VERIFICATION_WORKFLOW, roles.development);
    const run = exactRuns(body, revision).find(candidate => String(candidate?.event || '') === 'push'
      && String(candidate?.status || '') === 'completed'
      && String(candidate?.conclusion || '') === 'success');
    if (!run) return { revision, verified:false, verification_ref:null };
    return { revision, verified:true, verification_ref:`github-actions-run:${run.id}` };
  }

  async function observeRuntime(_repo, _revision, _roles) {
    return { revision:null, verified:false, verification_ref:null, deployment_version:null };
  }

  async function dispatchMaterialization(repo, revision, roles) {
    const { repo:value } = repositoryParts(repo);
    const [owner, name] = value.split('/');
    try {
      const response = await github(value, 'production_materialization_dispatch', client => client.call('github', {
        path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(MATERIALIZATION_WORKFLOW)}/dispatches`,
        method:'POST',
        body:{ ref:roles.production, inputs:{ exact_revision:revision } },
      }), withApp);
      const body = bodyOf(response);
      const runId = Number(body?.workflow_run?.id || body?.id || 0);
      return { state:'queued', revision, run_ref:runId > 0 ? `github-actions-run:${runId}` : null, mutation_attempted:true };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.code = error.code || 'PRODUCTION_RECONCILIATION_MATERIALIZATION_DISPATCH_INDETERMINATE';
        error.may_have_mutated = true;
        error.mayHaveMutated = true;
      }
      throw error;
    }
  }

  async function reconcileRuntime(repo, revision, roles) {
    const body = await listWorkflowRuns(repo, MATERIALIZATION_WORKFLOW, roles.production);
    const runs = exactRuns(body, revision);
    const active = runs.find(run => ['queued','in_progress'].includes(statusState(run)));
    if (active) return { state:statusState(active), revision, run_ref:`github-actions-run:${active.id}`, mutation_attempted:false };
    return dispatchMaterialization(repo, revision, roles);
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