const WINDOWS = Object.freeze({ '24h':24*60*60*1000, '7d':7*24*60*60*1000, '30d':30*24*60*60*1000 });

function iso(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function distribution(values) {
  const clean = values.filter(Number.isFinite).sort((a,b) => a-b);
  const percentile = (fraction) => clean.length ? clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * fraction) - 1))] : null;
  return { count:clean.length, p50:percentile(0.5), p95:percentile(0.95), max:clean.length ? clean[clean.length - 1] : null };
}

function publicCorrelation(row) {
  return {
    run_id:row.run_id,
    parent_run_id:row.parent_run_id || null,
    subject_ref:row.subject_ref || null,
    transition_id:row.transition_id || null,
    workflow_class:row.subject_kind || 'unknown',
  };
}

function summarizeClass(className, runs, invocations) {
  const classRuns = runs.filter((row) => row.subject_kind === className);
  const runIds = new Set(classRuns.map((row) => row.run_id));
  const classInvocations = invocations.filter((row) => runIds.has(row.run_id));
  const failuresByRun = new Map();
  const actionableByRun = new Map();
  for (const row of classInvocations) {
    if (['failed','rejected','indeterminate'].includes(row.outcome)) failuresByRun.set(row.run_id, (failuresByRun.get(row.run_id) || 0) + 1);
    const actionable = row.command === 'project.advance' && row.outcome === 'succeeded' && row.result_outcome === 'AGENT_EXECUTION_REQUIRED';
    if (actionable && !actionableByRun.has(row.run_id)) actionableByRun.set(row.run_id, row.completed_at || row.started_at);
  }
  const completed = classRuns.filter((row) => row.status === 'finished' && row.disposition === 'completed');
  const firstPass = completed.filter((row) => !failuresByRun.get(row.run_id));
  const reworked = completed.filter((row) => (failuresByRun.get(row.run_id) || 0) > 0);
  const actionableLatency = classRuns.flatMap((row) => {
    const start = iso(row.started_at);
    const actionable = iso(actionableByRun.get(row.run_id));
    return start !== null && actionable !== null && actionable >= start ? [actionable - start] : [];
  });
  return {
    workflow_class:className,
    run_count:classRuns.length,
    product_metrics:{
      first_pass_success_rate:{ value:rate(firstPass.length, completed.length), numerator:firstPass.length, denominator:completed.length },
      time_to_actionable_delivery_ms:distribution(actionableLatency),
      rework_rate:{ value:rate(reworked.length, completed.length), numerator:reworked.length, denominator:completed.length },
    },
    orchestration_metrics:{
      completed_run_throughput:completed.length,
      retry_or_recovery_invocations:classInvocations.filter((row) => ['failed','rejected','indeterminate'].includes(row.outcome) || row.execution_origin === 'recovery').length,
    },
  };
}

function delta(observed, reference, path) {
  const get = (value) => path.reduce((current,key) => current?.[key], value);
  const left = get(observed);
  const right = get(reference);
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

export function deriveOvercenterMetricsSemanticOutput(snapshot = {}, options = {}) {
  const observedAt = options.now || new Date().toISOString();
  const observedMs = iso(observedAt);
  if (observedMs === null) throw new TypeError('now must be an ISO timestamp');
  const window = options.window || '24h';
  if (!WINDOWS[window]) throw new TypeError(`unsupported metrics window: ${window}`);
  const startMs = observedMs - WINDOWS[window];
  const runs = (snapshot.runs || []).filter((row) => { const started = iso(row.started_at); return started !== null && started >= startMs && started <= observedMs; });
  const runIds = new Set(runs.map((row) => row.run_id));
  const invocations = (snapshot.invocations || []).filter((row) => runIds.has(row.run_id));
  const observed = summarizeClass('project_transition', runs, invocations);
  const reference = summarizeClass('legacy_work', runs, invocations);
  const transitionThroughput = runs.filter((row) => row.subject_kind === 'project_transition' && row.status === 'finished' && row.disposition === 'completed').length;
  return {
    ok:true,
    schema:'overcenter-metrics-semantic-v1',
    observed_at:new Date(observedMs).toISOString(),
    window,
    product_metrics:{
      observed_workflow:observed.product_metrics,
      counterfactual_reference_workflow:reference.product_metrics,
    },
    orchestration_metrics:{
      transition_throughput:transitionThroughput,
      run_throughput:runs.filter((row) => row.status === 'finished').length,
      retries:invocations.filter((row) => row.retryable === true && ['failed','rejected'].includes(row.outcome)).length,
      reconciliations:Number(snapshot.reconciliations || 0),
      by_workflow_class:[observed.orchestration_metrics, reference.orchestration_metrics],
    },
    observed_vs_counterfactual:{
      observed_workflow_class:'project_transition',
      counterfactual_reference_workflow_class:'legacy_work',
      comparison_kind:'historical_reference_not_causal_estimate',
      first_pass_success_rate_delta:delta(observed,reference,['product_metrics','first_pass_success_rate','value']),
      rework_rate_delta:delta(observed,reference,['product_metrics','rework_rate','value']),
      time_to_actionable_delivery_p50_ms_delta:delta(observed,reference,['product_metrics','time_to_actionable_delivery_ms','p50']),
      coverage:{ observed_runs:observed.run_count, counterfactual_reference_runs:reference.run_count },
    },
    correlation_samples:runs.filter((row) => row.subject_ref || row.transition_id).slice(0,20).map(publicCorrelation),
    measurement_boundary:{ read_only:true, grants_mutation_authority:false, settles_project_state:false, source_authority:'cloud_sql' },
  };
}

export function createPostgresOvercenterMetricsSemanticService({ db, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db is required');
  return Object.freeze({
    async metrics(input = {}) {
      const window = input.window || '24h';
      if (!WINDOWS[window]) {
        const error = new Error('window must be one of 24h, 7d, 30d');
        error.code = 'REQUEST_INVALID';
        throw error;
      }
      const since = new Date(Date.parse(now()) - WINDOWS[window]).toISOString();
      const [runResult, invocationResult, reconcileResult] = await Promise.all([
        db.query(`SELECT r.run_id, r.predecessor_run_id AS parent_run_id, r.started_at, r.finished_at, r.status, r.disposition, e.subject_key AS subject_ref, e.subject_kind, e.transition_id FROM orchestration_runs r LEFT JOIN execution_state e ON e.run_id = r.run_id WHERE r.started_at >= $1 ORDER BY r.started_at DESC`, [since]),
        db.query(`SELECT i.run_id, i.command, i.started_at, i.completed_at, i.outcome, i.retryable, i.execution_origin, i.result_projection->>'outcome' AS result_outcome FROM orchestration_command_invocations i WHERE i.started_at >= $1 ORDER BY i.started_at ASC`, [since]),
        db.query(`SELECT count(*)::int AS count FROM portfolio_reconcile_receipts WHERE state='succeeded' AND updated_at >= $1`, [since]),
      ]);
      return deriveOvercenterMetricsSemanticOutput({ runs:runResult.rows || [], invocations:invocationResult.rows || [], reconciliations:Number(reconcileResult.rows?.[0]?.count || 0) }, { now:now(), window });
    },
  });
}