import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOvercenterProductMetrics } from '../lib/overcenter-product-metrics.js';

const NOW = '2026-09-06T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const ago = hours => new Date(Date.parse(NOW) - hours * HOUR).toISOString();

const snapshot = {
  runs: [
    { run_id:'r1', project_ref:'github:acme/widgets', started_at:ago(5), finished_at:ago(4), agent_execution_boundary:true, packet_schema:'packet-v2' },
    { run_id:'r2', project_ref:'github:acme/widgets', started_at:ago(3), finished_at:ago(2), agent_execution_boundary:true, packet_schema:null },
    { run_id:'r-old', project_ref:'github:acme/widgets', started_at:ago(200), finished_at:ago(199), agent_execution_boundary:true, packet_schema:'packet-v1' },
  ],
  receipts: [
    { receipt_id:'rc1', run_id:'r1', transition_id:'t1', project_ref:'github:acme/widgets', verified:true, first_executable_at:ago(5), confirmed_at:ago(4), evidence_refs:['sha:aaa'] },
  ],
  command_invocations: [
    { invocation_id:'c1', run_id:'r1', command:'project.advance', phase:'select', outcome:'succeeded', observed_at:ago(5) },
    { invocation_id:'c2', run_id:'r1', command:'github.apply_changeset', phase:'execute', outcome:'rejected', observed_at:ago(4.8), error_class:'expected_rejection' },
    { invocation_id:'c3', run_id:'r2', command:'github.apply_changeset', phase:'execute', outcome:'failed', observed_at:ago(2.8), error_class:'execution_failure' },
    { invocation_id:'c4', run_id:'r2', command:'github.apply_changeset', phase:'recover', outcome:'indeterminate', observed_at:ago(2.7), error_class:'mutation_indeterminate' },
  ],
  recovery_events: [
    { recovery_id:'rec1', run_id:'r1', recovery_class:'reconcile', deterministic:true, completed:true, new_reasoning_boundary:false, observed_at:ago(4.5) },
    { recovery_id:'rec2', run_id:'r2', recovery_class:'reconcile', deterministic:true, completed:true, new_reasoning_boundary:true, observed_at:ago(2.5) },
  ],
  packet_outcomes: [
    { packet_id:'p1', run_id:'r1', packet_schema:'packet-v2', action_contract_schema:'action-v1', authority_revision:'aaa', outcome:'accepted', observed_at:ago(5) },
    { packet_id:'p2', run_id:'r2', packet_schema:null, action_contract_schema:null, authority_revision:null, outcome:'authority_failure', observed_at:ago(3) },
  ],
  waits: [
    { wait_id:'w1', transition_id:'t2', project_ref:'github:acme/widgets', reason:'ci', started_at:ago(10), resolved_at:null },
  ],
};

test('derives bounded product metrics with distributions, explicit failure taxonomy, and drill-down exemplars', () => {
  const result = deriveOvercenterProductMetrics(snapshot, { now:NOW, windows:['24h','7d','30d'], exemplar_limit:3 });
  const day = result.windows['24h'];
  assert.equal(day.agent_execution_boundaries.value, 2);
  assert.equal(day.verified_transition_throughput.value, 1);
  assert.equal(day.verified_project_transitions_per_agent_execution_boundary.value, 0.5);
  assert.equal(day.failure_taxonomy.expected_rejection.value, 1);
  assert.equal(day.failure_taxonomy.execution_failure.value, 1);
  assert.equal(day.failure_taxonomy.mutation_indeterminate.value, 1);
  assert.equal(day.packet_action_contract_schema_coverage.value, 0.5);
  assert.equal(day.deterministic_recovery_without_new_reasoning_boundary_rate.value, 0.5);
  assert.equal(day.transition_latency_ms.p50, HOUR);
  assert.equal(day.stuck_age_ms.p50, 10 * HOUR);
  assert.deepEqual(day.failure_taxonomy.execution_failure.exemplars[0], { run_id:'r2', command:'github.apply_changeset', invocation_id:'c3' });
});

test('historical missing fields are unknown coverage instead of zero-filled denominators', () => {
  const result = deriveOvercenterProductMetrics({ runs:[{ run_id:'legacy', started_at:ago(1), agent_execution_boundary:true }], receipts:[], command_invocations:[], packet_outcomes:[] }, { now:NOW, windows:['24h'] });
  const day = result.windows['24h'];
  assert.equal(day.packet_action_contract_schema_coverage.coverage.status, 'unknown');
  assert.equal(day.packet_action_contract_schema_coverage.value, null);
});

test('derivation is deterministic, read-only, and labels zero-memory conformance outside production rates', () => {
  const withConformance = { ...snapshot, zero_memory_conformance:[{ case_id:'z1', packet_schema:'packet-v2', passed:true, observed_at:ago(1) }] };
  const before = JSON.stringify(withConformance);
  const first = deriveOvercenterProductMetrics(withConformance, { now:NOW, windows:['24h'] });
  const second = deriveOvercenterProductMetrics(withConformance, { now:NOW, windows:['24h'] });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(withConformance), before);
  assert.equal(first.contract_health.zero_memory_conformance.passed, 1);
  assert.equal(first.windows['24h'].agent_execution_boundaries.value, 2);
});