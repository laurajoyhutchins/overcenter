import type {
  AcquireExecutionInput,
  CompactExecutionStateStore,
  HeartbeatExecutionInput,
  PrepareOperationInput,
  PutProofInput,
  SettleExecutionInput,
  WriteCheckpointInput,
} from '../src/ports/compact-execution-state-store.js';

async function exercise(store: CompactExecutionStateStore) {
  const acquired = await store.acquireExecution({
    subject_key:'project:overcenter#transition:ship',
    subject_kind:'project_transition',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    lease_ref:'lease-1',
    run_id:'run-1',
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    graph_fingerprint:'b'.repeat(64),
    transition_revision_fingerprint:'c'.repeat(64),
    transition_dependency_fingerprint:'d'.repeat(64),
    expires_at:'2026-09-01T18:30:00.000Z',
    hard_expires_at:'2026-09-01T18:45:00.000Z',
    active_capability_material:'capability',
    observed_at:'2026-09-01T18:00:00.000Z',
  } satisfies AcquireExecutionInput);

  await store.writeCheckpoint({
    subject_key:acquired.subject_key,
    lease_ref:'lease-1',
    authority_epoch:acquired.authority_epoch,
    checkpoint:{ cursor:1 },
    checkpoint_sha256:'e'.repeat(64),
    updated_at:'2026-09-01T18:05:00.000Z',
  } satisfies WriteCheckpointInput);

  await store.heartbeatExecution({
    subject_key:acquired.subject_key,
    lease_ref:'lease-1',
    authority_epoch:acquired.authority_epoch,
    progress_sha256:'f'.repeat(64),
    expires_at:'2026-09-01T18:35:00.000Z',
    heartbeat_at:'2026-09-01T18:10:00.000Z',
  } satisfies HeartbeatExecutionInput);

  await store.prepareOperation({
    operation_id:'00000000-0000-0000-0000-000000000001',
    command:'github.apply_changeset',
    idempotency_scope:'repository:laurajoyhutchins/overcenter',
    idempotency_key:'idem-1',
    request_sha256:'0'.repeat(64),
    subject_key:acquired.subject_key,
    run_id:'run-1',
    lease_epoch:acquired.authority_epoch,
    authority_revision:'a'.repeat(40),
    recovery_payload:{ repository:'laurajoyhutchins/overcenter' },
    created_at:'2026-09-01T18:10:00.000Z',
  } satisfies PrepareOperationInput);

  await store.putProof({
    proof_key:'required-checks:head',
    subject_key:acquired.subject_key,
    predicate_kind:'required_checks_satisfied',
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    evidence_sha256:'1'.repeat(64),
    evidence_refs:[],
    satisfied_at:'2026-09-01T18:10:00.000Z',
    consumed_at:null,
  } satisfies PutProofInput);

  return store.settleExecution({
    subject_key:acquired.subject_key,
    lease_ref:'lease-1',
    authority_epoch:acquired.authority_epoch,
    continuation:{ next:'confirm' },
    continuation_sha256:'2'.repeat(64),
    continuation_execution_fingerprint:'3'.repeat(64),
    no_progress_streak:0,
    updated_at:'2026-09-01T18:20:00.000Z',
  } satisfies SettleExecutionInput);
}

void exercise;
