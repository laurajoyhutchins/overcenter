import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

test('execution_state stores one fenced current execution subject', async () => {
  const sql = await migration('053_execution_state.sql');
  assert.match(sql, /subject_key\s+text\s+primary\s+key/i);
  assert.match(sql, /subject_kind\s+text\s+not\s+null/i);
  assert.match(sql, /authority_epoch\s+bigint\s+not\s+null/i);
  assert.match(sql, /authority_epoch\s*>?=\s*0|authority_epoch\)\s*>=\s*0/i);
  assert.match(sql, /lease_ref\s+uuid\s+unique/i);
  assert.match(sql, /run_id\s+text\s+references\s+orchestration_runs\s*\(run_id\)/i);
  assert.match(sql, /jsonb_array_length\s*\(recent_progress_sha256\)\s*<=\s*2/i);
  assert.match(sql, /lease_ref\s+is\s+null[\s\S]*run_id\s+is\s+not\s+null[\s\S]*authority_repository\s+is\s+not\s+null[\s\S]*authority_revision\s+is\s+not\s+null[\s\S]*expires_at\s+is\s+not\s+null[\s\S]*hard_expires_at\s+is\s+not\s+null/i);
});

test('operation_state enforces canonical idempotency and mutation certainty', async () => {
  const sql = await migration('054_operation_state.sql');
  assert.match(sql, /unique\s*\(\s*command\s*,\s*idempotency_scope\s*,\s*idempotency_key\s*\)/i);
  assert.match(sql, /request_sha256\s+text\s+not\s+null/i);
  assert.match(sql, /run_id\s+text\s+references\s+orchestration_runs\s*\(run_id\)/i);
  assert.match(sql, /state\s+text\s+not\s+null\s+check\s*\(state\s+in\s*\(\s*'prepared'\s*,\s*'indeterminate'\s*,\s*'succeeded'\s*,\s*'no_effect'\s*,\s*'rejected'\s*\)\s*\)/i);
  assert.match(sql, /state\s*<>\s*'no_effect'[\s\S]*may_have_mutated\s*=\s*false/i);
  assert.match(sql, /state\s*<>\s*'rejected'[\s\S]*may_have_mutated\s*=\s*false/i);
  assert.match(sql, /state\s*<>\s*'succeeded'[\s\S]*not\s+may_have_mutated[\s\S]*effect_ref\s+is\s+not\s+null/i);
  assert.match(sql, /state\s*<>\s*'indeterminate'[\s\S]*resolved_at\s+is\s+null/i);
  assert.match(sql, /state\s+in\s*\(\s*'prepared'\s*,\s*'indeterminate'\s*\)[\s\S]*recovery_payload\s+is\s+null/i);
});

test('proof_state is semantic-subject-scoped and exact-revision keyed', async () => {
  const sql = await migration('055_proof_state.sql');
  assert.match(sql, /subject_key\s+text\s+not\s+null/i);
  assert.doesNotMatch(sql, /subject_key\s+text\s+not\s+null\s+references\s+execution_state/i);
  assert.match(sql, /authority_repository\s+text\s+not\s+null/i);
  assert.match(sql, /authority_revision\s+text\s+not\s+null/i);
  assert.match(sql, /proof_state_exact_authority_idx[\s\S]*predicate_kind\s*,\s*authority_repository\s*,\s*authority_revision/i);
});

test('orchestration_runs receives only compact current and terminal pointers', async () => {
  const sql = await migration('056_orchestration_run_compaction.sql');
  assert.match(sql, /active_subject_key\s+text/i);
  assert.match(sql, /unresolved_operation_id\s+uuid/i);
  assert.match(sql, /final_effect_refs\s+jsonb/i);
  assert.match(sql, /final_evidence_sha256\s+text/i);
});

test('orchestration_runs stores one bounded current failure register instead of failure history', async () => {
  const sql = await migration('058_orchestration_run_current_failure.sql');
  assert.match(sql, /current_failure_command\s+text/i);
  assert.match(sql, /current_failure_error_code\s+text/i);
  assert.match(sql, /current_failure_error_class\s+text/i);
  assert.match(sql, /current_failure_retryable\s+boolean/i);
  assert.match(sql, /current_failure_rejection\s+boolean/i);
  assert.match(sql, /current_failure_may_have_mutated\s+boolean/i);
  assert.match(sql, /current_failure_streak\s+integer\s+not\s+null\s+default\s+0/i);
  assert.match(sql, /current_failure_streak\s*>=\s*0/i);
  assert.doesNotMatch(sql, /orchestration_command_invocations|recent_failures|failure_history/i);
});