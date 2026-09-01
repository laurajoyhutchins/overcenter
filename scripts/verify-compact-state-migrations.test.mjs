import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function migration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

test('execution_state persists one fenced current row per subject', async () => {
  const sql = await migration('053_execution_state.sql');
  assert.match(sql, /subject_key\s+text\s+primary key/i);
  assert.match(sql, /authority_epoch\s+bigint\s+not null/i);
  assert.match(sql, /lease_ref\s+text\s+unique/i);
  assert.match(sql, /jsonb_array_length\(recent_progress_sha256\)\s*<=\s*2/i);
  assert.match(sql, /lease_ref is null\s+or/i);
});

test('operation_state uses the approved semantic idempotency identity', async () => {
  const sql = await migration('054_operation_state.sql');
  assert.match(sql, /unique\s*\(command,\s*idempotency_scope,\s*idempotency_key\)/i);
  assert.match(sql, /request_sha256\s+text\s+not null/i);
  assert.match(sql, /state\s+text\s+not null/i);
  assert.match(sql, /indeterminate/i);
  assert.match(sql, /recovery_payload/i);
});

test('proof_state is exact-revision keyed evidence', async () => {
  const sql = await migration('055_proof_state.sql');
  assert.match(sql, /authority_repository\s+text\s+not null/i);
  assert.match(sql, /authority_revision\s+text\s+not null/i);
  assert.match(sql, /proof_state_exact_authority_idx/i);
});

test('run compaction adds only compact current and terminal pointers', async () => {
  const sql = await migration('056_orchestration_run_compaction.sql');
  for (const column of ['active_subject_key', 'unresolved_operation_id', 'final_effect_refs', 'final_evidence_sha256']) {
    assert.match(sql, new RegExp(`add column(?: if not exists)? ${column}\\b`, 'i'), column);
  }
});
