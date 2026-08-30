import type {
  ProjectAdvancePorts,
  ProjectAdvanceResult,
  ProjectAdvanceRun,
} from '../semantic/project-advance-operation';

export type ProjectAdvanceRuntimeHost = Readonly<{
  startOrResumeProjectRun(projectRef: string): Promise<ProjectAdvanceRun>;
  advanceRun(runId: string): Promise<ProjectAdvanceResult>;
}>;

export function createProjectAdvancePorts(
  host: ProjectAdvanceRuntimeHost,
): ProjectAdvancePorts {
  return Object.freeze({
    startOrResumeProjectRun: (projectRef) => host.startOrResumeProjectRun(projectRef),
    advanceRun: (runId) => host.advanceRun(runId),
  });
}