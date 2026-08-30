import { db as hatchableDb } from 'hatchable';
import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { createProjectAuthoringWorkerBinding } from 'lib/project-authoring-host-runtime.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from 'lib/repository-disposition.js';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from 'lib/overcenter-project-graph-deriver.js';

export const access = 'admin';
export const methods = ['POST'];

function safeInputShape(input) {
  if (Array.isArray(input)) return { input_type: 'array' };
  if (!input || typeof input !== 'object') return { input_type: input === null ? 'null' : typeof input };
  const shape = {};
  for (const key of Object.keys(input).sort().slice(0, 20)) {
    const value = input[key];
    shape[key] = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  }
  return shape;
}

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

export default async function (req, res) {
  const command = typeof req.body?.command === 'string' ? req.body.command : '';
  const input = req.body?.input;
  if (!command) {
    const response = commandFailure('work.claim', {
      code: 'REQUEST_INVALID',
      message: 'command is required',
      details: { field: 'command' },
    }, { flattenDetails: true, http_status: 400 });
    return res.status(response.status).json(response.body);
  }
  const runtime = { db:hatchableDb };
  runtime.projectAuthoring = projectAuthoringFor(runtime);
  const response = await executeSemanticWorkerCommand(command, input, runtime);
  if (response.status >= 400) {
    console.warn(JSON.stringify({
      event: 'worker_command_rejected',
      command,
      error: response.body?.error || null,
      field: response.body?.field || response.body?.details?.field || null,
      input_shape: safeInputShape(input),
    }));
  }
  return res.status(response.status).json(response.body);
}