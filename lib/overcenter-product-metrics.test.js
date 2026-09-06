import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOvercenterProductMetrics } from 'lib/overcenter-product-metrics.js';

const NOW='2026-09-06T03:00:00.000Z';
function snapshot(){
  return {
    runs:[
      {run_id:'r-ok',project_ref:'github:o/r',started_at:'2026-09-06T01:00:00.000Z',finished_at:'2026-09-06T01:10:00.000Z',agent_execution_boundary:true,packet_schema:'packet-v2'},
      {run_id:'r-reject',project_ref:'github:o/r',started_at:'2026-09-06T01:20:00.000Z',finished_at:'2026-09-06T01:25:00.000Z',agent_execution_boundary:true,packet_schema:null},
      {run_id:'r-old',project_ref:'github:o/r',started_at:'2026-08-01T01:00:00.000Z',finished_at:'2026-08-01T01:10:00.000Z',agent_execution_boundary:true,packet_schema:'packet-v1'},
    ],
    receipts:[
      {run_id:'r-ok',transition_id:'t-ok',disposition:'completed',settled_at:'2026-09-06T01:10:00.000Z',authority_revision:'a'.repeat(40),verified:true,first_attempt_at:'2026-09-06T01:00:00.000Z'},
    ],
    command_invocations:[
      {invocation_id:'i1',run_id:'r-ok',command:'project.advance',outcome:'succeeded',lifecycle_phase:'select',started_at:'2026-09-06T01:00:01.000Z'},
      {invocation_id:'i2',run_id:'r-ok',command:'github.apply_changeset',outcome:'succeeded',lifecycle_phase:'execute',started_at:'2026-09-06T01:02:00.000Z'},
      {invocation_id:'i3',run_id:'r-reject',command:'project.advance',outcome:'rejected',error_code:'AUTHORITY_STALE',lifecycle_phase:'select',started_at:'2026-09-06T01:20:01.000Z'},
      {invocation_id:'i4',run_id:'r-reject',command:'github.apply_changeset',outcome:'indeterminate',error_code:'UPSTREAM_AMBIGUOUS',may_have_mutated:true,lifecycle_phase:'execute',started_at:'2026-09-06T01:21:00.000Z'},
    ],
    recovery_events:[
      {recovery_id:'rec1',run_id:'r-reject',recovery_class:'authoritative_readback',completed:true,new_reasoning_boundary:false,at:'2026-09-06T01:24:00.000Z'},
    ],
    packet_outcomes:[
      {packet_id:'p1',run_id:'r-ok',packet_schema:'packet-v2',action_contract_present:true,authority_protocol_failure:false,zero_memory_conformance:true,at:'2026-09-06T01:00:00.000Z'},
      {packet_id:'p2',run_id:'r-reject',packet_schema:null,action_contract_present:false,authority_protocol_failure:true,zero_memory_conformance:null,at:'2026-09-06T01:20:00.000Z'},
    ],
  };
}

test('derives bounded production metrics with separated failure classes and drill-down exemplars',()=>{
  const result=deriveOvercenterProductMetrics(snapshot(),{window:'24h',now:NOW,exemplar_limit:3});
  assert.equal(result.schema,'overcenter-product-metrics-v1');
  assert.equal(result.window.id,'24h');
  assert.equal(result.counts.agent_execution_boundaries,2);
  assert.equal(result.counts.verified_transitions,1);
  assert.equal(result.rates.verified_transitions_per_agent_execution_boundary.value,0.5);
  assert.equal(result.failures.expected_rejection.count,1);
  assert.equal(result.failures.indeterminate_effect.count,1);
  assert.equal(result.failures.authority_staleness.count,1);
  assert.deepEqual(result.failures.expected_rejection.exemplars,['invocation:i3']);
  assert.equal(result.communication.packet_action_contract_coverage.known,2);
  assert.equal(result.communication.packet_action_contract_coverage.satisfied,1);
  assert.equal(result.communication.semantic_coordination_per_verified_transition.by_phase.select,1);
  assert.equal(result.recovery.deterministic_without_new_reasoning_boundary.count,1);
  assert.equal(result.latency.verified_transition_ms.p50,600000);
  assert.ok(result.identity_refs.includes('transition:t-ok@'+ 'a'.repeat(40)));
});

test('historical missing fields become explicit unknown coverage instead of denominator bias',()=>{
  const input=snapshot();
  input.packet_outcomes=[{packet_id:'legacy',run_id:'r-ok',at:'2026-09-06T01:00:00.000Z'}];
  const result=deriveOvercenterProductMetrics(input,{window:'24h',now:NOW});
  assert.equal(result.communication.packet_action_contract_coverage.status,'partial');
  assert.equal(result.communication.packet_action_contract_coverage.known,0);
  assert.equal(result.communication.packet_action_contract_coverage.unknown,1);
  assert.equal(result.communication.packet_action_contract_coverage.value,null);
});

test('bounded windows exclude old records and latency uses distributions, not averages',()=>{
  const result=deriveOvercenterProductMetrics(snapshot(),{window:'7d',now:NOW});
  assert.equal(result.counts.agent_execution_boundaries,2);
  assert.deepEqual(Object.keys(result.latency.verified_transition_ms).sort(),['count','p50','p95']);
});