import {
  createProjectAdvanceMcpBinding,
  type ProjectAdvanceMcpRuntime,
} from '../src/runtime/project-advance-mcp-binding';

const runtime: ProjectAdvanceMcpRuntime = {
  async advanceProject(intent) {
    return {
      run_id: `run:${intent.project_ref}`,
      outcome: 'AGENT_EXECUTION_REQUIRED',
    };
  },
};

const advance = createProjectAdvanceMcpBinding(runtime);
const result = advance({ project_ref: 'github:laurajoyhutchins/overcenter' });
const resultPromise: Promise<{ readonly run_id: string; readonly outcome: string }> = result;
void resultPromise;

// @ts-expect-error primary project advancement must not accept orchestration choreography
advance({ project_ref: 'github:laurajoyhutchins/overcenter', run_id: 'caller-supplied' });