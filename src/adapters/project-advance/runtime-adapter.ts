import type { ProjectAdvancePorts } from '../../semantic/project-advance-operation.js';
import type { ProjectAdvanceRuntimeHost } from '../../ports/project-advance-runtime-host.js';

export type { ProjectAdvanceRuntimeHost } from '../../ports/project-advance-runtime-host.js';

export function createProjectAdvancePorts(
  host: ProjectAdvanceRuntimeHost,
): ProjectAdvancePorts {
  return Object.freeze({
    startOrResumeProjectRun: (projectRef) => host.startOrResumeProjectRun(projectRef),
    advanceRun: (runId) => host.advanceRun(runId),
  });
}