import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedEvidenceProjection } from '../lib/bounded-evidence.js';
import { deriveMutationCertainty, projectExecutionEvidence } from '../lib/execution-evidence.js';
import { createPostgresExecutionEvidenceStore } from '../lib/execution-evidence-store.js';

test('bounded evidence uses stable object-key ordering', () => {
  const left = boundedEvidenceProjection({ z: 1, a: 2, nested: { y: 3, b: 4 } });
  const right = boundedEvidenceProjection({ a: 2, z: 1, nested: { b: 4, y: 3 } });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test('horizon authority observation survives a claim failure before lease creation', () => {
  const projected = projectExecutionEvidence({
    run: { run_id: 'run-horizon', status: 'finished', disposition: 'blocked' },
    horizons: [{
      horizon_id: 'h-1',
      run_id: 'run-horizon',
      generation: 1,
      created_at: '2026-08-27T16:00:00Z',
      candidates: [{
        position: 1,
        work_ref: 'LJH-466',
        expected_state: 'Todo',
        expected_lane: 'source-implementation',
        repository: 'laurajoyhutchins/overcenter',
        authoritative_revision: '2026-08-27T14:19:05.091Z',
        execution_fingerprint: 'f'.repeat(64),
      }],
    }],
    leases: [], checkpoints: [], heartbeats: [], resolutions: [], verifications: [],
    invocations: [{
      invocation_id: 'claim-failed', sequence: 1, command: 'work.claim', outcome: 'failed',
      error_code: 'REQUEST_INVALID', may_have_mutated: false,
    }],
  });

  assert.equal(projected.leases.length, 0);
  assert.equal(projected.settlements.length, 0);
  assert.equal(projected.commands[0].effect.mutation_certainty, 'definitively_absent');
  assert.deepEqual(projected.work_observations, [{
    work_ref: 'LJH-466',
    authority: 'linear',
    revision: '2026-08-27T14:19:05.091Z',
    execution_fingerprint: 'f'.repeat(64),
    state: 'Todo',
    lane: 'source-implementation',
    repository: 'laurajoyhutchins/overcenter',
    observation_role: 'horizon',
    source_ref: 'horizon:h-1:candidate:1',
  }]);
});

test('store loads exact-run horizon evidence', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM orchestration_runs/i.test(sql)) return { rows: [{ run_id: 'run-horizon' }] };
      if (/FROM orchestration_horizons/i.test(sql)) return { rows: [{ horizon_id: 'h-1', run_id: 'run-horizon', generation: 1, candidates: [] }] };
      if (/FROM work_leases/i.test(sql)) return { rows: [] };
      if (/work_lease_checkpoints|work_lease_heartbeats|orchestration_invocation_resolutions|portfolio_verification_receipts/i.test(sql)) return { rows: [] };
      if (/FROM orchestration_command_invocations/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const source = await createPostgresExecutionEvidenceStore(db).loadRunEvidence('run-horizon');
  assert.equal(source.horizons.length, 1);
  const horizonCall = calls.find((call) => /FROM orchestration_horizons/i.test(call.sql));
  assert.ok(horizonCall);
  assert.match(horizonCall.sql, /run_id\s*=\s*\$1/i);
  assert.deepEqual(horizonCall.params, ['run-horizon']);
});

test('mutation confirmation is command-aware rather than generic verified-field inference', () => {
  assert.equal(deriveMutationCertainty({
    invocation_id: 'unknown-1', command: 'future.external_mutator', outcome: 'succeeded',
    may_have_mutated: true, result_projection: { verified: true },
  }, []), 'unknown');

  assert.equal(deriveMutationCertainty({
    invocation_id: 'metadata-1', command: 'github.repository_metadata.ensure', outcome: 'succeeded',
    may_have_mutated: true, result_projection: { changed: true, verified: true },
  }, []), 'confirmed_present');

  assert.equal(deriveMutationCertainty({
    invocation_id: 'start-1', command: 'orchestration.start', outcome: 'succeeded',
    may_have_mutated: false, result_projection: { status: 'active' },
  }, []), 'not_applicable');
});
