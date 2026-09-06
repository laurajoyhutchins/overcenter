import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOvercenterProductMetrics } from '../lib/overcenter-product-metrics.js';

const snapshot = {
  runs: [
    { run_id:'run-ok', transition_id:'t-ok', started_at:'2026-09-05T00:00:00Z', finished_at:'2026-09-05T00:00:10Z', disposition:'completed', authority_revision:'aaa', packet_schema_version:'packet-v2' },
    { run_id:'run-stale', transition_id:'t-stale', started_at:'2026-09-05T01:00:00Z', finished_at:'2026-09-05T01:00:30Z', disposition:'blocked', current_failure_error_class:'AUTHORITY_STALE', authority_revision:'bbb' },
    { run_id:'run-old', transition_id:'t-old', started_at:'2026-08-01T00:00:00Z', finished_at:'2026-08-01T00:00:05Z', disposition:'completed', authority_revision:'ccc' },
  ],
  invocations: [
    { run_id:'run-ok', command:'project.advance', started_at:'2026-09-05T00:00:00Z', outcome:'completed', result_projection:{ outcome:'AGENT_EXECUTION_REQUIRED' } },
    { run_id:'run-ok', command:'github.apply_changeset', started_at:'2026-09-05T00:00:05Z', outcome:'completed' },
    { run_id:'run-stale', command:'project.advance', started_at:'2026-09-05T01:00:00Z', outcome:'rejected', error_class:'AUTHORITY_STALE', rejection:true, may_have_mutated:false },
  ],
  settlements: [
    { run_id:'run-ok', transition_id:'t-ok', disposition:'completed', settled_at:'2026-09-05T00:00:10Z', evidence_refs:[{kind:'commit',ref:'sha:1'}] },
  ],
  packets: [
    { run_id:'run-ok', transition_id:'t-ok', schema_version:'packet-v2', complete:true, authority_revision:'aaa', zero_memory_conformance:true },
    { run_id:'run-stale', transition_id:'t-stale', schema_version:null, complete:false, authority_revision:null, authority_protocol_failure:true, zero_memory_conformance:null },
  ],
  recoveries: [
    { run_id:'run-stale', deterministic:true, new_reasoning_boundary:false, created_at:'2026-09-05T01:00:20Z' },
  ],
};

test('derives bounded deterministic metrics with classified failures, coverage unknowns, and drill-down exemplars', () => {
  const result = deriveOvercenterProductMetrics(snapshot, { now:'2026-09-06T00:00:00Z', windows:['24h','7d','30d'], exemplar_limit:3 });
  assert.equal(result.schema, 'overcenter-product-metrics-v1');
  assert.equal(result.windows['24h'].verified_transitions.count, 1);
  assert.equal(result.windows['24h'].agent_execution_boundaries.count, 2);
  assert.equal(result.windows['24h'].verified_transitions_per_agent_execution_boundary.value, 0.5);
  assert.deepEqual(result.windows['24h'].failure_classes, { expected_rejection:0, execution_failure:0, mutation_indeterminate:0, authority_staleness:1, agent_reasoning_escalation:0 });
  assert.equal(result.windows['24h'].packet_contract.coverage_known, 1);
  assert.equal(result.windows['24h'].packet_contract.coverage_unknown, 1);
  assert.equal(result.windows['24h'].packet_contract.authority_protocol_failures.count, 1);
  assert.equal(result.windows['24h'].semantic_coordination_commands.per_verified_transition.before_acquisition, 2);
  assert.equal(result.windows['24h'].recovery.deterministic_without_new_reasoning_boundary, 1);
  assert.equal(result.windows['24h'].contract_health.fresh_session_zero_memory_conformance.passed, 1);
  assert.equal(result.windows['24h'].contract_health.fresh_session_zero_memory_conformance.unknown, 1);
  assert.match(result.windows['24h'].contract_health.fresh_session_zero_memory_conformance.note, /Contract-health/);
  assert.deepEqual(result.windows['24h'].latency_ms.completed_transition.p50, 10000);
  assert.equal(result.windows['24h'].exemplars.verified_transitions[0].run_id, 'run-ok');
  assert.equal(result.windows['24h'].exemplars.authority_staleness[0].authority_revision, 'bbb');
  assert.equal(result.windows['30d'].verified_transitions.count, 1, 'records outside the 30d window must not leak in');
  assert.deepEqual(result, deriveOvercenterProductMetrics(snapshot, { now:'2026-09-06T00:00:00Z', windows:['24h','7d','30d'], exemplar_limit:3 }));
});

test('reports unknown historical coverage instead of biasing denominators', () => {
  const result = deriveOvercenterProductMetrics({ runs:[{run_id:'legacy',started_at:'2026-09-05T02:00:00Z'}], invocations:[], settlements:[], packets:[], recoveries:[] }, { now:'2026-09-06T00:00:00Z', windows:['24h'] });
  assert.equal(result.windows['24h'].verified_transitions.coverage_unknown, 1);
  assert.equal(result.windows['24h'].packet_contract.coverage_unknown, 1);
  assert.equal(result.windows['24h'].verified_transitions_per_agent_execution_boundary.value, null);
});