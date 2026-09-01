import type {
  ProjectAdvanceResult,
  ProjectAdvanceRun,
} from '../semantic/project-advance-operation.js';

export type ProjectAdvanceRuntimeHost = Readonly<{
  startOrResumeProjectRun(projectRef: string): Promise<ProjectAdvanceRun>;
  advanceRun(runId: string): Promise<ProjectAdvanceResult>;
}>;