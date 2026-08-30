import type {
  ProjectAdvanceIntent,
  ProjectAdvancePorts,
  ProjectAdvanceResult,
} from '../src/semantic/project-advance-operation';
import { advanceProject } from '../src/semantic/project-advance-operation';

const intent: ProjectAdvanceIntent = { project_ref: 'github:laurajoyhutchins/overcenter' };

const ports: ProjectAdvancePorts = {
  async startOrResumeProjectRun(projectRef) {
    const sameRef: string = projectRef;
    void sameRef;
    return { run_id: 'run-1' };
  },
  async advanceRun(runId) {
    const sameRun: string = runId;
    void sameRun;
    return { run_id: runId, outcome: 'agent_execution_required' };
  },
};

const result: Promise<ProjectAdvanceResult> = advanceProject(intent, ports);
void result;

// @ts-expect-error ordinary project advancement must not accept run choreography
advanceProject({ project_ref: intent.project_ref, run_id: 'caller-supplied' }, ports);