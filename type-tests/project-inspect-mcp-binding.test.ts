import {
  createProjectInspectMcpBinding,
  type ProjectInspectMcpRuntime,
} from '../src/runtime/project-inspect-mcp-binding';

const runtime: ProjectInspectMcpRuntime = {
  async inspectProject(intent) {
    return {
      project_ref: intent.project_ref,
      authority_revision: '577460a5e7653a8dd7baedf2116a8717401daa19',
      complete: false,
      frontier: ['compact-agent-semantic-surface'],
    };
  },
};

const inspect = createProjectInspectMcpBinding(runtime);
const result = inspect({ project_ref: 'github:laurajoyhutchins/overcenter' });
const resultPromise: Promise<{
  readonly project_ref: string;
  readonly authority_revision: string;
  readonly complete: boolean;
  readonly frontier: readonly string[];
}> = result;
void resultPromise;

// @ts-expect-error primary project inspection must not accept orchestration choreography
inspect({ project_ref: 'github:laurajoyhutchins/overcenter', run_id: 'caller-supplied' });