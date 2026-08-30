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

export type ProjectTransitionGraphRevisionIdentity = Readonly<{
  transition_id: string;
  definition_fingerprint: string;
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

export type ProjectTransitionChangeReconciliation =
  | ProjectTransitionRevisionReconciliation
  | DependencyChangedProjectTransitionRevision;

export type ProjectGraphRevisionContinuationEvidence = Readonly<
  Partial<Record<string, ProjectTransitionContinuationEvidence>>
>;

export type ProjectGraphRevisionReconciliation = readonly (
  | ProjectTransitionPresenceReconciliation
  | ProjectTransitionChangeReconciliation
)[];

export type ProjectGraphAuthorityCoordinate = Readonly<{
  repository: string;
  revision: string;
  derivation: string;
}>;

export type ProjectGraphRevisionChangeKind = Exclude<
  ProjectGraphRevisionReconciliation[number]['kind'],
  'unchanged'
>;

export type ProjectGraphRevisionChangeEvidence = Readonly<{
  schema: 'project-graph-revision-change-v1';
  previous_authority: ProjectGraphAuthorityCoordinate;
  current_authority: ProjectGraphAuthorityCoordinate;
  authority_changed: true;
  changes: readonly Readonly<{
    transition_id: string;
    kind: ProjectGraphRevisionChangeKind;
  }>[];
}>;

function requireSemanticText(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return normalized;
}

function requireGitRevision(value: string, field: string): string {
  const revision = requireSemanticText(value, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new TypeError(`${field} must be an exact 40-character Git revision`);
  }
  return revision;
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

export function reconcileProjectTransitionChange(
  previous: ProjectTransitionGraphRevisionIdentity,
  current: ProjectTransitionGraphRevisionIdentity,
  continuation: ProjectTransitionContinuationEvidence,
): ProjectTransitionChangeReconciliation {
  const revision = reconcileProjectTransitionRevision(previous, current, continuation);
  if (revision.kind === 'redefined') return revision;

  const dependencies = reconcileProjectTransitionDependencies(previous, current);
  if (dependencies.kind === 'dependency-changed') return dependencies;

  return revision;
}

function indexProjectGraphTransitions(
  transitions: readonly ProjectTransitionGraphRevisionIdentity[],
  field: string,
): ReadonlyMap<string, ProjectTransitionGraphRevisionIdentity> {
  const byId = new Map<string, ProjectTransitionGraphRevisionIdentity>();
  for (const transition of transitions) {
    const transitionId = requireSemanticText(transition.transition_id, `${field}.transition_id`);
    if (byId.has(transitionId)) {
      throw new TypeError(`${field} contains duplicate transition identity ${transitionId}`);
    }
    byId.set(transitionId, transition);
  }
  return byId;
}

export function reconcileProjectGraphRevision(
  previous: readonly ProjectTransitionGraphRevisionIdentity[],
  current: readonly ProjectTransitionGraphRevisionIdentity[],
  continuationByTransition: ProjectGraphRevisionContinuationEvidence = {},
): ProjectGraphRevisionReconciliation {
  const previousById = indexProjectGraphTransitions(previous, 'previous');
  const currentById = indexProjectGraphTransitions(current, 'current');
  const transitionIds = [...new Set([...previousById.keys(), ...currentById.keys()])].sort();

  return Object.freeze(
    transitionIds.map((transitionId) => {
      const previousTransition = previousById.get(transitionId) ?? null;
      const currentTransition = currentById.get(transitionId) ?? null;
      if (previousTransition === null || currentTransition === null) {
        return reconcileProjectTransitionPresence(previousTransition, currentTransition);
      }
      return reconcileProjectTransitionChange(
        previousTransition,
        currentTransition,
        continuationByTransition[transitionId] ?? {
          mutation_scope_unchanged: false,
          required_authority_valid: false,
        },
      );
    }),
  );
}

export function buildProjectGraphRevisionEvidence(
  previousAuthority: ProjectGraphAuthorityCoordinate,
  currentAuthority: ProjectGraphAuthorityCoordinate,
  reconciliation: ProjectGraphRevisionReconciliation,
): ProjectGraphRevisionChangeEvidence {
  const previous = Object.freeze({
    repository: requireSemanticText(previousAuthority.repository, 'previous_authority.repository'),
    revision: requireGitRevision(previousAuthority.revision, 'previous_authority.revision'),
    derivation: requireSemanticText(previousAuthority.derivation, 'previous_authority.derivation'),
  });
  const current = Object.freeze({
    repository: requireSemanticText(currentAuthority.repository, 'current_authority.repository'),
    revision: requireGitRevision(currentAuthority.revision, 'current_authority.revision'),
    derivation: requireSemanticText(currentAuthority.derivation, 'current_authority.derivation'),
  });
  if (previous.repository !== current.repository || previous.derivation !== current.derivation) {
    throw new TypeError('graph revision evidence requires one stable authority source');
  }
  if (previous.revision === current.revision) {
    throw new TypeError('graph revision evidence requires distinct authority revisions');
  }

  const changes = reconciliation
    .filter((change) => change.kind !== 'unchanged')
    .map((change) => Object.freeze({
      transition_id: requireSemanticText(change.transition_id, 'reconciliation.transition_id'),
      kind: change.kind as ProjectGraphRevisionChangeKind,
    }))
    .sort((left, right) => left.transition_id.localeCompare(right.transition_id));

  return Object.freeze({
    schema: 'project-graph-revision-change-v1',
    previous_authority: previous,
    current_authority: current,
    authority_changed: true,
    changes: Object.freeze(changes),
  });
}
