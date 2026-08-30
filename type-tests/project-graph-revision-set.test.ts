import {
  reconcileProjectGraphRevision,
  type ProjectTransitionGraphRevisionIdentity,
} from '../src/semantic/project-graph-reconciliation.js';

const previous: readonly ProjectTransitionGraphRevisionIdentity[] = [
  {
    transition_id: 'transition-a',
    definition_fingerprint: 'definition-a',
    dependency_fingerprint: 'dependencies-a',
  },
  {
    transition_id: 'transition-b',
    definition_fingerprint: 'definition-b',
    dependency_fingerprint: 'dependencies-b',
  },
];

const current: readonly ProjectTransitionGraphRevisionIdentity[] = [
  previous[0]!,
  {
    transition_id: 'transition-c',
    definition_fingerprint: 'definition-c',
    dependency_fingerprint: 'dependencies-c',
  },
];

const changes = reconcileProjectGraphRevision(previous, current, {
  'transition-a': {
    mutation_scope_unchanged: true,
    required_authority_valid: true,
  },
});

const unchanged = changes.find((change) => change.transition_id === 'transition-a');
if (unchanged?.kind === 'unchanged') {
  const mayContinue: true = unchanged.may_continue_existing_authority;
  void mayContinue;
}

const removed = changes.find((change) => change.transition_id === 'transition-b');
if (removed?.kind === 'removed') {
  const synthesized: false = removed.synthesizes_completion;
  void synthesized;
}

const introduced = changes.find((change) => change.transition_id === 'transition-c');
if (introduced?.kind === 'introduced') {
  const mayContinue: false = introduced.may_continue_existing_authority;
  void mayContinue;
}