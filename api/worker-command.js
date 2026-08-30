import { db as hatchableDb } from 'hatchable';
import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { createWorkerCommandHandler } from 'lib/worker-command-handler.js';
import { createProjectAuthoringWorkerBinding } from 'lib/project-authoring-host-runtime.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from 'lib/repository-disposition.js';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from 'lib/overcenter-project-graph-deriver.js';

export const access = 'admin';
export const methods = ['POST'];

function unsupportedDerivation(input) {
  const error = new Error('project authoring derivation is not registered by the worker host');
  error.code = 'PROJECT_GRAPH_DERIVER_UNAVAILABLE';
  error.details = { derivation:input?.authority?.derivation || null };
  return error;
}

const projectAuthoringFor = createProjectAuthoringWorkerBinding({
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

export default createWorkerCommandHandler({
  db:hatchableDb,
  commandFailure,
  projectAuthoringFor,
  executeSemanticWorkerCommand,
  logger:console,
});