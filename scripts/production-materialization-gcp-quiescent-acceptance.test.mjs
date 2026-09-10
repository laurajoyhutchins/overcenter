import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createCloudRunAuthorityProofInspector } from './cloud-run-authority-proof-runtime.mjs';

const proofScript = await readFile(new URL('./gcp/prove-authoritative-runtime-http.sh', import.meta.url), 'utf8');

function quiescentDb(activeTransitionLeases = []) {
  const client = {
    async query(sql, params = []) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes("claim_receipt->>'subject'='project_transition'")) {
        assert.match(sql, /gate='project_transition'/, 'quiescent proof must use the canonical project-transition lease gate');
        assert.deepEqual(params, ['github:laurajoyhutchins/overcenter']);
        return { rows: activeTransitionLeases };
      }
      if (sql.includes("to_regclass('overcenter_authority_freeze')")) {
        return {
          rows: [{
            freeze_table: null,
            freeze_function: null,
            freeze_triggers: 0,
            source_only_migrations: 0,
          }],
        };
      }
      throw new Error(`unexpected quiescent proof query: ${sql}`);
    },
    release() {},
  };
  return { async connect() { return client; } };
}

test('authority proof inspector supports a project-wide quiescent lease proof', async () => {
  const inspect = createCloudRunAuthorityProofInspector({ db: quiescentDb([
    {
      lease_id: 'lease-active',
      run_id: 'run-active',
      status: 'active',
      created_at: '2026-09-10T17:00:00Z',
      expires_at: '2026-09-10T18:00:00Z',
    },
  ]) });

  const proof = await inspect({
    phase: 'quiescent',
    project_ref: 'github:laurajoyhutchins/overcenter',
  });

  assert.equal(proof.phase, 'quiescent');
  assert.equal(proof.transition_id, null);
  assert.equal(proof.run, null);
  assert.equal(proof.counts.active_transition_leases, 1);
  assert.equal(proof.active_transition_leases[0].lease_id, 'lease-active');
});

test('deployment verifier accepts quiescence only after proving zero active transition leases', () => {
  assert.match(proofScript, /phase:\"quiescent\"/);
  assert.match(proofScript, /counts\.active_transition_leases == 0/);
  assert.match(proofScript, /Acceptance mode: quiescent/);
  assert.doesNotMatch(proofScript, /No reversible available non-migration transition exists for the GCP acceptance probe/);
});
