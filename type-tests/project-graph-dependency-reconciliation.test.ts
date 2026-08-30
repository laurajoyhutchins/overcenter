import {
  reconcileProjectTransitionDependencies,
  type ProjectTransitionDependencyIdentity,
} from '../src/semantic/project-graph-reconciliation.js';

const previous: ProjectTransitionDependencyIdentity = {
  transition_id: 'transition-a',
  dependency_fingerprint: 'dependencies-a',
};
const current: ProjectTransitionDependencyIdentity = {
  transition_id: 'transition-a',
  dependency_fingerprint: 'dependencies-b',
};

const changed = reconcileProjectTransitionDependencies(previous, current);
if (changed.kind === 'dependency-changed') {
  const mayContinue: false = changed.may_continue_existing_authority;
  const preservesConfirmation: true = changed.may_preserve_confirmation;
  void mayContinue;
  void preservesConfirmation;
}