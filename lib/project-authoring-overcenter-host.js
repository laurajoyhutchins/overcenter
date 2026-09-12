// Database provider is injected by the runtime composition root.
import { createProjectAuthoringWorkerBinding } from './project-authoring-host-runtime.js';
import { createProjectAuthoringExecutionRuntime } from './project-authoring-execution-runtime.js';
import { executeProjectAuthoring } from './project-authoring-execution.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from './repository-disposition.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { createGithubIntegrationApiAdapter } from './github-integration.js';
import {
  applyGithubChangesetRoleAware,
  createGithubPullRequestRoleAware,
  reconcileGithubIntegrationRoleAware,
} from './github-branch-role-runtime.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from './overcenter-project-graph-deriver.js';

function unsupportedDerivation(input) {
  const error = new Error('project authoring derivation is not registered by the worker host');
  error.code = 'PROJECT_GRAPH_DERIVER_UNAVAILABLE';
  error.details = { derivation:input?.authority?.derivation || null };
  return error;
}

async function observeIntegratedCandidate(request, pull, options) {
  return reconcileGithubIntegrationRoleAware({
    repo:request.repository,
    pull_request:pull.pull_request,
    expected_head:request.expected_head,
    apply:false,
  }, options);
}

async function mergeProjectAuthoringCandidate(request, pull, options) {
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (typeof withGitHubAppApiClient !== 'function') throw Object.assign(new Error('GitHub auth provider is unavailable'), { code:'RUNTIME_PROVIDER_MISSING', details:{ provider:'githubAppAuth' } });
  let merge;
  try {
    merge = await withGitHubAppApiClient(request.repository, async (apiClient) => {
      const integrationApi = createGithubIntegrationApiAdapter(apiClient);
      return integrationApi.mergeDirect({
        repo:request.repository,
        pull_request:pull.pull_request,
        expected_head:request.expected_head,
        merge_method:'squash',
      });
    }, { permissionProfile:'integration_merge' });
  } catch (error) {
    const observed = await observeIntegratedCandidate(request, pull, options);
    if (observed?.ok && ['merged','already_merged'].includes(String(observed?.outcome || ''))) return observed;
    throw error;
  }

  if (merge?.ok && String(merge?.status || '').toLowerCase() === 'merged') {
    return { ok:true, outcome:'merged', repo:request.repository, pull_request:pull.pull_request, expected_head:request.expected_head, merge_commit_sha:merge.sha || null, integration_transport:'direct_exact_head', message:merge.message || null };
  }

  if (merge?.may_have_mutated === true || merge?.error === 'GITHUB_INTEGRATION_INDETERMINATE') {
    const observed = await observeIntegratedCandidate(request, pull, options);
    if (observed?.ok && ['merged','already_merged'].includes(String(observed?.outcome || ''))) return observed;
  }
  return merge;
}

async function integrateGithubChangeset(request, runtime) {
  const options = { db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient };
  const pull = await createGithubPullRequestRoleAware({ repo:request.repository, base:request.base, head:request.head, expected_base:request.expected_base, expected_head:request.expected_head, title:`project: ${request.operation} ${request.project_ref}`, body:'Overcenter project authoring transaction. The candidate was staged and read back at the exact head before this integration request.', draft:false }, options);
  if (!pull?.ok) return pull;
  const inspect = await observeIntegratedCandidate(request, pull, options);
  if (!inspect?.ok || ['merged','already_merged'].includes(String(inspect?.outcome || ''))) return inspect;
  if (inspect.outcome !== 'ready') return inspect;
  return mergeProjectAuthoringCandidate(request, pull, options);
}

const legacyProjectAuthoringFor = createProjectAuthoringWorkerBinding({
  createGraphRuntime(runtime) { return createGitHubProjectGraphRuntime({ db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient }); },
  async readRepositoryDisposition(repository, runtime) {
    const store = createPostgresRepositoryDispositionStore(runtime.db);
    const row = await store.get(repository);
    if (!row) return null;
    return { repository:String(row.repository || '').trim(), disposition:String(row.disposition || '').trim().toUpperCase() };
  },
  applyGithubChangeset(request, writerOptions, runtime) { return applyGithubChangesetRoleAware(request, { ...writerOptions, db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient, executionTransactionStore:runtime.executionTransactionStore, kernelManaged:true }); },
  integrateGithubChangeset,
  deriveProjectGraph(input) {
    if (input?.authority?.derivation !== OVERCENTER_PROJECT_GRAPH_DERIVATION) throw unsupportedDerivation(input);
    return deriveOvercenterProjectGraph(input);
  },
});

export function projectAuthoringFor(runtime = {}) {
  const legacy = legacyProjectAuthoringFor(runtime);
  const graphRuntime = createGitHubProjectGraphRuntime({
    db:runtime.db,
    withGitHubAppApiClient:runtime.withGitHubAppApiClient || runtime.githubAppAuth?.withApiClient,
  });
  return createProjectAuthoringExecutionRuntime({
    ...runtime,
    graphRuntime,
    primitive:legacy,
    executeProjectAuthoring,
  });
}