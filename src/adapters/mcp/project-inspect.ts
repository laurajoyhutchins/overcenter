import type {
  ProjectInspectIntent,
  ProjectInspection,
} from '../../semantic/project-inspect-operation.js';

export type ProjectInspectMcpRuntime = Readonly<{
  inspectProject(intent: ProjectInspectIntent): Promise<ProjectInspection>;
}>;

export function createProjectInspectMcpBinding(
  runtime: ProjectInspectMcpRuntime,
): (intent: ProjectInspectIntent) => Promise<ProjectInspection> {
  return (intent) => runtime.inspectProject(intent);
}