import { db } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationStatus } from 'lib/orchestration-status.js';
import { createAuthoritativeProjectGraphReader } from 'lib/project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { projectTransitionStatus, unavailableProjectTransitionStatus } from 'lib/project-transition-status.js';

export const access = 'admin';
export const methods = ['POST'];

const OVERCENTER_PROJECT_REF = 'github:laurajoyhutchins/overcenter';

async function statusWithProjectTransitions() {
  const status = await orchestrationStatus();
  try {
    const readProjectGraph = createAuthoritativeProjectGraphReader(createGitHubProjectGraphRuntime({ db }));
    const graph = await readProjectGraph({ project_ref:OVERCENTER_PROJECT_REF });
    return { ...status, ...projectTransitionStatus(graph) };
  } catch (error) {
    return { ...status, ...unavailableProjectTransitionStatus(error) };
  }
}

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'orchestration.status',
    req.body || {},
    () => statusWithProjectTransitions(),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}