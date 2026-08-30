import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

export function projectInspectForGitHub(options = {}) {
  const graphRuntime = createGitHubProjectGraphRuntime({ db:options.db });
  return projectInspectFor({ readProjectGraph:createAuthoritativeProjectGraphReader(graphRuntime) });
}