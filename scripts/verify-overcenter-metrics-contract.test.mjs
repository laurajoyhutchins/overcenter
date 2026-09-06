import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERCENTER_METRICS_CONTRACT_V1,
  evaluateRatioMetric,
  summarizeLatencyMetric,
} from '../lib/overcenter-metrics-contract.js';

const requiredMetricIds = [
  'verified_project_transitions_per_agent_execution_boundary',
  'first_pass_success_rate',
  'verified_transition_throughput',
  'operator_action_required_rate',
  'administrative_semantic_commands_per_verified_transition',
  'failure_rate',
  'rejection_rate',
  'indeterminate_rate',
  'automatic_recovery_success_rate',
  'deterministic_recovery_without_new_reasoning_boundary_rate',
  'transition_latency',
  'recovery_latency',
  'authoring_wait_started',
  'authoring_auto_reconciled',
  'authoring_manual_replay_required',
  'authoring_wait_age',
  'authoring_recompute_required',
  'packet_action_contract_schema_coverage',
  'semantic_coordination_round_trips_per_verified_transition',
  'recovery_reasoning_boundary_reentry_rate',
  'authority_protocol_packet_failure_rate',
  'fresh_session_zero_memory_conformance',
];

test('declares the required product, friction, recovery, authoring, latency, and communication metrics', () => {
  const contract = OVERCENTER_METRICS_CONTRACT_V1;
  assert.equal(contract.schema, 'overcenter-metrics-contract-v1');
  assert.equal(contract.top_level_metric, 'verified_project_transitions_per_agent_execution_boundary');
  const ids = new Set(contract.metrics.map((metric) => metric.id));
  for (const id of requiredMetricIds) assert.ok(ids.has(id), `missing metric ${id}`);

  const manualReplay = contract.metrics.find((metric) => metric.id === 'authoring_manual_replay_required');
  assert.equal(manualReplay.category, 'friction');
  assert.equal(manualReplay.target, 'converge_to_zero_when_mechanically_resolvable');
  assert.deepEqual(manualReplay.dimensions.sort(), ['reason', 'reconciliation_trigger'].sort());

  const trigger = contract.dimensions.reconciliation_trigger;
  assert.deepEqual(trigger.values, ['event', 'maintenance', 'caller']);
  assert.match(trigger.authority_note, /not authority/i);
});

test('binds every production metric to authoritative durable facts and explicit drill-down identity', () => {
  for (const metric of OVERCENTER_METRICS_CONTRACT_V1.metrics.filter((metric) => metric.telemetry_class === 'overcenter_product_truth')) {
    assert.ok(metric.source_facts.length > 0, `${metric.id} must declare source facts`);
    assert.ok(metric.drilldown_identity.length > 0, `${metric.id} must declare drill-down identity`);
    assert.ok(metric.coverage_semantics, `${metric.id} must declare coverage semantics`);
  }
  assert.equal(OVERCENTER_METRICS_CONTRACT_V1.infrastructure_telemetry.hatchable.telemetry_class, 'infrastructure_only');
  assert.match(OVERCENTER_METRICS_CONTRACT_V1.infrastructure_telemetry.hatchable.rule, /must not become.*product.*truth/i);
});

test('documents existing derivability separately from genuinely new instrumentation', () => {
  const sources = OVERCENTER_METRICS_CONTRACT_V1.fact_sources;
  for (const name of ['runs', 'command_invocations', 'execution_operation_proof_state', 'scheduled_cycle_events', 'receipts', 'graph_state', 'authoring_operation_state', 'packet_outcomes']) {
    assert.equal(sources[name].availability, 'existing');
  }
  assert.ok(OVERCENTER_METRICS_CONTRACT_V1.new_instrumentation.length > 0);
  assert.ok(OVERCENTER_METRICS_CONTRACT_V1.new_instrumentation.every((fact) => fact.required_because && fact.authoritative_binding));
});

test('ratio evaluation fails closed on ambiguous denominator, identity, or historical coverage', () => {
  assert.deepEqual(evaluateRatioMetric({ numerator: 7, denominator: 10, coverage: 'complete', identity_complete: true }), {
    value: 0.7,
    numerator: 7,
    denominator: 10,
    coverage: 'complete',
  });
  assert.throws(() => evaluateRatioMetric({ numerator: 1, denominator: 0, coverage: 'complete', identity_complete: true }), /denominator/i);
  assert.throws(() => evaluateRatioMetric({ numerator: 1, denominator: 2, coverage: 'complete', identity_complete: false }), /identity/i);
  assert.throws(() => evaluateRatioMetric({ numerator: 1, denominator: 2, coverage: 'unknown', identity_complete: true }), /coverage/i);
});

test('latency summaries expose p50 and p95 only from complete identity-bound samples', () => {
  assert.deepEqual(summarizeLatencyMetric({ samples_ms: [10, 20, 30, 40, 100], coverage: 'complete', identity_complete: true }), {
    count: 5,
    p50_ms: 30,
    p95_ms: 100,
    coverage: 'complete',
  });
  assert.throws(() => summarizeLatencyMetric({ samples_ms: [10], coverage: 'partial', identity_complete: true }), /coverage/i);
});

test('communication metrics stay within Overcenter-observable boundaries', () => {
  const communication = OVERCENTER_METRICS_CONTRACT_V1.communication_scope;
  assert.ok(communication.measures.includes('packet/action-contract schema coverage'));
  assert.ok(communication.measures.includes('semantic coordination round trips per verified transition by lifecycle phase'));
  assert.ok(communication.excludes.includes('hidden model confusion'));
  assert.ok(communication.excludes.includes('ordinary repository investigation'));
  assert.equal(communication.fresh_session_zero_memory_conformance, 'contract_health_evidence_not_production_outcome_telemetry');
});