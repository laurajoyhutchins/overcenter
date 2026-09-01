import { advanceProject } from '../src/semantic/project-advance-operation';
import { createProjectAdvancePorts } from '../src/adapters/project-advance/runtime-adapter';
import type { ProjectAdvanceRuntimeHost } from '../src/ports/project-advance-runtime-host';

const host: ProjectAdvanceRuntimeHost = {
  startOrResumeProjectRun: async (projectRef) => ({
    run_id: `run:${projectRef}`,
  }),
  advanceRun: async (runId) => ({
    run_id: runId,
    outcome: 'AGENT_EXECUTION_REQUIRED',
  }),
};

const result = await advanceProject(
  { project_ref: 'github:laurajoyhutchins/overcenter' },
  createProjectAdvancePorts(host),
);

const runId: string = result.run_id;
void runId;