import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_LOCK_TABLES,
  captureGitHubRecoverySeed,
  freezeSourceAtRecoveryCoordinates,
} from '../lib/authoritative-state-cutover.js';

const projectRef = 'github:laurajoyhutchins/overcenter';

function captureDb() {
  let call = 0;
  return {
    async query() {
      call += 1;
      if (call === 1) return { rows:[{
        transition_id:'alpha-newer',
        transition_definition_fingerprint:'b'.repeat(64),
        source_authority_revision:'a'.repeat(40),
        settled_at:'2026-09-07T05:00:00Z',
      }, {
        transition_id:'zulu-older',
        transition_definition_fingerprint:'c'.repeat(64),
        source_authority_revision:'d'.repeat(40),
        settled_at:'2026-09-06T01:00:00Z',
      }] };
      if (call === 2) return { rows:[{
        repository:'laurajoyhutchins/overcenter', development_branch:'dev', production_branch:'main',
        production_source_ref:'runtime:production-source-materialization', updated_at:'2026-09-07T02:00:00Z',
      }] };
      return { rows:[{
        repository:'laurajoyhutchins/overcenter', disposition:'ACTIVE', compatibility_bound:false,
        successor_repository:null, github_archived:false, transition_reason:null, compatibility_reference:null,
        github_repository_id:'1339925321', updated_at:'2026-09-07T03:00:00Z',
      }] };
    },
  };
}

test('capture produces compact GitHub recovery truth and exact source coordinates', async () => {
  const result = await captureGitHubRecoverySeed({ db:captureDb(), project_ref:projectRef });
  assert.equal(result.seed.transition_confirmations.length, 2);
  assert.equal(result.seed.repository_branch_roles.length, 1);
  assert.equal(result.seed.repository_dispositions.length, 1);
  assert.equal(result.coordinates.transition_confirmations_count, 2);
  assert.equal(result.coordinates.transition_confirmations_max_settled_at, '2026-09-07T05:00:00Z');
  assert.equal(result.coordinates.branch_roles_max_updated_at, '2026-09-07T02:00:00Z');
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.seed.digest, result.digest);
});

test('freeze locks the entire source state surface before atomically checking captured coordinates', async () => {
  let statements = null;
  const db = {
    async transaction(input) {
      statements = input;
      return { results:[{}, { rows:[{
        frozen:true, frozen_at:'2026-09-07T04:00:00Z', source_revision:'a'.repeat(40), freeze_manifest_sha256:`sha256:${'c'.repeat(64)}`,
      }] }] };
    },
  };
  const result = await freezeSourceAtRecoveryCoordinates({
    db,
    project_ref:projectRef,
    source_revision:'a'.repeat(40),
    seed_digest:`sha256:${'c'.repeat(64)}`,
    coordinates:{
      transition_confirmations_count:96,
      transition_confirmations_max_settled_at:'2026-09-07T03:00:00Z',
      branch_roles_count:1,
      branch_roles_max_updated_at:'2026-09-07T02:00:00Z',
      repository_dispositions_count:3,
      repository_dispositions_max_updated_at:'2026-09-07T01:00:00Z',
    },
  });
  assert.match(statements[0].sql, /^LOCK TABLE /);
  for (const table of SOURCE_LOCK_TABLES) assert.match(statements[0].sql, new RegExp(`\\b${table}\\b`));
  assert.match(statements[1].sql, /UPDATE overcenter_authority_freeze/);
  assert.match(statements[1].sql, /IS NOT DISTINCT FROM/);
  assert.match(statements[1].sql, /NOT EXISTS\s*\(\s*SELECT 1\s+FROM work_leases\s+WHERE status IN \('claiming', 'active', 'settling'\)\s+AND expires_at > now\(\)/);
  assert.equal(result.frozen, true);
  assert.equal(result.locked_tables, SOURCE_LOCK_TABLES.length);
});

test('coordinate drift fails closed rather than freezing against a stale GitHub seed', async () => {
  const db = { transaction:async () => ({ results:[{}, { rows:[] }] }) };
  await assert.rejects(() => freezeSourceAtRecoveryCoordinates({
    db,
    project_ref:projectRef,
    source_revision:'a'.repeat(40),
    seed_digest:`sha256:${'c'.repeat(64)}`,
    coordinates:{
      transition_confirmations_count:0,
      transition_confirmations_max_settled_at:null,
      branch_roles_count:0,
      branch_roles_max_updated_at:null,
      repository_dispositions_count:0,
      repository_dispositions_max_updated_at:null,
    },
  }), error => error?.code === 'CUTOVER_FREEZE_PRECONDITION_MISMATCH' && error?.mayHaveMutated === false);
});
