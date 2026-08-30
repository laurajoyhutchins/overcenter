export type ProjectAdvanceIntent = Readonly<{
  project_ref: string;
}>;

export type ProjectAdvanceRun = Readonly<{
  run_id: string;
}>;

export type ProjectAdvanceResult = Readonly<{
  run_id: string;
  outcome: string;
}>;

export type ProjectAdvancePorts = Readonly<{
  startOrResumeProjectRun(projectRef: string): Promise<ProjectAdvanceRun>;
  advanceRun(runId: string): Promise<ProjectAdvanceResult>;
}>;

export async function advanceProject(
  intent: ProjectAdvanceIntent,
  ports: ProjectAdvancePorts,
): Promise<ProjectAdvanceResult> {
  if (intent.project_ref.trim().length === 0) {
    throw new Error('PROJECT_ADVANCE_PROJECT_REF_INVALID');
  }

  const run = await ports.startOrResumeProjectRun(intent.project_ref);
  if (run.run_id.trim().length === 0) {
    throw new Error('PROJECT_ADVANCE_RUN_ID_INVALID');
  }

  const result = await ports.advanceRun(run.run_id);
  if (result.run_id !== run.run_id) {
    throw new Error('PROJECT_ADVANCE_RUN_MISMATCH');
  }

  return result;
}