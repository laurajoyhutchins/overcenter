import { db as hatchableDb } from 'hatchable';
import { createProjectAuthoringWorkerBinding } from './project-authoring-host-runtime.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from './repository-disposition.js';
import { applyGithubChangesetRoleAware } from './github-branch-role-runtime.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from './overcenter-project-graph-deriver.js';

function unsupportedDerivation(input) {
  const error = new Error('project authoring derivation is not registered by the worker host');
  error.code = 'PROJECT_GRAPH_DERIVER_UNAVAILABLE';
  error.details = { derivation:input?.authority?.derivation || null };
  return error;
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
  deriveProjectGraph(input) {
    if (input?.authority?.derivation !== OVERCENTER_PROJECT_GRAPH_DERIVATION) throw unsupportedDerivation(input);
    return deriveOvercenterProjectGraph(input);
  },
});