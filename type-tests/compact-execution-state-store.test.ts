import type {
  CompactExecutionStateStore,
  ResolveOperationInput,
} from '../src/ports/compact-execution-state-store.js';

async function exercise(store: CompactExecutionStateStore) {
  const acquired = await store.acquireExecution({
    subject_key:'project:overcenter#transition:ship',
    subject_kind:'project_transition',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    lease_ref:'lease-1',
    run_id:'scheduled:2026-09-01T19:00Z:repository-implementation',
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    graph_fingerprint:'b'.repeat(64),
    transition_revision_fingerprint:'c'.repeat(64),
    transition_dependency_fingerprint:'d'.repeat(64),
    expires_at:'2026-09-01T19:30:00.000Z',
    hard_expires_at:'2026-09-01T19:45:00.000Z',
    active_capability_material:'capability',
  });
  const checkpointed = await store.writeCheckpoint({
    subject_key:acquired.subject_key,
    lease_ref:acquired.lease_ref!,
    authority_epoch:acquired.authority_epoch,
    checkpoint:{ cursor:1 },
    checkpoint_sha256:'e'.repeat(64),
    updated_at:'2026-09-01T19:05:00.000Z',
  });
  return checkpointed.authority_epoch;
}
void exercise;

const resolution: ResolveOperationInput = {
  operation_id:'00000000-0000-0000-0000-000000000001',
  state:'succeeded',
  may_have_mutated:true,
  effect_kind:'github_commit',
  effect_ref:'commit:abc',
  effect_sha256:'f'.repeat(64),
  result_sha256:'0'.repeat(64),
  resolution:{ source:'readback' },
  resolved_at:'2026-09-01T19:10:00.000Z',
};
void resolution;

// @ts-expect-error terminal operation resolution cannot remain indeterminate
const invalidResolution: ResolveOperationInput = { ...resolution, state:'indeterminate' };
void invalidResolution;
