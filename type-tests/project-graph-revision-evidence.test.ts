import {
  buildProjectGraphRevisionEvidence,
  type ProjectGraphRevisionReconciliation,
} from '../src/semantic/project-graph-reconciliation.js';

const reconciliation: ProjectGraphRevisionReconciliation = Object.freeze([
  Object.freeze({
    kind: 'dependency-changed',
    transition_id: 'transition-c',
    previous_dependency_fingerprint: 'dependencies-old',
    current_dependency_fingerprint: 'dependencies-new',
    may_continue_existing_authority: false,
    may_preserve_confirmation: true,
  }),
  Object.freeze({
    kind: 'unchanged',
    transition_id: 'transition-a',
    definition_fingerprint: 'definition-a',
    may_continue_existing_authority: true,
    may_preserve_confirmation: true,
  }),
]);

const evidence = buildProjectGraphRevisionEvidence(
  {
    repository: 'laurajoyhutchins/overcenter',
    revision: '1111111111111111111111111111111111111111',
    derivation: 'overcenter-project-graph-v1',
  },
  {
    repository: 'laurajoyhutchins/overcenter',
    revision: '2222222222222222222222222222222222222222',
    derivation: 'overcenter-project-graph-v1',
  },
  reconciliation,
);

const schema: 'project-graph-revision-change-v1' = evidence.schema;
const previousRevision: string = evidence.previous_authority.revision;
const currentRevision: string = evidence.current_authority.revision;
const authorityChanged: true = evidence.authority_changed;
const changedTransitionId: string = evidence.changes[0]!.transition_id;

if (evidence.changes[0]?.kind === 'dependency-changed') {
  const changedKind: 'dependency-changed' = evidence.changes[0].kind;
  void changedKind;
}

void schema;
void previousRevision;
void currentRevision;
void authorityChanged;
void changedTransitionId;
