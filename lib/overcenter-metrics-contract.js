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
