import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_STATE_CONTRACT,
  assertCutoverReady,
  classifySourceInventory,
  buildMigrationSemanticManifest,
} from './migration-semantic-manifest.mjs';

const expected = new Map([
  ['execution_state', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['github_changeset_receipts', ['DISCARD', 'GITHUB_RECOVERABLE_EFFECT']],
  ['github_production_promotion_receipts', ['DISCARD', 'GITHUB_RECOVERABLE_EFFECT']],
  ['github_release_receipts', ['DISCARD', 'GITHUB_RECOVERABLE_EFFECT']],
  ['github_required_check_observations', ['DISCARD', 'DERIVED_STATE']],
  ['operation_state', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['orchestration_command_invocations', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['orchestration_horizons', ['DISCARD', 'DERIVED_STATE']],
  ['orchestration_invocation_resolutions', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['orchestration_runs', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['orchestration_skill_activations', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['overcenter_authority_freeze', ['DISCARD', 'CUTOVER_CONTROL_STATE']],
  ['portfolio_reconcile_receipts', ['DISCARD', 'LEGACY_PROJECTION_ONLY']],
  ['portfolio_repository_branch_roles', ['TRANSFORM', 'GITHUB_RECOVERY_SEED']],
  ['portfolio_repository_disposition', ['TRANSFORM', 'GITHUB_RECOVERY_SEED']],
  ['portfolio_verification_receipts', ['DISCARD', 'GITHUB_RECOVERABLE_PROOF']],
  ['portfolio_work_identity', ['DISCARD', 'PROVIDER_PROJECTION_STATE']],
  ['proof_state', ['DISCARD', 'GITHUB_RECOVERABLE_PROOF']],
  ['scheduled_cycle_events', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['work_lease_checkpoints', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['work_lease_heartbeats', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['work_lease_slots', ['DISCARD', 'RUNTIME_EPOCH_RESET']],
  ['work_leases', ['TRANSFORM', 'GITHUB_RECOVERY_SEED']],
  ['__hatchable_migrations', ['DISCARD', 'PROVIDER_IMPLEMENTATION_STATE']],
]);

test('cutover contract treats Hatchable runtime coordination as disposable epoch state', () => {
  assert.equal(SOURCE_STATE_CONTRACT.schema, 'migration-state-contract-v2');
  assert.equal(SOURCE_STATE_CONTRACT.invariant, 'github-plus-empty-canonical-cloud-sql-recovers-current-project-truth');
  assert.equal(Object.keys(SOURCE_STATE_CONTRACT.tables).length, 24);
  for (const [table, [disposition, reason]] of expected) {
    assert.deepEqual([SOURCE_STATE_CONTRACT.tables[table]?.disposition, SOURCE_STATE_CONTRACT.tables[table]?.reason], [disposition, reason], table);
  }
});

test('source inventory remains exhaustive even though most source state is discarded', () => {
  assert.throws(() => classifySourceInventory([...expected.keys(), 'surprise_state']), error => error?.code === 'MIGRATION_UNCLASSIFIED_SOURCE_STATE');
  assert.throws(() => classifySourceInventory([...expected.keys()].filter(name => name !== 'proof_state')), error => error?.code === 'MIGRATION_SOURCE_CENSUS_MISMATCH');
});

test('stale runs, leases and invocations do not block cutover', () => {
  assert.doesNotThrow(() => assertCutoverReady({
    source_mutation_frozen: true,
    github_recovery_seed_verified: true,
    empty_target_reconstruction_verified: true,
    unresolved_non_github_effects: 0,
    writer_inventory_complete: true,
    active_runs: 51,
    live_leases: 8,
    running_invocations: 3,
  }));
});

test('unrecoverable external-effect uncertainty still blocks cutover', () => {
  assert.throws(() => assertCutoverReady({
    source_mutation_frozen: true,
    github_recovery_seed_verified: true,
    empty_target_reconstruction_verified: true,
    unresolved_non_github_effects: 1,
    writer_inventory_complete: true,
  }), error => error?.code === 'MIGRATION_CUTOVER_NOT_READY' && error?.details?.blockers?.includes('unresolved_non_github_effects'));
});

test('semantic manifest requires GitHub reconstruction but not a legacy archive', async () => {
  const manifest = await buildMigrationSemanticManifest({
    source: { frozen: true, freeze_ref: 'hatchable:freeze:1' },
    census: classifySourceInventory([...expected.keys()]),
    target: { schema_ref: 'gcp-canonical-v1', authority_revision: 'a'.repeat(40) },
    recovery: { github_seed_verified: true, empty_target_reconstruction_verified: true, unresolved_non_github_effects: 0 },
    accounting: { unclassified: [], unmatched: [] },
    runtime: { verified: true, project_inspect_verified: true, safe_semantic_operation_verified: true },
    writer_cutover: { source_frozen: true, target_writer_enabled: true, authoritative_writer_count: 1 },
  });
  assert.equal(manifest.schema, 'migration-semantic-manifest-v2');
  assert.equal('archive' in manifest, false);
  assert.match(manifest.manifest_digest, /^sha256:[0-9a-f]{64}$/);
});