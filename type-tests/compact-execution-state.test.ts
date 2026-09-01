import type {
  ExecutionFence,
  ExecutionState,
  OperationState,
  ProofState,
} from '../src/semantic/compact-execution-state.js';

const fence: ExecutionFence = {
  subject_key: 'project:overcenter#transition:ship',
  authority_epoch: 3,
  authority_revision: 'a'.repeat(40),
};

const execution: ExecutionState = {
  subject_key: fence.subject_key,
  subject_kind: 'project_transition',
  project_ref: 'github:laurajoyhutchins/overcenter',
  transition_id: 'ship',
  authority_epoch: 3,
  lease_ref: '00000000-0000-0000-0000-000000000001',
  run_id: '00000000-0000-0000-0000-000000000002',
  authority_repository: 'laurajoyhutchins/overcenter',
  authority_revision: fence.authority_revision,
  graph_fingerprint: 'b'.repeat(64),
  transition_revision_fingerprint: 'c'.repeat(64),
  transition_dependency_fingerprint: 'd'.repeat(64),
  expires_at: '2026-09-01T18:30:00.000Z',
  hard_expires_at: '2026-09-01T18:45:00.000Z',
  active_capability_material: 'opaque-capability',
  checkpoint: { cursor: 2 },
  checkpoint_sha256: 'e'.repeat(64),
  recent_progress_sha256: ['f'.repeat(64), '0'.repeat(64)],
  heartbeat_count: 2,
  last_heartbeat_at: '2026-09-01T18:10:00.000Z',
  continuation: { next: 'confirm' },
  continuation_sha256: '1'.repeat(64),
  continuation_execution_fingerprint: '2'.repeat(64),
  no_progress_streak: 1,
  updated_at: '2026-09-01T18:10:00.000Z',
};
void execution;

const unresolved: OperationState = {
  operation_id: '00000000-0000-0000-0000-000000000003',
  command: 'github.apply_changeset',
  idempotency_scope: 'repository:laurajoyhutchins/overcenter',
  idempotency_key: 'idem-1',
  request_sha256: '3'.repeat(64),
  state: 'indeterminate',
  subject_key: fence.subject_key,
  run_id: null,
  lease_epoch: 3,
  authority_revision: fence.authority_revision,
  may_have_mutated: true,
  effect_kind: 'github_commit',
  effect_ref: null,
  effect_sha256: null,
  result_sha256: null,
  recovery_payload: { repository: 'laurajoyhutchins/overcenter' },
  resolution: null,
  created_at: '2026-09-01T18:00:00.000Z',
  resolved_at: null,
};
void unresolved;

const proof: ProofState = {
  proof_key: 'required-checks:laurajoyhutchins/overcenter:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  subject_key: fence.subject_key,
  predicate_kind: 'required_checks_satisfied',
  authority_repository: 'laurajoyhutchins/overcenter',
  authority_revision: fence.authority_revision,
  evidence_sha256: '4'.repeat(64),
  evidence_refs: [{ kind: 'github_check_suite', ref: 'checks:1234' }],
  satisfied_at: '2026-09-01T18:00:00.000Z',
  consumed_at: null,
};
void proof;

// @ts-expect-error epoch is an integer fence
const badFence: ExecutionFence = { ...fence, authority_epoch: '3' };
void badFence;

// @ts-expect-error progress history is bounded to the current two hashes
const tooMuchProgress: ExecutionState = {
  ...execution,
  recent_progress_sha256: ['a', 'b', 'c'],
};
void tooMuchProgress;

// @ts-expect-error operation state is a closed lifecycle vocabulary
const impossibleOperation: OperationState = { ...unresolved, state: 'unknown' };
void impossibleOperation;
