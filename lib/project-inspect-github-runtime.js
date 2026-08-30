import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

function invalid(message) {
  const error = new Error(message);
  error.code = 'PROJECT_INSPECT_RUNTIME_INVALID';
  throw error;
}

export function projectInspectForGitHub(options = {}) {
  const db = options.db;
  const createGitHubProjectGraphRuntime = options.createGitHubProjectGraphRuntime;
  if (typeof createGitHubProjectGraphRuntime !== 'function') {
    invalid('project.inspect GitHub runtime factory is unavailable');
  }
  return Object.freeze({
    async inspect(input) {
      const graphRuntime = createGitHubProjectGraphRuntime({ db });
      const inspect = projectInspectFor({ readProjectGraph:createAuthoritativeProjectGraphReader(graphRuntime) });
      return inspect.inspect(input);
    },
  });
}