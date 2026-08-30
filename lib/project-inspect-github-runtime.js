import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime as createDefaultGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

export function projectInspectForGitHub(options = {}) {
  const db = options.db;
  const createGitHubProjectGraphRuntime = options.createGitHubProjectGraphRuntime || createDefaultGitHubProjectGraphRuntime;
  return Object.freeze({
    async inspect(input) {
      const graphRuntime = createGitHubProjectGraphRuntime({ db });
      const inspect = projectInspectFor({ readProjectGraph:createAuthoritativeProjectGraphReader(graphRuntime) });
      return inspect.inspect(input);
    },
  });
}