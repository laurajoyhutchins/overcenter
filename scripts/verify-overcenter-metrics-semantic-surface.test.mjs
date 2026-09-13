import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOvercenterMetricsSemanticOutput, createPostgresOvercenterMetricsSemanticService } from '../lib/overcenter-metrics-semantic-surface.js';

const now = '2026-09-13T22:00:00.000Z';
const runs = [
  { run_id:'native-ok', parent_run_id:'parent-1', subject_ref:'github:o/r:t1', subject_kind:'project_transition', transition_id:'t1', started_at:'2026-09-13T21:00:00Z', status:'finished', disposition:'completed' },
  { run_id:'native-rework', parent_run_id:null, subject_ref:'github:o/r:t2', subject_kind:'project_transition', transition_id:'t2', started_at:'2026-09-13T21:10:00Z', status:'finished', disposition:'completed' },
  { run_id:'legacy-ok', parent_run_id:'legacy-parent', subject_ref:'LIN-1', subject_kind:'legacy_work', transition_id:null, started_at:'2026-09-13T21:20:00Z', status:'finished', disposition:'completed' },
];
const invocations = [
  { run_id:'native-ok', command:'project.advance', started_at:'2026-09-13T21:00:02Z', completed_at:'2026-09-13T21:00:05Z', outcome:'succeeded', retryable:false, execution_origin:'agent', result_outcome:'AGENT_EXECUTION_REQUIRED' },
  { run_id:'native-rework', command:'project.advance', started_at:'2026-09-13T21:10:02Z', completed_at:'2026-09-13T21:10:03Z', outcome:'rejected', retryable:true, execution_origin:'agent', result_outcome:null },
  { run_id:'native-rework', command:'project.advance', started_at:'2026-09-13T21:10:05Z', completed_at:'2026-09-13T21:10:08Z', outcome:'succeeded', retryable:false, execution_origin:'recovery', result_outcome:'AGENT_EXECUTION_REQUIRED' },
  { run_id:'legacy-ok', command:'work.claim', started_at:'2026-09-13T21:20:02Z', completed_at:'2026-09-13T21:20:04Z', outcome:'succeeded', retryable:false, execution_origin:'agent', result_outcome:null },
];

test('separates product and orchestration metrics and binds exact correlation identity', () => {
  const result = deriveOvercenterMetricsSemanticOutput({ runs, invocations, reconciliations:3 }, { now, window:'24h' });
  assert.equal(result.product_metrics.observed_workflow.first_pass_success_rate.value, 0.5);
  assert.equal(result.product_metrics.observed_workflow.rework_rate.value, 0.5);
  assert.equal(result.orchestration_metrics.transition_throughput, 2);
  assert.equal(result.orchestration_metrics.retries, 1);
  assert.equal(result.orchestration_metrics.reconciliations, 3);
  assert.equal(result.observed_vs_counterfactual.observed_workflow_class, 'project_transition');
  assert.equal(result.observed_vs_counterfactual.counterfactual_reference_workflow_class, 'legacy_work');
  assert.equal(result.observed_vs_counterfactual.comparison_kind, 'historical_reference_not_causal_estimate');
  assert.deepEqual(result.correlation_samples[0], { run_id:'native-ok', parent_run_id:'parent-1', subject_ref:'github:o/r:t1', transition_id:'t1', workflow_class:'project_transition' });
  assert.deepEqual(result.measurement_boundary, { read_only:true, grants_mutation_authority:false, settles_project_state:false, source_authority:'cloud_sql' });
});

test('postgres service performs only bounded SELECT observations', async () => {
  const sql = [];
  const db = { query:async (statement) => {
    sql.push(statement.trim());
    if (statement.includes('FROM orchestration_runs')) return { rows:runs };
    if (statement.includes('FROM orchestration_command_invocations')) return { rows:invocations };
    return { rows:[{ count:3 }] };
  } };
  const result = await createPostgresOvercenterMetricsSemanticService({ db, now:() => now }).metrics({ window:'24h' });
  assert.equal(result.ok, true);
  assert.equal(sql.length, 3);
  assert.ok(sql.every((statement) => /^SELECT\b/i.test(statement)));
  assert.ok(sql.every((statement) => !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(statement)));
});