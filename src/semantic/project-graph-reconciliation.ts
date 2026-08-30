export type ProjectTransitionRevisionIdentity = Readonly<{
  transition_id: string;
  definition_fingerprint: string;
}>;

export type ProjectTransitionContinuationEvidence = Readonly<{
  mutation_scope_unchanged: boolean;
  required_authority_valid: boolean;
}>;

export type IntroducedProjectTransitionRevision = Readonly<{
  kind: 'introduced';
  transition_id: string;
  definition_fingerprint: string;
  may_continue_existing_authority: false;
  may_preserve_confirmation: false;
}>;

export type RemovedProjectTransitionRevision = Readonly<{
  kind: 'removed';
  transition_id: string;
  previous_definition_fingerprint: string;
  may_continue_existing_authority: false;
  may_preserve_confirmation: false;
  synthesizes_completion: false;
}>;

export type ProjectTransitionPresenceReconciliation =
  | IntroducedProjectTransitionRevision
  | RemovedProjectTransitionRevision;

export type ProjectTransitionDependencyIdentity = Readonly<{
  transition_id: string;
  dependency_fingerprint: string;
}>;

export type DependencyChangedProjectTransitionRevision = Readonly<{
  kind: 'dependency-changed';
  transition_id: string;
  previous_dependency_fingerprint: string;
  current_dependency_fingerprint: string;
  may_continue_existing_authority: false;
  may_preserve_confirmation: true;
}>;

export type DependencyUnchangedProjectTransitionRevision = Readonly<{
  kind: 'dependency-unchanged';
  transition_id: string;
  dependency_fingerprint: string;
}>;

export type ProjectTransitionDependencyReconciliation =
  | DependencyChangedProjectTransitionRevision
  | DependencyUnchangedProjectTransitionRevision;

export type UnchangedProjectTransitionRevision = Readonly<{
  kind: 'unchanged';
  transition_id: string;
  definition_fingerprint: string;
  may_continue_existing_authority: true;
  may_preserve_confirmation: true;
}>;

export type AuthorityInvalidatedProjectTransitionRevision = Readonly<{
  kind: 'authority-invalidated';
  transition_id: string;
  definition_fingerprint: string;
  mutation_scope_unchanged: boolean;
  required_authority_valid: boolean;
  may_continue_existing_authority: false;
  may_preserve_confirmation: false;
}>;

export type RedefinedProjectTransitionRevision = Readonly<{
  kind: 'redefined';
  transition_id: string;
  previous_definition_fingerprint: string;
  current_definition_fingerprint: string;
  may_continue_existing_authority: false;
  may_preserve_confirmation: false;
}>;

export type ProjectTransitionRevisionReconciliation =
  | UnchangedProjectTransitionRevision
  | AuthorityInvalidatedProjectTransitionRevision
  | RedefinedProjectTransitionRevision;

function requireSemanticText(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return normalized;
}

export function reconcileProjectTransitionPresence(
  previous: ProjectTransitionRevisionIdentity | null,
  current: ProjectTransitionRevisionIdentity | null,
): ProjectTransitionPresenceReconciliation {
  if (previous === null && current !== null) {
    return Object.freeze({
      kind: 'introduced',
      transition_id: requireSemanticText(current.transition_id, 'current.transition_id'),
      definition_fingerprint: requireSemanticText(current.definition_fingerprint, 'current.definition_fingerprint'),
      may_continue_existing_authority: false,
      may_preserve_confirmation: false,
    });
  }

  if (previous !== null && current === null) {
    return Object.freeze({
      kind: 'removed',
      transition_id: requireSemanticText(previous.transition_id, 'previous.transition_id'),
      previous_definition_fingerprint: requireSemanticText(
        previous.definition_fingerprint,
        'previous.definition_fingerprint',
      ),
      may_continue_existing_authority: false,
      may_preserve_confirmation: false,
      synthesizes_completion: false,
    });
  }

  throw new TypeError('project transition presence reconciliation requires exactly one revision to be absent');
}

export function reconcileProjectTransitionDependencies(
  previous: ProjectTransitionDependencyIdentity,
  current: ProjectTransitionDependencyIdentity,
): ProjectTransitionDependencyReconciliation {
  const previousTransitionId = requireSemanticText(previous.transition_id, 'previous.transition_id');
  const currentTransitionId = requireSemanticText(current.transition_id, 'current.transition_id');
  if (previousTransitionId !== currentTransitionId) {
    throw new TypeError('project transition dependency reconciliation requires one stable transition identity');
  }

  const previousFingerprint = requireSemanticText(
    previous.dependency_fingerprint,
    'previous.dependency_fingerprint',
  );
  const currentFingerprint = requireSemanticText(
    current.dependency_fingerprint,
    'current.dependency_fingerprint',
  );

  if (previousFingerprint !== currentFingerprint) {
    return Object.freeze({
      kind: 'dependency-changed',
      transition_id: currentTransitionId,
      previous_dependency_fingerprint: previousFingerprint,
      current_dependency_fingerprint: currentFingerprint,
      may_continue_existing_authority: false,
      may_preserve_confirmation: true,
    });
  }

  return Object.freeze({
    kind: 'dependency-unchanged',
    transition_id: currentTransitionId,
    dependency_fingerprint: currentFingerprint,
  });
}

export function reconcileProjectTransitionRevision(
  previous: ProjectTransitionRevisionIdentity,
  current: ProjectTransitionRevisionIdentity,
  continuation: ProjectTransitionContinuationEvidence,
): ProjectTransitionRevisionReconciliation {
  const previousTransitionId = requireSemanticText(previous.transition_id, 'previous.transition_id');
  const currentTransitionId = requireSemanticText(current.transition_id, 'current.transition_id');
  if (previousTransitionId !== currentTransitionId) {
    throw new TypeError('project transition revision reconciliation requires one stable transition identity');
  }

  const previousFingerprint = requireSemanticText(
    previous.definition_fingerprint,
    'previous.definition_fingerprint',
  );
  const currentFingerprint = requireSemanticText(
    current.definition_fingerprint,
    'current.definition_fingerprint',
  );

  if (previousFingerprint !== currentFingerprint) {
    return Object.freeze({
      kind: 'redefined',
      transition_id: currentTransitionId,
      previous_definition_fingerprint: previousFingerprint,
      current_definition_fingerprint: currentFingerprint,
      may_continue_existing_authority: false,
      may_preserve_confirmation: false,
    });
  }

  const mutationScopeUnchanged = continuation?.mutation_scope_unchanged === true;
  const requiredAuthorityValid = continuation?.required_authority_valid === true;
  if (!mutationScopeUnchanged || !requiredAuthorityValid) {
    return Object.freeze({
      kind: 'authority-invalidated',
      transition_id: currentTransitionId,
      definition_fingerprint: currentFingerprint,
      mutation_scope_unchanged: mutationScopeUnchanged,
      required_authority_valid: requiredAuthorityValid,
      may_continue_existing_authority: false,
      may_preserve_confirmation: false,
    });
  }

  return Object.freeze({
    kind: 'unchanged',
    transition_id: currentTransitionId,
    definition_fingerprint: currentFingerprint,
    may_continue_existing_authority: true,
    may_preserve_confirmation: true,
  });
}