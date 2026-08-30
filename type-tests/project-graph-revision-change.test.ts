import {
  reconcileProjectTransitionChange,
  type ProjectTransitionGraphRevisionIdentity,
} from '../src/semantic/project-graph-reconciliation.js';

const previous: ProjectTransitionGraphRevisionIdentity = {
  transition_id: 'transition-a',
  definition_fingerprint: 'definition-stable',
  dependency_fingerprint: 'dependencies-a',
};
const current: ProjectTransitionGraphRevisionIdentity = {
  transition_id: 'transition-a',
  definition_fingerprint: 'definition-stable',
  dependency_fingerprint: 'dependencies-b',
};

const changed = reconcileProjectTransitionChange(previous, current, {
  mutation_scope_unchanged: true,
  required_authority_valid: true,
});

if (changed.kind === 'dependency-changed') {
  const mayContinue: false = changed.may_continue_existing_authority;
  const preservesConfirmation: true = changed.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}