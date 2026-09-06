import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERCENTER_METRICS_CONTRACT,
  assertMetricObservation,
} from '../lib/overcenter-metrics-contract.js';

test('top-level metric is verified transitions per agent execution boundary', () => {
  assert.equal(OVERCENTER_METRICS_CONTRACT.primary_metric.id, 'verified_project_transitions_per_agent_execution_boundary');
  assert.equal(OVERCENTER_METRICS_CONTRACT.primary_metric.numerator, 'verified_project_transition');
  assert.equal(OVERCENTER_METRICS_CONTRACT.primary_metric.denominator, 'agent_execution_boundary');
});

test('required metric families retain drill-down identity and coverage semantics', () => {
  const required = [
    'first_pass_success_rate', 'verified_transition_throughput', 'operator_action_required_rate',
    'administrative_semantic_commands_per_verified_transition', 'failure_rate', 'rejection_rate',
    'indeterminate_rate', 'automatic_recovery_success_rate',
    'deterministic_recovery_without_new_reasoning_boundary_rate', 'transition_latency_p50',
    'transition_latency_p95', 'authoring_wait_started', 'authoring_auto_reconciled',
    'authoring_manual_replay_required', 'authoring_wait_age', 'authoring_recompute_required',
    'packet_action_contract_schema_coverage', 'semantic_coordination_round_trips_per_verified_transition',
    'packet_authority_protocol_failure_rate',
  ];
  for (const id of required) {
    const metric = OVERCENTER_METRICS_CONTRACT.metrics[id];
    assert.ok(metric, `missing metric ${id}`);
    assert.ok(metric.identity && metric.coverage, `metric ${id} lacks identity/coverage semantics`);
  }
});

test('authoring reconciliation trigger is a dimension, never authority', () => {
  const metric = OVERCENTER_METRICS_CONTRACT.metrics.authoring_auto_reconciled;
  assert.ok(metric.dimensions.includes('reconciliation_trigger'));
  assert.equal(OVERCENTER_METRICS_CONTRACT.dimensions.reconciliation_trigger.values.join(','), 'event,maintenance,caller');
  assert.equal(OVERCENTER_METRICS_CONTRACT.dimensions.reconciliation_trigger.authoritative, false);
});

test('existing durable sources and new instrumentation needs are explicit', () => {
  const sources = OVERCENTER_METRICS_CONTRACT.authoritative_sources;
  for (const id of ['runs','command_invocations','execution_operation_proof_state','scheduled_cycle_events','receipts','graph_state','authoring_operation_state','packet_outcomes']) {
    assert.equal(sources[id]?.authoritative, true, `source ${id} is not authoritative`);
  }
  assert.ok(Array.isArray(OVERCENTER_METRICS_CONTRACT.new_instrumentation_required));
});

test('ambiguous denominator, identity, and historical coverage fail closed', () => {
  for (const observation of [
    { metric_id:'first_pass_success_rate', numerator:1, denominator:null, identity:{ project_ref:'github:x/y' }, coverage:{ status:'complete' } },
    { metric_id:'first_pass_success_rate', numerator:1, denominator:1, identity:null, coverage:{ status:'complete' } },
    { metric_id:'first_pass_success_rate', numerator:1, denominator:1, identity:{ project_ref:'github:x/y' }, coverage:{ status:'unknown' } },
  ]) {
    assert.throws(() => assertMetricObservation(observation));
  }
});