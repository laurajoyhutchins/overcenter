import type {
  ProjectAdvanceIntent,
  ProjectAdvanceResult,
} from '../semantic/project-advance-operation';

export type ProjectAdvanceMcpRuntime = Readonly<{
  advanceProject(intent: ProjectAdvanceIntent): Promise<ProjectAdvanceResult>;
}>;

export function createProjectAdvanceMcpBinding(
  runtime: ProjectAdvanceMcpRuntime,
): (intent: ProjectAdvanceIntent) => Promise<ProjectAdvanceResult> {
  return (intent) => runtime.advanceProject(intent);
}