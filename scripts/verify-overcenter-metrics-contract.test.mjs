import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERCENTER_METRICS_CONTRACT_V1,
  validateMetricQuery,
} from '../lib/overcenter-metrics-contract.js';

test('centers the product metric on verified project transitions per agent execution boundary', () => {
  const metric = OVERCENTER_METRICS_CONTRACT_V1.metrics.verified_project_transitions_per_agent_execution_boundary;
  assert.equal(metric.kind, 'ratio');
  assert.equal(metric.numerator.fact, 'verified_project_transition');
  assert.equal(metric.denominator.fact, 'agent_execution_boundary');
  assert.equal(metric.coverage, 'exact-authority-only');
  assert.deepEqual(metric.drilldown_identity, ['project_ref', 'transition_id', 'authority_revision', 'run_id']);
});

test('defines required outcome, friction, failure, recovery, latency, authoring, and communication metrics', () => {
  const metrics = OVERCENTER_METRICS_CONTRACT_V1.metrics;
  for (const name of [
    'first_pass_success_rate',
    'verified_transition_throughput',
    'operator_action_required_rate',
    'administrative_semantic_commands_per_verified_transition',
    'failure_rate',
    'rejection_rate',
    'indeterminate_rate',
    'automatic_recovery_success_rate',
    'deterministic_recovery_without_new_reasoning_boundary_rate',
    'transition_latency_p50',
    'transition_latency_p95',
    'authoring_wait_started',
    'authoring_auto_reconciled',
    'authoring_manual_replay_required',
    'authoring_wait_age_p50',
    'authoring_wait_age_p95',
    'authoring_recompute_required',
    'packet_action_contract_schema_coverage',
    'semantic_coordination_round_trips_per_verified_transition',
    'recovery_reentered_reasoning_boundary_rate',
    'authority_protocol_failure_rate',
  ]) assert.ok(metrics[name], `missing ${name}`);
});

test('separates durable Overcenter truth from Hatchable infrastructure telemetry and hidden-model claims', () => {
  assert.deepEqual(OVERCENTER_METRICS_CONTRACT_V1.authoritative_sources.sort(), [
    'authoring_operation_state',
    'execution_state',
    'graph_state',
    'operation_state',
    'orchestration_command_invocations',
    'orchestration_runs',
    'packet_outcomes',
    'proof_state',
    'receipts',
    'scheduled_cycle_events',
  ].sort());
  assert.equal(OVERCENTER_METRICS_CONTRACT_V1.infrastructure_telemetry.hatchable_is_product_truth, false);
  assert.deepEqual(OVERCENTER_METRICS_CONTRACT_V1.non_claims, ['hidden_model_confusion', 'ordinary_repository_investigation']);
});

test('fails closed on ambiguous denominator, drill-down identity, and unknown historical coverage', () => {
  const valid = {
    metric: 'first_pass_success_rate',
    window: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' },
    coverage: { status: 'complete', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    identity: { project_ref: 'github:laurajoyhutchins/overcenter', authority_revision: 'b'.repeat(40) },
  };
  assert.doesNotThrow(() => validateMetricQuery(valid));
  assert.throws(() => validateMetricQuery({ ...valid, coverage: { status: 'unknown' } }), /coverage/i);
  assert.throws(() => validateMetricQuery({ ...valid, identity: {} }), /identity/i);
  assert.throws(() => validateMetricQuery({ ...valid, denominator: 'unknown' }), /denominator/i);
});

test('keeps reconciliation trigger as a dimension, never an authority source', () => {
  const metric = OVERCENTER_METRICS_CONTRACT_V1.metrics.authoring_auto_reconciled;
  assert.ok(metric.dimensions.includes('reconciliation_trigger'));
  assert.deepEqual(OVERCENTER_METRICS_CONTRACT_V1.dimensions.reconciliation_trigger, ['event-triggered', 'maintenance-triggered', 'caller-triggered']);
  assert.equal(OVERCENTER_METRICS_CONTRACT_V1.reconciliation.event_delivery_is_authority, false);
});