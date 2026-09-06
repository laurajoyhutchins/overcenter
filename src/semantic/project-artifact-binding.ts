export type ProjectArtifactKind = 'issue' | 'pull_request';
export type ProjectArtifactRelationship = 'full_coverage_equivalence';
export type ProjectArtifactSatisfactionCondition = 'closed' | 'merged';

export type ProjectArtifactProviderIdentity = Readonly<{
  kind: ProjectArtifactKind;
  number: number;
}>;

export type ProjectArtifactObservation = Readonly<{
  repository: string;
  kind: ProjectArtifactKind;
  number: number;
  state: string;
  merged: boolean;
  url?: string | null;
}>;

export type ProjectArtifactBinding = Readonly<{
  schema: 'project-artifact-binding-v1';
  project_ref: string;
  repository: string;
  authority_revision: string;
  transition_id: string;
  provider: ProjectArtifactProviderIdentity;
  relationship: ProjectArtifactRelationship;
  satisfaction_condition: ProjectArtifactSatisfactionCondition;
  binding_ref: string;
}>;

type ProjectGraphSnapshot = Readonly<{
  authority?: Readonly<{ definition?: Readonly<{ repository?: string; revision?: string }> }>;
  nodes?: readonly Readonly<{ id?: string }>[];
}>;

type ProjectArtifactBindingInput = Readonly<{
  project_ref: string;
  expected_revision: string;
  transition_id: string;
  provider: ProjectArtifactProviderIdentity;
  relationship: ProjectArtifactRelationship;
  satisfaction_condition: ProjectArtifactSatisfactionCondition;
}>;

type ProjectArtifactBindingRuntime = Readonly<{
  readProjectGraph(input: Readonly<{ project_ref: string }>): Promise<ProjectGraphSnapshot>;
  readProviderArtifact(input: Readonly<{ repository: string; kind: ProjectArtifactKind; number: number }>): Promise<ProjectArtifactObservation>;
  bindingRefFor(binding: Omit<ProjectArtifactBinding, 'binding_ref'>): Promise<string>;
  appendBindingObservation(binding: ProjectArtifactBinding): Promise<Readonly<{ observation_ref?: string | null }>>;
}>;

const PROJECT_REF = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const SHA40 = /^[0-9a-f]{40}$/;
const KINDS = new Set<ProjectArtifactKind>(['issue', 'pull_request']);

function fail(code: string, message: string, details: Readonly<Record<string, unknown>> | null = null): never {
  const error = new Error(message) as Error & { code: string; details: Readonly<Record<string, unknown>> | null };
  error.code = code;
  error.details = details;
  throw error;
}

function text(value: unknown, field: string, max = 512): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${field} is required`, { field });
  return result;
}

function normalize(input: ProjectArtifactBindingInput): Readonly<ProjectArtifactBindingInput & { repository: string }> {
  const projectRef = text(input.project_ref, 'project_ref', 300);
  const match = projectRef.match(PROJECT_REF);
  if (!match?.[1]) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'project_ref must identify one GitHub repository');
  const expectedRevision = text(input.expected_revision, 'expected_revision', 40).toLowerCase();
  if (!SHA40.test(expectedRevision)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'expected_revision must be a full Git SHA');
  const transitionId = text(input.transition_id, 'transition_id', 256);
  const kind = text(input.provider?.kind, 'provider.kind', 32) as ProjectArtifactKind;
  const number = Number(input.provider?.number);
  if (!KINDS.has(kind) || !Number.isInteger(number) || number < 1) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'provider must name an issue or pull request by positive numeric identity');
  const relationship = text(input.relationship, 'relationship', 64) as ProjectArtifactRelationship;
  if (relationship !== 'full_coverage_equivalence') fail('PROJECT_ARTIFACT_BINDING_INVALID', 'relationship must explicitly assert full_coverage_equivalence');
  const satisfaction = text(input.satisfaction_condition, 'satisfaction_condition', 32) as ProjectArtifactSatisfactionCondition;
  if ((kind === 'issue' && satisfaction !== 'closed') || (kind === 'pull_request' && satisfaction !== 'merged')) {
    fail('PROJECT_ARTIFACT_BINDING_INVALID', 'satisfaction_condition must be closed for issues and merged for pull requests');
  }
  return Object.freeze({ project_ref: projectRef, repository: match[1], expected_revision: expectedRevision, transition_id: transitionId, provider: Object.freeze({ kind, number }), relationship, satisfaction_condition: satisfaction });
}

export function classifyProjectArtifactBinding(binding: ProjectArtifactBinding | null, provider: ProjectArtifactObservation | null): Readonly<Record<string, unknown>> {
  if (!binding) return Object.freeze({ classification: 'ambiguous', reason: 'explicit-binding-required' });
  if (!provider || provider.repository !== binding.repository || provider.kind !== binding.provider.kind || Number(provider.number) !== binding.provider.number) {
    return Object.freeze({ classification: 'ambiguous', reason: 'provider-identity-mismatch' });
  }
  const satisfied = binding.satisfaction_condition === 'closed'
    ? String(provider.state || '').toLowerCase() === 'closed'
    : Boolean(provider.merged);
  return Object.freeze({ classification: satisfied ? 'satisfied' : 'active', evidence: Object.freeze({ binding_ref: binding.binding_ref, provider: Object.freeze({ repository: provider.repository, kind: provider.kind, number: Number(provider.number) }) }) });
}

export function createProjectArtifactBindingService(runtime: ProjectArtifactBindingRuntime) {
  if (typeof runtime?.readProjectGraph !== 'function' || typeof runtime?.readProviderArtifact !== 'function' || typeof runtime?.bindingRefFor !== 'function' || typeof runtime?.appendBindingObservation !== 'function') {
    fail('PROJECT_ARTIFACT_BINDING_RUNTIME_INVALID', 'binding runtime dependencies are unavailable');
  }
  return Object.freeze({
    async bind(input: ProjectArtifactBindingInput) {
      const request = normalize(input);
      const graph = await runtime.readProjectGraph({ project_ref: request.project_ref });
      const authority = graph?.authority?.definition;
      if (authority?.repository !== request.repository || String(authority?.revision || '').toLowerCase() !== request.expected_revision) {
        fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE', 'project artifact binding authority changed before mutation', { expected_revision: request.expected_revision, actual_revision: authority?.revision || null });
      }
      if (!Array.isArray(graph.nodes) || !graph.nodes.some((node) => String(node?.id || '') === request.transition_id)) {
        fail('PROJECT_ARTIFACT_BINDING_SUBJECT_NOT_FOUND', 'transition is absent from the exact authoritative project graph', { transition_id: request.transition_id });
      }
      const provider = await runtime.readProviderArtifact({ repository: request.repository, ...request.provider });
      if (!provider || provider.repository !== request.repository || provider.kind !== request.provider.kind || Number(provider.number) !== request.provider.number) {
        fail('PROJECT_ARTIFACT_BINDING_PROVIDER_MISMATCH', 'provider readback does not match the explicitly selected artifact identity');
      }
      const core = Object.freeze({ schema: 'project-artifact-binding-v1' as const, project_ref: request.project_ref, repository: request.repository, authority_revision: request.expected_revision, transition_id: request.transition_id, provider: request.provider, relationship: request.relationship, satisfaction_condition: request.satisfaction_condition });
      const bindingRef = await runtime.bindingRefFor(core);
      const binding: ProjectArtifactBinding = Object.freeze({ ...core, binding_ref: bindingRef });
      const persisted = await runtime.appendBindingObservation(binding);
      return Object.freeze({ ok: true, binding, provider: Object.freeze({ ...provider }), observation_ref: persisted?.observation_ref || null, classification: classifyProjectArtifactBinding(binding, provider) });
    },
  });
}
