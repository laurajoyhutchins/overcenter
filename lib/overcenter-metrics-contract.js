const IDENTITY = Object.freeze({
  rule:'Observations must drill down to durable project, transition, run, lease, command, operation, or receipt identity; labels and temporal proximity are not identity.',
});
const COVERAGE = Object.freeze({
  statuses:Object.freeze(['complete','partial','unknown']),
  rule:'Unknown historical coverage is never zero or complete. Ratio metrics require a known denominator over the stated window.',
});
function metric(numerator, denominator, dimensions, sources, description) {
  return Object.freeze({ numerator, denominator, dimensions:Object.freeze(dimensions), sources:Object.freeze(sources), window:'bounded_observation_window', identity:IDENTITY, coverage:COVERAGE, description });
}
export const OVERCENTER_METRICS_CONTRACT = Object.freeze({
  schema:'overcenter-metrics-contract-v1',
  principle:'Metrics are derived views over durable Overcenter execution truth, never a parallel telemetry authority.',
  primary_metric:Object.freeze({ id:'verified_project_transitions_per_agent_execution_boundary', numerator:'verified_project_transition', denominator:'agent_execution_boundary', identity:IDENTITY, coverage:COVERAGE }),
  dimensions:Object.freeze({
    reconciliation_trigger:Object.freeze({ values:Object.freeze(['event','maintenance','caller']), authoritative:false }),
    lifecycle_phase:Object.freeze({ values:Object.freeze(['select','execute','verify','settle','recover','author']), authoritative:true }),
  }),
  metrics:Object.freeze({
    first_pass_success_rate:metric('first_pass_success','agent_execution_boundary',['lifecycle_phase'],['runs','execution_operation_proof_state','receipts'],'Verified completion without requeue, blocked settlement, indeterminate effect, or another reasoning boundary.'),
    verified_transition_throughput:metric('verified_project_transition',null,['project_ref'],['graph_state','receipts'],'Verified transitions completed in the observation window.'),
    operator_action_required_rate:metric('operator_action_required','agent_execution_boundary',['lifecycle_phase'],['runs','packet_outcomes'],'Reasoning boundaries that end in genuine operator-required state.'),
    administrative_semantic_commands_per_verified_transition:metric('administrative_semantic_command','verified_project_transition',['command','lifecycle_phase'],['command_invocations','receipts'],'Coordination and bookkeeping commands per verified transition.'),
    failure_rate:metric('execution_failure','execution_attempt',['command','lifecycle_phase'],['command_invocations','execution_operation_proof_state'],'Failures excluding expected rejection and indeterminate effect.'),
    rejection_rate:metric('expected_rejection','execution_attempt',['command','lifecycle_phase'],['command_invocations'],'Expected fail-closed precondition or conflict rejections.'),
    indeterminate_rate:metric('indeterminate_effect','execution_attempt',['command','lifecycle_phase'],['execution_operation_proof_state'],'Attempts whose external effect is not mechanically established.'),
    automatic_recovery_success_rate:metric('automatic_recovery_completed','automatic_recovery_attempt',['recovery_class'],['execution_operation_proof_state','receipts'],'Automatic recoveries restoring known valid state.'),
    deterministic_recovery_without_new_reasoning_boundary_rate:metric('deterministic_recovery_without_new_reasoning_boundary','deterministic_recovery_completed',['recovery_class'],['runs','execution_operation_proof_state'],'Successful deterministic recoveries that do not spend another reasoning boundary.'),
    transition_latency_p50:metric('verified_project_transition_latency_ms',null,['project_ref'],['runs','graph_state','receipts'],'Median time from first executable attempt to verified completion.'),
    transition_latency_p95:metric('verified_project_transition_latency_ms',null,['project_ref'],['runs','graph_state','receipts'],'95th percentile time from first executable attempt to verified completion.'),
    authoring_wait_started:metric('authoring_wait_started',null,['authoring_reason','authoring_trigger','reconciliation_trigger'],['authoring_operation_state'],'Authoring operations entering durable wait.'),
    authoring_auto_reconciled:metric('authoring_auto_reconciled',null,['authoring_reason','authoring_trigger','reconciliation_trigger'],['authoring_operation_state','scheduled_cycle_events'],'Waiting authoring operations mechanically reconciled without caller replay.'),
    authoring_manual_replay_required:metric('authoring_manual_replay_required',null,['authoring_reason','authoring_trigger'],['authoring_operation_state','packet_outcomes'],'Friction metric that should converge to zero for mechanically resolvable waits.'),
    authoring_wait_age:metric('authoring_wait_age_ms',null,['authoring_reason','authoring_trigger'],['authoring_operation_state'],'Age since authoritative wait-start time.'),
    authoring_recompute_required:metric('authoring_recompute_required',null,['authoring_reason','authoring_trigger','reconciliation_trigger'],['authoring_operation_state'],'Recomputations after authoritative state movement.'),
    packet_action_contract_schema_coverage:metric('agent_packet_with_required_action_contract_schema','agent_execution_boundary',['packet_schema'],['packet_outcomes','runs'],'Self-contained packet/action-contract schema coverage.'),
    semantic_coordination_round_trips_per_verified_transition:metric('semantic_coordination_round_trip','verified_project_transition',['lifecycle_phase','command'],['command_invocations','receipts'],'Observable semantic coordination round trips per verified transition.'),
    packet_authority_protocol_failure_rate:metric('packet_authority_or_protocol_failure','agent_execution_boundary',['packet_schema','lifecycle_phase'],['packet_outcomes','command_invocations'],'Failures attributable to stale or incomplete packets or authority/protocol mismatch.'),
    fresh_session_zero_memory_conformance:metric('fresh_session_contract_conformance',null,['packet_schema'],['packet_outcomes'],'Contract-health evidence only, not production outcome telemetry.'),
  }),
  authoritative_sources:Object.freeze(Object.fromEntries(['runs','command_invocations','execution_operation_proof_state','scheduled_cycle_events','receipts','graph_state','authoring_operation_state','packet_outcomes'].map((id) => [id,Object.freeze({ authoritative:true })]))),
  infrastructure_telemetry:'Hatchable invocation, isolate, transport, and host-health telemetry may explain Overcenter metrics but never defines Overcenter product/process truth.',
  exclusions:Object.freeze(['hidden model confusion','unobserved model reasoning quality','ordinary repository investigation not represented by an Overcenter semantic boundary']),
  new_instrumentation_required:Object.freeze([
    'Persist lifecycle phase only where semantic coordination phase cannot be derived from durable command/run identity.',
    'Persist packet schema attribution at authority/protocol failure boundaries where current durable failure identity lacks it.',
  ]),
});
export function assertMetricObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new Error('METRIC_OBSERVATION_INVALID');
  const metric = OVERCENTER_METRICS_CONTRACT.metrics[observation.metric_id];
  if (!metric) throw new Error('METRIC_ID_UNKNOWN');
  if (!observation.identity || typeof observation.identity !== 'object' || Array.isArray(observation.identity) || Object.keys(observation.identity).length === 0) throw new Error('METRIC_IDENTITY_AMBIGUOUS');
  if (!observation.coverage || !['complete','partial'].includes(observation.coverage.status)) throw new Error('METRIC_COVERAGE_UNKNOWN');
  if (metric.denominator && (!Number.isFinite(Number(observation.denominator)) || Number(observation.denominator) <= 0)) throw new Error('METRIC_DENOMINATOR_AMBIGUOUS');
  return Object.freeze({ ...observation });
}

const METRIC_CATEGORY = Object.freeze({
  first_pass_success_rate:'outcome',
  verified_transition_throughput:'outcome',
  operator_action_required_rate:'friction',
  administrative_semantic_commands_per_verified_transition:'friction',
  failure_rate:'failure',
  rejection_rate:'failure',
  indeterminate_rate:'failure',
  automatic_recovery_success_rate:'recovery',
  deterministic_recovery_without_new_reasoning_boundary_rate:'recovery',
  authoring_wait_started:'authoring',
  authoring_auto_reconciled:'authoring',
  authoring_manual_replay_required:'friction',
  authoring_wait_age:'authoring',
  authoring_recompute_required:'friction',
  packet_action_contract_schema_coverage:'communication',
  semantic_coordination_round_trips_per_verified_transition:'communication',
  packet_authority_protocol_failure_rate:'communication',
  fresh_session_zero_memory_conformance:'contract_health',
});

function normalizedMetric(id, definition, overrides = {}) {
  const source = OVERCENTER_METRICS_CONTRACT.metrics[id];
  const dimensions = overrides.dimensions || source?.dimensions || ['project_ref'];
  return Object.freeze({
    id:overrides.id || id,
    category:overrides.category || METRIC_CATEGORY[id] || 'outcome',
    definition:overrides.definition || source?.description || definition,
    telemetry_class:overrides.telemetry_class || (id === 'fresh_session_zero_memory_conformance' ? 'contract_health_evidence' : 'overcenter_product_truth'),
    source_facts:Object.freeze([...(overrides.source_facts || source?.sources || [])]),
    numerator:overrides.numerator === undefined ? (source?.numerator || null) : overrides.numerator,
    denominator:overrides.denominator === undefined ? (source?.denominator || null) : overrides.denominator,
    unit:overrides.unit || (String(source?.numerator || '').endsWith('_ms') ? 'milliseconds_p50_p95' : 'ratio'),
    dimensions:Object.freeze([...dimensions]),
    window:source?.window || 'bounded_observation_window',
    coverage_semantics:source?.coverage?.rule || COVERAGE.rule,
    drilldown_identity:Object.freeze(overrides.drilldown_identity || ['project_ref','transition_id','run_id','lease_ref','command','operation_id','receipt_id']),
    ...(overrides.target ? { target:overrides.target } : {}),
  });
}

const normalizedMetrics = [
  normalizedMetric('verified_project_transitions_per_agent_execution_boundary', 'Verified project transitions per agent execution boundary.', {
    source_facts:['graph_state','receipts','runs'],
    numerator:'verified_project_transition',
    denominator:'agent_execution_boundary',
    drilldown_identity:['project_ref','transition_id','authority_revision','run_id','lease_ref'],
  }),
  ...Object.keys(OVERCENTER_METRICS_CONTRACT.metrics)
    .filter((id) => !['transition_latency_p50','transition_latency_p95','packet_authority_protocol_failure_rate'].includes(id))
    .map((id) => normalizedMetric(id, null, id === 'authoring_manual_replay_required' ? {
      dimensions:['reason','reconciliation_trigger'],
      target:'converge_to_zero_when_mechanically_resolvable',
    } : {})),
  normalizedMetric('transition_latency_p50', 'p50/p95 latency from first executable attempt to verified completion.', {
    id:'transition_latency',
    source_facts:['runs','graph_state','receipts'],
    numerator:null,
    denominator:null,
    unit:'milliseconds_p50_p95',
    dimensions:['project_ref','transition_id'],
    drilldown_identity:['project_ref','transition_id','authority_revision','run_id','lease_ref'],
  }),
  normalizedMetric('recovery_latency', 'p50/p95 latency from recorded recovery-required state to restored mutation certainty or terminal escalation.', {
    source_facts:['execution_operation_proof_state','receipts','runs'],
    numerator:null,
    denominator:null,
    unit:'milliseconds_p50_p95',
    dimensions:['project_ref','recovery_class'],
    drilldown_identity:['project_ref','run_id','command','operation_id','attempt_epoch','receipt_id'],
  }),
  normalizedMetric('recovery_reasoning_boundary_reentry_rate', 'Deterministic recoveries that re-enter an agent reasoning boundary.', {
    category:'communication',
    source_facts:['runs','execution_operation_proof_state','receipts'],
    numerator:'deterministic_recovery_with_reasoning_boundary_reentry',
    denominator:'deterministic_recovery_completed',
    dimensions:['project_ref','recovery_class'],
  }),
  normalizedMetric('packet_authority_protocol_failure_rate', null, { id:'authority_protocol_packet_failure_rate' }),
];

export const OVERCENTER_METRICS_CONTRACT_V1 = Object.freeze({
  schema:'overcenter-metrics-contract-v1',
  top_level_metric:'verified_project_transitions_per_agent_execution_boundary',
  metrics:Object.freeze(normalizedMetrics),
  dimensions:Object.freeze({
    reconciliation_trigger:Object.freeze({
      values:Object.freeze(['event','maintenance','caller']),
      authority_note:'Reconciliation trigger provenance is explanatory context, not authority; durable Overcenter state remains authoritative.',
    }),
    lifecycle_phase:OVERCENTER_METRICS_CONTRACT.dimensions.lifecycle_phase,
  }),
  fact_sources:Object.freeze(Object.fromEntries(Object.keys(OVERCENTER_METRICS_CONTRACT.authoritative_sources).map((id) => [id,Object.freeze({ availability:'existing', authority:'durable_overcenter_fact' })]))),
  new_instrumentation:Object.freeze([
    Object.freeze({ fact:'semantic_coordination_lifecycle_phase', required_because:'command identity does not universally encode the lifecycle phase needed to segment semantic coordination round trips', authoritative_binding:'record on the correlated Overcenter command/run identity rather than a parallel telemetry ledger' }),
    Object.freeze({ fact:'recovery_reasoning_boundary_reentry', required_because:'durable recovery state does not universally encode whether a new reasoning boundary was entered', authoritative_binding:'bind to the exact recovery operation and run/boundary that resumed it' }),
    Object.freeze({ fact:'packet_failure_attribution', required_because:'packet outcomes do not universally distinguish stale or incomplete packet authority from downstream implementation failure', authoritative_binding:'bind to packet schema, authority revision, execution boundary, and command rejection evidence' }),
  ]),
  communication_scope:Object.freeze({
    measures:Object.freeze([
      'packet/action-contract schema coverage',
      'semantic coordination round trips per verified transition by lifecycle phase',
      'deterministic recovery with and without reasoning-boundary re-entry',
      'authority/protocol failures attributable to stale or incomplete agent packets',
    ]),
    excludes:Object.freeze(['hidden model confusion','ordinary repository investigation']),
    fresh_session_zero_memory_conformance:'contract_health_evidence_not_production_outcome_telemetry',
  }),
  infrastructure_telemetry:Object.freeze({
    hatchable:Object.freeze({ telemetry_class:'infrastructure_only', rule:'Hatchable host telemetry may explain failures but must not become Overcenter product/process truth or replace durable Overcenter denominators.' }),
  }),
});

function requireCompleteMetricEvidence({ coverage, identity_complete }) {
  if (identity_complete !== true) throw new Error('metric identity is incomplete or ambiguous');
  if (coverage !== 'complete') throw new Error(`metric coverage must be complete for numeric evaluation; received ${String(coverage)}`);
}

export function evaluateRatioMetric({ numerator, denominator, coverage, identity_complete }) {
  requireCompleteMetricEvidence({ coverage, identity_complete });
  if (!Number.isFinite(numerator) || numerator < 0) throw new Error('metric numerator must be a non-negative finite number');
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error('metric denominator must be a positive finite number');
  return Object.freeze({ value:numerator / denominator, numerator, denominator, coverage });
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function summarizeLatencyMetric({ samples_ms, coverage, identity_complete }) {
  requireCompleteMetricEvidence({ coverage, identity_complete });
  if (!Array.isArray(samples_ms) || samples_ms.length === 0 || samples_ms.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('latency samples must be a non-empty array of non-negative finite milliseconds');
  }
  const sorted = [...samples_ms].sort((a,b) => a - b);
  return Object.freeze({ count:sorted.length, p50_ms:nearestRank(sorted, 0.50), p95_ms:nearestRank(sorted, 0.95), coverage });
}
