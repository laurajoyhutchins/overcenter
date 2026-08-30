import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

async function loadGitHubProjectGraphRuntimeFactory() {
  const module = await import('./project-graph-github-runtime.js');
  return module.createGitHubProjectGraphRuntime;
}

export function projectInspectForGitHub(options = {}) {
  const db = options.db;
  const loadRuntimeFactory = options.loadGitHubProjectGraphRuntimeFactory || loadGitHubProjectGraphRuntimeFactory;
  return Object.freeze({
    async inspect(input) {
      const createGitHubProjectGraphRuntime = await loadRuntimeFactory();
      const graphRuntime = createGitHubProjectGraphRuntime({ db });
      const inspect = projectInspectFor({ readProjectGraph:createAuthoritativeProjectGraphReader(graphRuntime) });
      return inspect.inspect(input);
    },
  });
}