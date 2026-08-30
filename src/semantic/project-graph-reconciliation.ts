export type ProjectTransitionRevisionIdentity = Readonly<{
  transition_id: string;
  definition_fingerprint: string;
}>;

export type UnchangedProjectTransitionRevision = Readonly<{
  kind: 'unchanged';
  transition_id: string;
  definition_fingerprint: string;
  may_continue_existing_authority: true;
  may_preserve_confirmation: true;
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
  | RedefinedProjectTransitionRevision;

function requireSemanticText(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return normalized;
}

export function reconcileProjectTransitionRevision(
  previous: ProjectTransitionRevisionIdentity,
  current: ProjectTransitionRevisionIdentity,
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

  if (previousFingerprint === currentFingerprint) {
    return Object.freeze({
      kind: 'unchanged',
      transition_id: currentTransitionId,
      definition_fingerprint: currentFingerprint,
      may_continue_existing_authority: true,
      may_preserve_confirmation: true,
    });
  }

  return Object.freeze({
    kind: 'redefined',
    transition_id: currentTransitionId,
    previous_definition_fingerprint: previousFingerprint,
    current_definition_fingerprint: currentFingerprint,
    may_continue_existing_authority: false,
    may_preserve_confirmation: false,
  });
}