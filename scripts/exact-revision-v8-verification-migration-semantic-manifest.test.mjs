import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_STATE_CONTRACT,
  assertQuiescentForFinalSnapshot,
  classifySourceInventory,
  buildMigrationSemanticManifest,
} from './migration-semantic-manifest.mjs';

const expected = new Map([
  ['execution_state', ['TRANSFORM', 'RUNTIME_EPOCH_RESET']],
  ['github_changeset_receipts', ['TRANSFORM', 'CANONICAL_EFFECT_EVIDENCE']],
  ['github_production_promotion_receipts', ['TRANSFORM', 'CANONICAL_EFFECT_EVIDENCE']],
  ['github_release_receipts', ['TRANSFORM', 'CANONICAL_EFFECT_EVIDENCE']],
  ['github_required_check_observations', ['DISCARD', 'DERIVED_STATE']],
  ['operation_state', ['PRESERVE', 'CURRENT_KERNEL_TRUTH']],
  ['orchestration_command_invocations', ['TRANSFORM', 'CANONICAL_RECOVERY_EVIDENCE']],
  ['orchestration_horizons', ['DISCARD', 'DERIVED_STATE']],
  ['orchestration_invocation_resolutions', ['TRANSFORM', 'CANONICAL_RECOVERY_EVIDENCE']],
  ['orchestration_runs', ['TRANSFORM', 'RUNTIME_EPOCH_RESET']],
  ['orchestration_skill_activations', ['ARCHIVE', 'LEGACY_HISTORY_ONLY']],
  ['portfolio_reconcile_receipts', ['ARCHIVE', 'LEGACY_PROJECTION_ONLY']],
  ['portfolio_repository_branch_roles', ['PRESERVE', 'REPOSITORY_POLICY_TRUTH']],
  ['portfolio_repository_disposition', ['PRESERVE', 'REPOSITORY_POLICY_TRUTH']],
  ['portfolio_verification_receipts', ['TRANSFORM', 'CANONICAL_PROOF_EVIDENCE']],
  ['portfolio_work_identity', ['TRANSFORM', 'PROVIDER_NEUTRALIZATION']],
  ['proof_state', ['PRESERVE', 'CURRENT_KERNEL_TRUTH']],
  ['scheduled_cycle_events', ['ARCHIVE', 'LEGACY_HISTORY_ONLY']],
  ['work_lease_checkpoints', ['ARCHIVE', 'LEGACY_HISTORY_ONLY']],
  ['work_lease_heartbeats', ['DISCARD', 'EPHEMERAL_COORDINATION']],
  ['work_lease_slots', ['DISCARD', 'EPHEMERAL_COORDINATION']],
  ['work_leases', ['TRANSFORM', 'RUNTIME_EPOCH_RESET']],
  ['__hatchable_migrations', ['ARCHIVE', 'PROVIDER_IMPLEMENTATION_STATE']],
]);

test('source disposition contract exhaustively encodes the authoritative 22-table census plus migration ledger', () => {
  assert.equal(Object.keys(SOURCE_STATE_CONTRACT.tables).length, 23);
  for (const [table, [disposition, reason]] of expected) {
    assert.deepEqual(
      [SOURCE_STATE_CONTRACT.tables[table]?.disposition, SOURCE_STATE_CONTRACT.tables[table]?.reason],
      [disposition, reason],
      table,
    );
  }
});

test('source inventory fails closed on any unclassified table', () => {
  assert.throws(
    () => classifySourceInventory([...expected.keys(), 'surprise_state']),
    error => error?.code === 'MIGRATION_UNCLASSIFIED_SOURCE_STATE'
      && error?.details?.unclassified?.includes('surprise_state'),
  );
});

test('source inventory also fails closed if an expected classified table disappears', () => {
  assert.throws(
    () => classifySourceInventory([...expected.keys()].filter(name => name !== 'proof_state')),
    error => error?.code === 'MIGRATION_SOURCE_CENSUS_MISMATCH'
      && error?.details?.missing?.includes('proof_state'),
  );
});

test('mandatory capability and runtime-epoch field overrides cannot inherit a hotter disposition', () => {
  assert.deepEqual(SOURCE_STATE_CONTRACT.field_overrides['execution_state.active_capability_material'], {
    disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY',
  });
  assert.deepEqual(SOURCE_STATE_CONTRACT.field_overrides['work_leases.lease_token'], {
    disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY',
  });
  assert.deepEqual(SOURCE_STATE_CONTRACT.field_overrides['work_leases.token_hash'], {
    disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY',
  });
});

test('final snapshot quiescence rejects any effective live authority or unresolved mutation uncertainty', () => {
  for (const [field, value] of [
    ['active_runs', 1],
    ['live_leases', 1],
    ['occupied_live_slots', 1],
    ['unresolved_potentially_mutating_operations', 1],
    ['indeterminate_external_effects', 1],
  ]) {
    const input = {
      source_mutation_frozen: true,
      active_runs: 0,
      live_leases: 0,
      occupied_live_slots: 0,
      unresolved_potentially_mutating_operations: 0,
      indeterminate_external_effects: 0,
      writer_inventory_complete: true,
      rehearsal_verified: true,
      [field]: value,
    };
    assert.throws(() => assertQuiescentForFinalSnapshot(input), error => error?.code === 'MIGRATION_QUIESCENCE_REQUIRED');
  }
});

test('semantic manifest refuses completion without archive, recovery, exact-revision and single-writer evidence', async () => {
  const base = {
    source: { frozen: true, snapshot_ref: 'source:snapshot:1', schema_digest: 'sha256:a' },
    census: classifySourceInventory([...expected.keys()]),
    target: { schema_ref: 'gcp-canonical-v1', authority_revision: 'a'.repeat(40) },
    archive: null,
    accounting: { unclassified: [], unmatched: [] },
    recovery: { verified: true },
    runtime: { verified: true, project_inspect_verified: true, safe_semantic_operation_verified: true },
    writer_cutover: { source_frozen: true, target_writer_enabled: true, authoritative_writer_count: 1 },
  };
  await assert.rejects(
    () => buildMigrationSemanticManifest(base),
    error => error?.code === 'MIGRATION_ARCHIVE_EVIDENCE_REQUIRED',
  );
});