import {
  reconcileProjectTransitionRevision,
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

const unchanged = reconcileProjectTransitionRevision(previous, same);
if (unchanged.kind === 'unchanged') {
  const mayContinue: true = unchanged.may_continue_existing_authority;
  const preservesConfirmation: true = unchanged.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}

const redefined = reconcileProjectTransitionRevision(previous, changed);
if (redefined.kind === 'redefined') {
  const mayContinue: false = redefined.may_continue_existing_authority;
  const preservesConfirmation: false = redefined.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}