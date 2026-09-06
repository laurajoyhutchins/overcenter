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
    invocation_id:row.invocation_id || null,
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
  if (cls.includes('EXPECTED_REJECTION') || (row.rejection === true && row.may_have_mutated === false && !cls.includes('STALE'))) return 'expected_rejection';
  if (row.may_have_mutated === true || cls.includes('INDETERMINATE') || cls.includes('MUTATION_CERTAINTY')) return 'mutation_indeterminate';
  if (cls.includes('STALE') || cls.includes('AUTHORITY')) return 'authority_staleness';
  if (cls.includes('AGENT') || cls.includes('REASONING') || cls.includes('ESCALATION')) return 'agent_reasoning_escalation';
  if (cls || row.outcome === 'failed' || row.disposition === 'blocked') return 'execution_failure';
  return null;
}

function metricWindow(snapshot, start, end, exemplarLimit) {
  const runs = within(snapshot.runs || [], start, end, ['started_at','finished_at','observed_at']);
  const invocations = within(snapshot.command_invocations || snapshot.invocations || [], start, end, ['observed_at','started_at','completed_at']);
  const settlements = within(snapshot.receipts || snapshot.settlements || [], start, end, ['confirmed_at','settled_at','created_at']);
  const packets = (snapshot.packet_outcomes || snapshot.packets || []).filter((packet) => runs.some((run) => run.run_id === packet.run_id));
  const recoveries = within(snapshot.recovery_events || snapshot.recoveries || [], start, end, ['observed_at','created_at','resolved_at']);

  const completed = settlements.filter((row) => (row.verified === true || row.disposition === 'completed') && row.transition_id && (row.verified === true || (Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0)));
  const boundaryRuns = runs.filter((row) => {
    const runInvocations = invocations.filter((inv) => inv.run_id === row.run_id);
    return row.agent_execution_boundary === true
      || row.transition_id
      || runInvocations.some((inv) => inv.command === 'project.advance')
      || (row.agent_execution_boundary === undefined && runInvocations.length === 0);
  });
  const verifiedCoverageUnknown = boundaryRuns.filter((run) => !settlements.some((s) => s.run_id === run.run_id && (typeof s.disposition === 'string' || typeof s.verified === 'boolean'))).length;
  const ratioDenominatorKnown = boundaryRuns.length > verifiedCoverageUnknown ? boundaryRuns.length : 0;

  const failureCounts = { expected_rejection:0, execution_failure:0, mutation_indeterminate:0, authority_staleness:0, agent_reasoning_escalation:0 };
  const failureExamples = Object.fromEntries(Object.keys(failureCounts).map((key) => [key, []]));
  const failureRows = new Map();
  const failingInvocationRunIds = new Set(invocations.filter((row) => classifyFailure(row)).map((row) => row.run_id).filter(Boolean));
  const failureSources = [
    ...invocations.map((row) => ({ ...(runs.find((run) => run.run_id === row.run_id) || {}), ...row })),
    ...runs.filter((row) => !failingInvocationRunIds.has(row.run_id)),
  ];
  for (const row of failureSources) {
    const classification = classifyFailure(row);
    if (!classification) continue;
    const key = row.invocation_id || row.operation_attempt_id || `${row.run_id || 'unknown'}:${row.command || 'run'}:${row.observed_at || row.started_at || ''}`;
    const existing = failureRows.get(key);
    const rank = { mutation_indeterminate:5, authority_staleness:4, agent_reasoning_escalation:3, execution_failure:2, expected_rejection:1 };
    if (!existing || rank[classification] > rank[existing.classification]) failureRows.set(key, { row, classification });
  }
  for (const { row, classification } of failureRows.values()) {
    failureCounts[classification] += 1;
    if (failureExamples[classification].length < exemplarLimit) failureExamples[classification].push(exemplar(row));
  }

  const packetKnownRows = packets.filter((row) => (row.packet_schema || row.schema_version) && (row.action_contract_schema || typeof row.complete === 'boolean') && row.authority_revision);
  const packetKnown = packetKnownRows.length;
  const packetUnknown = Math.max(0, boundaryRuns.length - packetKnown);
  const packetAuthorityProtocolFailures = packets.filter((row) => row.authority_protocol_failure === true || row.stale_authority === true || row.incomplete_authority === true);
  const zeroMemoryKnown = packets.filter((row) => typeof row.zero_memory_conformance === 'boolean');
  const zeroMemoryUnknown = Math.max(0, packets.length - zeroMemoryKnown.length);
  const completedLatencies = completed.flatMap((settlement) => {
    const run = runs.find((candidate) => candidate.run_id === settlement.run_id);
    const startMs = time(settlement.first_executable_at) ?? time(run?.started_at);
    const endMs = time(settlement.confirmed_at) ?? time(settlement.settled_at);
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

  const ratioValue = ratioDenominatorKnown > 0 ? completed.length / ratioDenominatorKnown : null;
  const packetCoverageValue = boundaryRuns.length > 0 && packetKnown > 0 ? packetKnown / boundaryRuns.length : null;
  const packetCoverageStatus = boundaryRuns.length === 0 ? 'complete' : packetKnown === 0 ? 'unknown' : packetUnknown === 0 ? 'complete' : 'partial';
  const recoveryAttempts = recoveries.filter((row) => row.deterministic === true);
  const recoveryWithoutReasoning = recoveryAttempts.filter((row) => row.completed === true && row.new_reasoning_boundary === false).length;
  const waitAges = (snapshot.waits || []).filter((row) => { const started=time(row.started_at); return started !== null && started >= start && started <= end && !row.resolved_at; }).map((row) => Math.max(0,end-time(row.started_at)));
  const failureTaxonomy = Object.fromEntries(Object.keys(failureCounts).map((key) => [key,{ value:failureCounts[key], exemplars:failureExamples[key] }]));
  return {
    verified_transitions:{ count:completed.length, coverage_unknown:verifiedCoverageUnknown },
    verified_transition_throughput:{ value:completed.length, exemplars:completed.slice(0,exemplarLimit).map(exemplar) },
    agent_execution_boundaries:{ count:boundaryRuns.length, value:boundaryRuns.length },
    verified_transitions_per_agent_execution_boundary:{ value:ratioValue, denominator_known:ratioDenominatorKnown, denominator_unknown:verifiedCoverageUnknown },
    verified_project_transitions_per_agent_execution_boundary:{ value:ratioValue, denominator_known:ratioDenominatorKnown, denominator_unknown:verifiedCoverageUnknown },
    failure_classes:failureCounts,
    failure_taxonomy:failureTaxonomy,
    packet_action_contract_schema_coverage:{ value:packetCoverageValue, coverage:{ status:packetCoverageStatus, known:packetKnown, unknown:packetUnknown } },
    deterministic_recovery_without_new_reasoning_boundary_rate:{ value:recoveryAttempts.length ? recoveryWithoutReasoning / recoveryAttempts.length : null, denominator:recoveryAttempts.length },
    transition_latency_ms:distribution(completedLatencies),
    recurring_failure_cohorts:[...recurring.entries()].filter(([,count]) => count > 1).map(([key,count]) => ({ key, count })).sort((a,b) => b.count-a.count || a.key.localeCompare(b.key)),
    packet_contract:{
      coverage_known:packetKnown,
      coverage_unknown:packetUnknown,
      complete:packets.filter((row) => row.complete === true).length,
      incomplete:packets.filter((row) => row.complete === false).length,
      authority_protocol_failures:{
        count:packetAuthorityProtocolFailures.length,
        exemplars:packetAuthorityProtocolFailures.slice(0,exemplarLimit).map(exemplar),
      },
    },
    semantic_coordination_commands:{
      ...coordinationPhases,
      per_verified_transition:Object.fromEntries(Object.entries(coordinationPhases).map(([phase,count]) => [phase, completed.length > 0 ? count / completed.length : null])),
    },
    recovery:{
      deterministic_attempts:recoveries.filter((row) => row.deterministic === true).length,
      deterministic_completed:recoveries.filter((row) => row.deterministic === true && row.completed !== false).length,
      deterministic_without_new_reasoning_boundary:recoveries.filter((row) => row.deterministic === true && row.new_reasoning_boundary === false).length,
      deterministic_with_new_reasoning_boundary:recoveries.filter((row) => row.deterministic === true && row.new_reasoning_boundary === true).length,
      reasoning_required:recoveries.filter((row) => row.deterministic === false || row.new_reasoning_boundary === true).length,
    },
    contract_health:{
      fresh_session_zero_memory_conformance:{
        known:zeroMemoryKnown.length,
        unknown:zeroMemoryUnknown,
        passed:zeroMemoryKnown.filter((row) => row.zero_memory_conformance === true).length,
        failed:zeroMemoryKnown.filter((row) => row.zero_memory_conformance === false).length,
        note:'Contract-health evidence only; excluded from production outcome rates.',
      },
    },
    latency_ms:{ completed_transition:distribution(completedLatencies) },
    stuck_age_ms:distribution(waitAges.length ? waitAges : runs.filter((row) => !row.finished_at).flatMap((row) => { const started=time(row.started_at); return started === null ? [] : [Math.max(0,end-started)]; })),
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
  const conformance = snapshot.zero_memory_conformance || [];
  return {
    schema:'overcenter-product-metrics-v1',
    observed_at:new Date(now).toISOString(),
    windows,
    contract_health:{
      zero_memory_conformance:{
        known:conformance.length,
        passed:conformance.filter((row) => row.passed === true).length,
        failed:conformance.filter((row) => row.passed === false).length,
        note:'Contract-health evidence only; excluded from production outcome rates.',
      },
    },
  };
}
