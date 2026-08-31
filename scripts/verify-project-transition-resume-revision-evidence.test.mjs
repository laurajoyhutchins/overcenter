import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrationTargetResumePacket } from '../lib/orchestration-run-target-runtime.js';

test('target resume packet preserves settled project-transition graph revision evidence', async () => {
  const change = {
    schema:'project-graph-revision-change-v1',
    previous_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' },
    current_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'2'.repeat(40), derivation:'overcenter-project-graph-v1' },
  };
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("claim_receipt->>'subject' = 'project_transition'")) return { rows:[{ settle_receipt:{ graph_revision_change:change } }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const packet = await orchestrationTargetResumePacket({ run_id:'run-resume-revision' }, {
    db,
    baseStore:{},
    store:{ async getRun(){ return null; } },
    resumeService:{ async resume(){ return { ok:true, run_id:'run-resume-revision', continuation:'terminal_or_quiescent', evidence:[], historical_correlation_missing:false }; } },
    skillService:{ async state(){ return { ok:true, run_id:'run-resume-revision', activations:[] }; } },
  });
  assert.equal(packet.continuation, 'terminal_or_quiescent');
  assert.equal(packet.target, null);
  const evidence = packet.evidence.find((entry) => entry.kind === 'project_graph_revision_change');
  assert.deepEqual(evidence?.graph_revision_change, change);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ['run-resume-revision']);
});