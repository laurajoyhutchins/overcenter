import { createHash } from 'node:crypto';

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

const tables = Object.freeze({
  execution_state: { disposition: 'TRANSFORM', reason: 'RUNTIME_EPOCH_RESET' },
  github_changeset_receipts: { disposition: 'TRANSFORM', reason: 'CANONICAL_EFFECT_EVIDENCE' },
  github_production_promotion_receipts: { disposition: 'TRANSFORM', reason: 'CANONICAL_EFFECT_EVIDENCE' },
  github_release_receipts: { disposition: 'TRANSFORM', reason: 'CANONICAL_EFFECT_EVIDENCE' },
  github_required_check_observations: { disposition: 'DISCARD', reason: 'DERIVED_STATE' },
  operation_state: { disposition: 'PRESERVE', reason: 'CURRENT_KERNEL_TRUTH' },
  orchestration_command_invocations: { disposition: 'TRANSFORM', reason: 'CANONICAL_RECOVERY_EVIDENCE' },
  orchestration_horizons: { disposition: 'DISCARD', reason: 'DERIVED_STATE' },
  orchestration_invocation_resolutions: { disposition: 'TRANSFORM', reason: 'CANONICAL_RECOVERY_EVIDENCE' },
  orchestration_runs: { disposition: 'TRANSFORM', reason: 'RUNTIME_EPOCH_RESET' },
  orchestration_skill_activations: { disposition: 'ARCHIVE', reason: 'LEGACY_HISTORY_ONLY' },
  overcenter_authority_freeze: { disposition: 'DISCARD', reason: 'CUTOVER_CONTROL_STATE' },
  portfolio_reconcile_receipts: { disposition: 'ARCHIVE', reason: 'LEGACY_PROJECTION_ONLY' },
  portfolio_repository_branch_roles: { disposition: 'PRESERVE', reason: 'REPOSITORY_POLICY_TRUTH' },
  portfolio_repository_disposition: { disposition: 'PRESERVE', reason: 'REPOSITORY_POLICY_TRUTH' },
  portfolio_verification_receipts: { disposition: 'TRANSFORM', reason: 'CANONICAL_PROOF_EVIDENCE' },
  portfolio_work_identity: { disposition: 'TRANSFORM', reason: 'PROVIDER_NEUTRALIZATION' },
  proof_state: { disposition: 'PRESERVE', reason: 'CURRENT_KERNEL_TRUTH' },
  scheduled_cycle_events: { disposition: 'ARCHIVE', reason: 'LEGACY_HISTORY_ONLY' },
  work_lease_checkpoints: { disposition: 'ARCHIVE', reason: 'LEGACY_HISTORY_ONLY' },
  work_lease_heartbeats: { disposition: 'DISCARD', reason: 'EPHEMERAL_COORDINATION' },
  work_lease_slots: { disposition: 'DISCARD', reason: 'EPHEMERAL_COORDINATION' },
  work_leases: { disposition: 'TRANSFORM', reason: 'RUNTIME_EPOCH_RESET' },
  __hatchable_migrations: { disposition: 'ARCHIVE', reason: 'PROVIDER_IMPLEMENTATION_STATE' },
});

const fieldOverrides = Object.freeze({
  'execution_state.active_capability_material': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
  'work_leases.lease_token': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
  'work_leases.token_hash': { disposition: 'DISCARD', reason: 'NONTRANSFERABLE_CAPABILITY' },
});

export const SOURCE_STATE_CONTRACT = Object.freeze({
  schema: 'migration-state-contract-v1',
  census: 'hatchable-postgres-22-application-tables-plus-migration-ledger-and-cutover-control',
  tables,
  field_overrides: fieldOverrides,
});

export function classifySourceInventory(sourceTables) {
  if (!Array.isArray(sourceTables)) throw failure('MIGRATION_SOURCE_INVENTORY_REQUIRED', 'source table inventory is required');
  const normalized = [...new Set(sourceTables.map(name => String(name || '').trim()).filter(Boolean))].sort();
  const expected = Object.keys(tables).sort();
  const unclassified = normalized.filter(name => !tables[name]);
  if (unclassified.length) {
    throw failure('MIGRATION_UNCLASSIFIED_SOURCE_STATE', 'source inventory contains unclassified state', { unclassified });
  }
  const missing = expected.filter(name => !normalized.includes(name));
  if (missing.length) {
    throw failure('MIGRATION_SOURCE_CENSUS_MISMATCH', 'source inventory is missing classified state', { missing });
  }
  return Object.freeze({
    schema: 'migration-source-census-v1',
    tables: Object.freeze(normalized.map(name => Object.freeze({ table: name, ...tables[name] }))),
    count: normalized.length,
  });
}

export function assertQuiescentForFinalSnapshot(input = {}) {
  const blockers = [];
  if (input.source_mutation_frozen !== true) blockers.push('source_mutation_frozen');
  for (const field of ['active_runs', 'live_leases', 'occupied_live_slots', 'unresolved_potentially_mutating_operations', 'indeterminate_external_effects']) {
    if (Number(input[field] ?? -1) !== 0) blockers.push(field);
  }
  if (input.writer_inventory_complete !== true) blockers.push('writer_inventory_complete');
  if (input.rehearsal_verified !== true) blockers.push('rehearsal_verified');
  if (blockers.length) {
    throw failure('MIGRATION_QUIESCENCE_REQUIRED', 'final source snapshot is forbidden until all quiescence gates pass', { blockers });
  }
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
  if (input.source?.frozen !== true || !input.source?.snapshot_ref) {
    throw failure('MIGRATION_FROZEN_SOURCE_REQUIRED', 'semantic manifest requires a frozen source snapshot');
  }
  if (!input.census || input.census.schema !== 'migration-source-census-v1') {
    throw failure('MIGRATION_SOURCE_CENSUS_REQUIRED', 'semantic manifest requires the classified source census');
  }
  if (!input.archive?.object_ref || !input.archive?.digest || !Number.isInteger(input.archive?.row_count)) {
    throw failure('MIGRATION_ARCHIVE_EVIDENCE_REQUIRED', 'semantic manifest requires sealed archive identity, digest, and row count');
  }
  if (input.accounting?.unclassified?.length || input.accounting?.unmatched?.length) {
    throw failure('MIGRATION_SEMANTIC_ACCOUNTING_MISMATCH', 'semantic accounting contains unclassified or unmatched truth', { accounting: input.accounting });
  }
  if (input.recovery?.verified !== true) throw failure('MIGRATION_RECOVERY_VERIFICATION_REQUIRED', 'recovery verification is required');
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
    schema: 'migration-semantic-manifest-v1',
    source: input.source,
    census: input.census,
    target: { ...input.target, authority_revision: revision },
    archive: input.archive,
    accounting: input.accounting || { unclassified: [], unmatched: [] },
    recovery: input.recovery,
    runtime: input.runtime,
    writer_cutover: input.writer_cutover,
  };
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}