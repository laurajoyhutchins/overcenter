export type ProjectInspectIntent = Readonly<{
  project_ref: string;
}>;

export type ProjectInspection = Readonly<{
  project_ref: string;
  authority_revision: string;
  complete: boolean;
  frontier: readonly string[];
}>;

export type ProjectInspectPorts = Readonly<{
  inspectProject(projectRef: string): Promise<ProjectInspection>;
}>;

function requireNonBlank(value: string, code: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

export async function inspectProject(
  intent: ProjectInspectIntent,
  ports: ProjectInspectPorts,
): Promise<ProjectInspection> {
  const projectRef = requireNonBlank(intent.project_ref, 'PROJECT_INSPECT_PROJECT_REF_INVALID');
  const inspection = await ports.inspectProject(projectRef);

  if (inspection.project_ref !== projectRef) {
    throw new Error('PROJECT_INSPECT_PROJECT_REF_MISMATCH');
  }
  requireNonBlank(inspection.authority_revision, 'PROJECT_INSPECT_AUTHORITY_REVISION_INVALID');

  return inspection;
}