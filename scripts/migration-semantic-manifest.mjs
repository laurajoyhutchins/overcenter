import { createHash } from 'node:crypto';

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

const tables = Object.freeze({
  execution_state: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  github_changeset_receipts: { disposition: 'DISCARD', reason: 'GITHUB_RECOVERABLE_EFFECT' },
  github_production_promotion_receipts: { disposition: 'DISCARD', reason: 'GITHUB_RECOVERABLE_EFFECT' },
  github_release_receipts: { disposition: 'DISCARD', reason: 'GITHUB_RECOVERABLE_EFFECT' },
  github_required_check_observations: { disposition: 'DISCARD', reason: 'DERIVED_STATE' },
  operation_state: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  orchestration_command_invocations: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  orchestration_horizons: { disposition: 'DISCARD', reason: 'DERIVED_STATE' },
  orchestration_invocation_resolutions: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  orchestration_runs: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  orchestration_skill_activations: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  overcenter_authority_freeze: { disposition: 'DISCARD', reason: 'CUTOVER_CONTROL_STATE' },
  portfolio_reconcile_receipts: { disposition: 'DISCARD', reason: 'LEGACY_PROJECTION_ONLY' },
  portfolio_repository_branch_roles: { disposition: 'TRANSFORM', reason: 'GITHUB_RECOVERY_SEED' },
  portfolio_repository_disposition: { disposition: 'TRANSFORM', reason: 'GITHUB_RECOVERY_SEED' },
  portfolio_verification_receipts: { disposition: 'DISCARD', reason: 'GITHUB_RECOVERABLE_PROOF' },
  portfolio_work_identity: { disposition: 'DISCARD', reason: 'PROVIDER_PROJECTION_STATE' },
  proof_state: { disposition: 'DISCARD', reason: 'GITHUB_RECOVERABLE_PROOF' },
  scheduled_cycle_events: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  work_lease_checkpoints: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  work_lease_heartbeats: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  work_lease_slots: { disposition: 'DISCARD', reason: 'RUNTIME_EPOCH_RESET' },
  work_leases: { disposition: 'TRANSFORM', reason: 'GITHUB_RECOVERY_SEED' },
  __hatchable_migrations: { disposition: 'DISCARD', reason: 'PROVIDER_IMPLEMENTATION_STATE' },
});

const fieldOverrides = Object.freeze({
  'execution_state.active_capability_material': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
  'work_leases.lease_token': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
  'work_leases.token_hash': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
});

export const SOURCE_STATE_CONTRACT = Object.freeze({
  schema: 'migration-state-contract-v2',
  census: 'hatchable-postgres-22-application-tables-plus-migration-ledger-and-cutover-control',
  invariant: 'github-plus-empty-canonical-cloud-sql-recovers-current-project-truth',
  tables,
  field_overrides: fieldOverrides,
});

export function classifySourceInventory(sourceTables) {
  if (!Array.isArray(sourceTables)) throw failure('MIGRATION_SOURCE_INVENTORY_REQUIRED', 'source table inventory is required');
  const normalized = [...new Set(sourceTables.map(name => String(name || '').trim()).filter(Boolean))].sort();
  const expected = Object.keys(tables).sort();
  const unclassified = normalized.filter(name => !tables[name]);
  if (unclassified.length) throw failure('MIGRATION_UNCLASSIFIED_SOURCE_STATE', 'source inventory contains unclassified state', { unclassified });
  const missing = expected.filter(name => !normalized.includes(name));
  if (missing.length) throw failure('MIGRATION_SOURCE_CENSUS_MISMATCH', 'source inventory is missing classified state', { missing });
  return Object.freeze({
    schema: 'migration-source-census-v2',
    tables: Object.freeze(normalized.map(name => Object.freeze({ table: name, ...tables[name] }))),
    count: normalized.length,
  });
}

export function assertCutoverReady(input = {}) {
  const blockers = [];
  if (input.source_mutation_frozen !== true) blockers.push('source_mutation_frozen');
  if (input.github_recovery_seed_verified !== true) blockers.push('github_recovery_seed_verified');
  if (input.empty_target_reconstruction_verified !== true) blockers.push('empty_target_reconstruction_verified');
  if (Number(input.unresolved_non_github_effects ?? -1) !== 0) blockers.push('unresolved_non_github_effects');
  if (input.writer_inventory_complete !== true) blockers.push('writer_inventory_complete');
  if (blockers.length) throw failure('MIGRATION_CUTOVER_NOT_READY', 'cutover prerequisites are incomplete', { blockers });
  return Object.freeze({ verified: true, ...input });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

export async function buildMigrationSemanticManifest(input = {}) {
  if (input.source?.frozen !== true || !input.source?.freeze_ref) {
    throw failure('MIGRATION_FROZEN_SOURCE_REQUIRED', 'semantic manifest requires a frozen source boundary');
  }
  if (!input.census || input.census.schema !== 'migration-source-census-v2') {
    throw failure('MIGRATION_SOURCE_CENSUS_REQUIRED', 'semantic manifest requires the classified source census');
  }
  if (input.accounting?.unclassified?.length || input.accounting?.unmatched?.length) {
    throw failure('MIGRATION_SEMANTIC_ACCOUNTING_MISMATCH', 'semantic accounting contains unclassified or unmatched truth', { accounting: input.accounting });
  }
  if (input.recovery?.github_seed_verified !== true || input.recovery?.empty_target_reconstruction_verified !== true) {
    throw failure('MIGRATION_RECOVERY_VERIFICATION_REQUIRED', 'GitHub recovery on an empty canonical target is required');
  }
  if (Number(input.recovery?.unresolved_non_github_effects ?? -1) !== 0) {
    throw failure('MIGRATION_NON_GITHUB_EFFECT_UNRESOLVED', 'non-GitHub external effects remain unresolved');
  }
  const revision = String(input.target?.authority_revision || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision) || !input.target?.schema_ref) {
    throw failure('MIGRATION_TARGET_IDENTITY_REQUIRED', 'target schema and exact source revision are required');
  }
  if (input.runtime?.verified !== true || input.runtime?.project_inspect_verified !== true || input.runtime?.safe_semantic_operation_verified !== true) {
    throw failure('MIGRATION_RUNTIME_VERIFICATION_REQUIRED', 'target runtime verification is incomplete');
  }
  if (input.writer_cutover?.source_frozen !== true || input.writer_cutover?.target_writer_enabled !== true || input.writer_cutover?.authoritative_writer_count !== 1) {
    throw failure('MIGRATION_SINGLE_WRITER_REQUIRED', 'exactly one authoritative target writer must be proven');
  }
  const body = {
    schema: 'migration-semantic-manifest-v2',
    source: input.source,
    census: input.census,
    target: { ...input.target, authority_revision: revision },
    recovery: input.recovery,
    accounting: input.accounting || { unclassified: [], unmatched: [] },
    runtime: input.runtime,
    writer_cutover: input.writer_cutover,
    ...(input.archive ? { archive: input.archive } : {}),
  };
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}