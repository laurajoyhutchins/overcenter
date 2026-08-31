import {
  reconcileProjectTransitionPresence,
  reconcileProjectTransitionRemoval,
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

const acceptedRemoval = reconcileProjectTransitionRemoval(previous, {
  has_live_execution_authority: false,
  was_confirmed: false,
});
if (acceptedRemoval.kind === 'removal-accepted') {
  const mayRemove: true = acceptedRemoval.may_remove;
  const synthesizesCompletion: false = acceptedRemoval.synthesizes_completion;
  void mayRemove;
  void synthesizesCompletion;
}

const liveAuthorityConflict = reconcileProjectTransitionRemoval(previous, {
  has_live_execution_authority: true,
  was_confirmed: false,
});
if (liveAuthorityConflict.kind === 'removal-conflict') {
  const mayRemove: false = liveAuthorityConflict.may_remove;
  const reason: 'live-execution-authority' = liveAuthorityConflict.reason;
  void mayRemove;
  void reason;
}

const confirmedHistoryConflict = reconcileProjectTransitionRemoval(previous, {
  has_live_execution_authority: false,
  was_confirmed: true,
});
if (confirmedHistoryConflict.kind === 'removal-conflict') {
  const mayRemove: false = confirmedHistoryConflict.may_remove;
  const reason: 'confirmed-history' = confirmedHistoryConflict.reason;
  void mayRemove;
  void reason;
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