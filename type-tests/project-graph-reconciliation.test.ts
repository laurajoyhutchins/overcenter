import {
  reconcileProjectTransitionPresence,
  reconcileProjectTransitionRevision,
  type ProjectTransitionContinuationEvidence,
  type ProjectTransitionRevisionIdentity,
} from '../src/semantic/project-graph-reconciliation.js';

const previous: ProjectTransitionRevisionIdentity = {
  transition_id: 'transition-a',
  definition_fingerprint: 'fingerprint-a',
};
const same: ProjectTransitionRevisionIdentity = {
  transition_id: 'transition-a',
  definition_fingerprint: 'fingerprint-a',
};
const changed: ProjectTransitionRevisionIdentity = {
  transition_id: 'transition-a',
  definition_fingerprint: 'fingerprint-b',
};
const validAuthority: ProjectTransitionContinuationEvidence = {
  mutation_scope_unchanged: true,
  required_authority_valid: true,
};

const introduced = reconcileProjectTransitionPresence(null, same);
if (introduced.kind === 'introduced') {
  const mayContinue: false = introduced.may_continue_existing_authority;
  const preservesConfirmation: false = introduced.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}

const removed = reconcileProjectTransitionPresence(previous, null);
if (removed.kind === 'removed') {
  const synthesizesCompletion: false = removed.synthesizes_completion;
  const mayContinue: false = removed.may_continue_existing_authority;
  void synthesizesCompletion;
  void mayContinue;
}

const unchanged = reconcileProjectTransitionRevision(previous, same, validAuthority);
if (unchanged.kind === 'unchanged') {
  const mayContinue: true = unchanged.may_continue_existing_authority;
  const preservesConfirmation: true = unchanged.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}

const invalidated = reconcileProjectTransitionRevision(previous, same, {
  mutation_scope_unchanged: false,
  required_authority_valid: true,
});
if (invalidated.kind === 'authority-invalidated') {
  const mayContinue: false = invalidated.may_continue_existing_authority;
  const preservesConfirmation: false = invalidated.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}

const redefined = reconcileProjectTransitionRevision(previous, changed, validAuthority);
if (redefined.kind === 'redefined') {
  const mayContinue: false = redefined.may_continue_existing_authority;
  const preservesConfirmation: false = redefined.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}