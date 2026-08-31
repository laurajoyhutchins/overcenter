import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrationResumeService } from '../lib/orchestration-recovery.js';

test('resume packet preserves settled project-transition graph revision evidence', async () => {
  const change = {
    schema:'project-graph-revision-change-v1',
    previous_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' },
    current_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'2'.repeat(40), derivation:'overcenter-project-graph-v1' },
  };
  const lease = {
    lease_id:'00000000-0000-4000-8000-000000000555', work_ref:'github:laurajoyhutchins/overcenter#transition-a', gate:'project_transition', run_id:'run-resume-revision', status:'settled',
    created_at:'2026-08-31T02:00:00Z', expires_at:'2026-08-31T02:10:00Z',
    claim_receipt:{ subject:'project_transition', project_transition:{ project_ref:'github:laurajoyhutchins/overcenter', transition_id:'transition-a', repository:'laurajoyhutchins/overcenter', authority_revision:'1'.repeat(40), authority_derivation:'overcenter-project-graph-v1' } },
    settle_receipt:{ graph_revision_change:change },
  };
  const store = {
    async lastInvocation(){ return { invocation_id:'inv-1', sequence:1, command:'work.settle', outcome:'succeeded', result_projection:{} }; },
    async unresolvedInvocation(){ return null; },
    async latestLease(){ return lease; },
    async latestCheckpoint(){ return null; },
    async slot(){ return null; },
    async portfolioReceipt(){ return null; },
  };
  const service = createOrchestrationResumeService({ store, authoritative:{ async getIssue(){ throw new Error('legacy authority must not be read for settled graph-native lease'); } }, now:()=>'2026-08-31T02:20:00Z' });
  const packet = await service.resume({ run_id:'run-resume-revision' });
  assert.equal(packet.continuation, 'terminal_or_quiescent');
  const evidence = packet.evidence.find((entry) => entry.kind === 'project_graph_revision_change');
  assert.deepEqual(evidence?.graph_revision_change, change);
});