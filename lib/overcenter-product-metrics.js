const WINDOW_MS = Object.freeze({ '24h':24*60*60*1000, '7d':7*24*60*60*1000, '30d':30*24*60*60*1000 });

function time(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function distribution(values) {
  const clean = values.filter(Number.isFinite);
  return { count:clean.length, p50:percentile(clean, 0.50), p95:percentile(clean, 0.95), max:clean.length ? Math.max(...clean) : null };
}

function exemplar(row) {
  return Object.fromEntries(Object.entries({
    run_id:row.run_id || null,
    transition_id:row.transition_id || null,
    command:row.command || null,
    authority_revision:row.authority_revision || null,
    evidence_refs:row.evidence_refs || null,
    packet_schema_version:row.packet_schema_version || row.schema_version || null,
  }).filter(([,value]) => value !== null));
}

function within(rows, start, end, fields) {
  return rows.filter((row) => {
    for (const field of fields) {
      const ms = time(row[field]);
      if (ms !== null) return ms >= start && ms <= end;
    }
    return false;
  });
}

function classifyFailure(row) {
  const cls = String(row.error_class || row.current_failure_error_class || '').toUpperCase();
  if (row.rejection === true && row.may_have_mutated === false && !cls.includes('STALE')) return 'expected_rejection';
  if (row.may_have_mutated === true || cls.includes('INDETERMINATE') || cls.includes('MUTATION_CERTAINTY')) return 'mutation_indeterminate';
  if (cls.includes('STALE') || cls.includes('AUTHORITY')) return 'authority_staleness';
  if (cls.includes('AGENT') || cls.includes('REASONING') || cls.includes('ESCALATION')) return 'agent_reasoning_escalation';
  if (cls || row.outcome === 'failed' || row.disposition === 'blocked') return 'execution_failure';
  return null;
}

function metricWindow(snapshot, start, end, exemplarLimit) {
  const runs = within(snapshot.runs || [], start, end, ['started_at','finished_at']);
  const invocations = within(snapshot.invocations || [], start, end, ['started_at','completed_at']);
  const settlements = within(snapshot.settlements || [], start, end, ['settled_at','created_at']);
  const packets = (snapshot.packets || []).filter((packet) => runs.some((run) => run.run_id === packet.run_id));
  const recoveries = within(snapshot.recoveries || [], start, end, ['created_at','resolved_at']);

  const completed = settlements.filter((row) => row.disposition === 'completed' && row.transition_id && Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0);
  const boundaryRuns = runs.filter((row) => row.transition_id || invocations.some((inv) => inv.run_id === row.run_id && inv.command === 'project.advance'));
  const verifiedCoverageUnknown = boundaryRuns.filter((run) => !settlements.some((s) => s.run_id === run.run_id && typeof s.disposition === 'string')).length;
  const ratioDenominatorKnown = boundaryRuns.length - verifiedCoverageUnknown;

  const failureCounts = { expected_rejection:0, execution_failure:0, mutation_indeterminate:0, authority_staleness:0, agent_reasoning_escalation:0 };
  const failureExamples = Object.fromEntries(Object.keys(failureCounts).map((key) => [key, []]));
  for (const row of [...runs, ...invocations]) {
    const classification = classifyFailure(row);
    if (!classification) continue;
    failureCounts[classification] += 1;
    if (failureExamples[classification].length < exemplarLimit) failureExamples[classification].push(exemplar(row));
  }

  const packetKnown = packets.filter((row) => row.schema_version && typeof row.complete === 'boolean' && row.authority_revision).length;
  const packetUnknown = Math.max(0, boundaryRuns.length - packetKnown);
  const completedLatencies = completed.flatMap((settlement) => {
    const run = runs.find((candidate) => candidate.run_id === settlement.run_id);
    const startMs = time(run?.started_at);
    const endMs = time(settlement.settled_at);
    return startMs !== null && endMs !== null && endMs >= startMs ? [endMs - startMs] : [];
  });

  const coordinationPhases = { before_acquisition:0, during_execution:0, recovery:0, after_confirmation:0 };
  for (const invocation of invocations) {
    if (invocation.command === 'project.advance') coordinationPhases.before_acquisition += 1;
    else if (classifyFailure(invocation) || String(invocation.command || '').includes('diagnose')) coordinationPhases.recovery += 1;
    else if (completed.some((settlement) => settlement.run_id === invocation.run_id) && time(invocation.started_at) > time(completed.find((settlement) => settlement.run_id === invocation.run_id)?.settled_at)) coordinationPhases.after_confirmation += 1;
    else coordinationPhases.during_execution += 1;
  }

  const recurring = new Map();
  for (const row of [...runs, ...invocations]) {
    const cls = classifyFailure(row);
    if (!cls) continue;
    const key = `${cls}:${row.command || 'run'}`;
    recurring.set(key, (recurring.get(key) || 0) + 1);
  }

  return {
    verified_transitions:{ count:completed.length, coverage_unknown:verifiedCoverageUnknown },
    agent_execution_boundaries:{ count:boundaryRuns.length },
    verified_transitions_per_agent_execution_boundary:{ value:ratioDenominatorKnown > 0 ? completed.length / ratioDenominatorKnown : null, denominator_known:ratioDenominatorKnown, denominator_unknown:verifiedCoverageUnknown },
    failure_classes:failureCounts,
    recurring_failure_cohorts:[...recurring.entries()].filter(([,count]) => count > 1).map(([key,count]) => ({ key, count })).sort((a,b) => b.count-a.count || a.key.localeCompare(b.key)),
    packet_contract:{ coverage_known:packetKnown, coverage_unknown:packetUnknown, complete:packets.filter((row) => row.complete === true).length, incomplete:packets.filter((row) => row.complete === false).length },
    semantic_coordination_commands:coordinationPhases,
    recovery:{
      deterministic_without_new_reasoning_boundary:recoveries.filter((row) => row.deterministic === true && row.new_reasoning_boundary === false).length,
      deterministic_with_new_reasoning_boundary:recoveries.filter((row) => row.deterministic === true && row.new_reasoning_boundary === true).length,
      reasoning_required:recoveries.filter((row) => row.deterministic === false || row.new_reasoning_boundary === true).length,
    },
    latency_ms:{ completed_transition:distribution(completedLatencies) },
    stuck_age_ms:distribution(runs.filter((row) => !row.finished_at).flatMap((row) => { const started=time(row.started_at); return started === null ? [] : [Math.max(0,end-started)]; })),
    exemplars:{
      verified_transitions:completed.slice(0,exemplarLimit).map(exemplar),
      ...failureExamples,
    },
  };
}

export function deriveOvercenterProductMetrics(snapshot = {}, options = {}) {
  const now = time(options.now || new Date().toISOString());
  if (now === null) throw new TypeError('options.now must be an ISO timestamp');
  const requested = options.windows || ['24h','7d','30d'];
  const exemplarLimit = Math.max(1, Math.min(20, Number(options.exemplar_limit || 5)));
  const windows = {};
  for (const label of requested) {
    const size = WINDOW_MS[label];
    if (!size) throw new TypeError(`unsupported metric window: ${label}`);
    windows[label] = metricWindow(snapshot, now - size, now, exemplarLimit);
  }
  return { schema:'overcenter-product-metrics-v1', observed_at:new Date(now).toISOString(), windows };
}