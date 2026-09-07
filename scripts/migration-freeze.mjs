import { SOURCE_STATE_CONTRACT } from './migration-semantic-manifest.mjs';

export const FREEZE_CONTROL_TABLE = 'overcenter_authority_freeze';
export const FROZEN_SOURCE_TABLES = Object.freeze(
  Object.keys(SOURCE_STATE_CONTRACT.tables)
    .filter(name => name !== FREEZE_CONTROL_TABLE)
    .sort(),
);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function assertSourceFreezeReadback(row, triggerTables) {
  if (!row || row.frozen !== true || !row.frozen_at) {
    throw failure('MIGRATION_SOURCE_FREEZE_NOT_PROVEN', 'source freeze control row is not durably frozen');
  }
  const revision = String(row.source_revision || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw failure('MIGRATION_SOURCE_FREEZE_REVISION_REQUIRED', 'source freeze must record an exact Git revision');
  }
  const observed = [...new Set((triggerTables || []).map(value => String(value || '').trim()).filter(Boolean))].sort();
  const missing = FROZEN_SOURCE_TABLES.filter(name => !observed.includes(name));
  const unexpected = observed.filter(name => !FROZEN_SOURCE_TABLES.includes(name));
  if (missing.length || unexpected.length) {
    throw failure('MIGRATION_SOURCE_FREEZE_TRIGGER_MISMATCH', 'source freeze trigger coverage is incomplete', { missing, unexpected });
  }
  return Object.freeze({
    schema: 'migration-source-freeze-proof-v1',
    frozen: true,
    frozen_at: row.frozen_at,
    source_revision: revision,
    trigger_count: observed.length,
  });
}