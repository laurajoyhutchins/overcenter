import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FREEZE_CONTROL_TABLE,
  FROZEN_SOURCE_TABLES,
  assertSourceFreezeReadback,
} from './migration-freeze.mjs';
import { SOURCE_STATE_CONTRACT } from './migration-semantic-manifest.mjs';

test('cutover control state is explicitly classified but never transferred as authority', () => {
  assert.deepEqual(SOURCE_STATE_CONTRACT.tables[FREEZE_CONTROL_TABLE], {
    disposition: 'DISCARD',
    reason: 'CUTOVER_CONTROL_STATE',
  });
  assert.equal(FROZEN_SOURCE_TABLES.length, 23);
  assert.equal(FROZEN_SOURCE_TABLES.includes(FREEZE_CONTROL_TABLE), false);
});

test('freeze migration guards every legacy source-state table at the database boundary', async () => {
  const sql = await readFile(new URL('../migrations/059_authoritative_state_freeze.sql', import.meta.url), 'utf8');
  for (const table of FROZEN_SOURCE_TABLES) {
    assert.match(sql, new RegExp(`BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}\\b`), table);
  }
  assert.match(sql, /OVERCENTER_SOURCE_FROZEN/);
  assert.match(sql, /OVERCENTER_SOURCE_UNFREEZE_FORBIDDEN/);
  assert.doesNotMatch(sql, /INSERT OR UPDATE OR DELETE OR TRUNCATE ON overcenter_authority_freeze/);
});

test('freeze readback fails closed unless exact revision and trigger coverage are complete', () => {
  const row = {
    frozen: true,
    frozen_at: '2026-09-07T06:00:00Z',
    source_revision: 'a'.repeat(40),
  };
  assert.throws(
    () => assertSourceFreezeReadback(row, FROZEN_SOURCE_TABLES.slice(1)),
    error => error?.code === 'MIGRATION_SOURCE_FREEZE_TRIGGER_MISMATCH',
  );
  const proof = assertSourceFreezeReadback(row, FROZEN_SOURCE_TABLES);
  assert.equal(proof.trigger_count, 23);
  assert.equal(proof.source_revision, 'a'.repeat(40));
});