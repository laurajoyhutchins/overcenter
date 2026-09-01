import { db as hatchableDb } from 'hatchable';
import { createProjectAuthoringWorkerBinding } from './project-authoring-host-runtime.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from './repository-disposition.js';
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

async function integrateGithubChangeset(request, runtime) {
  const options = { db:runtime.db || hatchableDb };
  const pull = await createGithubPullRequestRoleAware({
    repo:request.repository,
    base:request.base,
    head:request.head,
    expected_base:request.expected_base,
    expected_head:request.expected_head,
    title:`project: ${request.operation} ${request.project_ref}`,
    body:'Overcenter project authoring transaction. The candidate was staged and read back at the exact head before this integration request.',
    draft:false,
  }, options);
  if (!pull?.ok) return pull;

  const inspect = await reconcileGithubIntegrationRoleAware({
    repo:request.repository,
    pull_request:pull.pull_request,
    expected_head:request.expected_head,
    apply:false,
  }, options);
  if (!inspect?.ok || ['merged','already_merged'].includes(String(inspect?.outcome || ''))) return inspect;
  if (inspect.outcome !== 'ready') return inspect;

  return reconcileGithubIntegrationRoleAware({
    repo:request.repository,
    pull_request:pull.pull_request,
    expected_head:request.expected_head,
    apply:true,
  }, options);
}

export const projectAuthoringFor = createProjectAuthoringWorkerBinding({
  createGraphRuntime(runtime) {
    return createGitHubProjectGraphRuntime({ db:runtime.db || hatchableDb });
  },
  async readRepositoryDisposition(repository, runtime) {
    const store = createPostgresRepositoryDispositionStore(runtime.db || hatchableDb);
    const row = await store.get(repository);
    if (!row) return null;
    return {
      repository:String(row.repository || '').trim(),
      disposition:String(row.disposition || '').trim().toUpperCase(),
    };
  },
  applyGithubChangeset(request, writerOptions, runtime) {
    return applyGithubChangesetRoleAware(request, { ...writerOptions, db:runtime.db || hatchableDb });
  },
  integrateGithubChangeset,
  deriveProjectGraph(input) {
    if (input?.authority?.derivation !== OVERCENTER_PROJECT_GRAPH_DERIVATION) throw unsupportedDerivation(input);
    return deriveOvercenterProjectGraph(input);
  },
});