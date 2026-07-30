import { canonicalJson, sha256Text } from './canonical-json.js';

export const REDUCER_VERSION = 'portfolio-reducer-v1';
const TERMINAL_LINEAR = new Set(['done', 'completed', 'canceled', 'cancelled', 'duplicate']);
const TERMINAL_GITHUB = new Set(['closed', 'merged']);
const TERMINAL_EXECUTION = new Set(['completed', 'blocked', 'failed', 'no_change', 'canceled', 'expired', 'invalidated', 'quarantined']);
const KNOWN_FACTS = new Set([
  'github.pull_request', 'github.head', 'github.checks', 'github.verification',
  'linear.state', 'linear.blocker', 'linear.retry',
  'gateway.execution', 'gateway.reconciliation',
  'schedule.participant', 'owner.decision',
]);

function sorted(observations) {
  return [...observations].sort((a, b) =>
    String(a.observed_at).localeCompare(String(b.observed_at))
    || String(a.source_system).localeCompare(String(b.source_system))
    || String(a.idempotency_key).localeCompare(String(b.idempotency_key))
  );
}

function addUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

function upsertDecision(map, payload, observation) {
  const category = String(payload.category || 'unspecified');
  if (payload.required === false) {
    map.delete(category);
    return;
  }
  map.set(category, {
    category,
    summary: String(payload.summary || ''),
    recommended_action: String(payload.recommended_action || ''),
    source_system: observation.source_system,
    source_revision: observation.source_revision,
    observed_at: observation.observed_at,
  });
}

export async function reduceEntity(entityKey, observations) {
  const ordered = sorted(observations);
  const projection = {
    schema: 'portfolio-entity-projection-v1',
    entity_key: entityKey,
    entity_type: ordered.at(-1)?.entity_type || 'unknown',
    source_revisions: {},
    lifecycle: null,
    terminal: false,
    executable: true,
    github: { state: null, merged: false, head_sha: null, checks_head_sha: null, checks_conclusion: null },
    linear: { workflow_state: null, lifecycle: null, terminal: false },
    execution: { execution_id: null, status: null, terminal: false, reconciled: false, participant_observed: null, participant_disposition: null },
    blockers: [],
    retry: { satisfied: true, trigger: null },
    verification: { verdict: null, head_sha: null, fresh: false, verified_at: null },
    discrepancies: [],
    owner_action: { required: false, decisions: [] },
    next_action: null,
    unknown_fact_types: [],
    observation_count: ordered.length,
    input_watermark: ordered.at(-1)?.observed_at || null,
    reducer_version: REDUCER_VERSION,
    projection_sha256: null,
  };
  const decisions = new Map();
  const sourceClocks = new Map();

  for (const observation of ordered) {
    const payload = observation.payload && typeof observation.payload === 'object' ? observation.payload : {};
    const sourceUpdatedAt = payload.source_updated_at ? Date.parse(String(payload.source_updated_at)) : null;
    const priorSourceClock = sourceClocks.get(observation.source_system);
    if (Number.isFinite(sourceUpdatedAt) && priorSourceClock && sourceUpdatedAt < priorSourceClock.time) {
      addUnique(projection.discrepancies, 'SOURCE_REVISION_REGRESSION');
      continue;
    }
    projection.source_revisions[observation.source_system] = observation.source_revision;
    if (Number.isFinite(sourceUpdatedAt)) {
      sourceClocks.set(observation.source_system, { time: sourceUpdatedAt, revision: observation.source_revision });
    }
    if (!KNOWN_FACTS.has(observation.fact_type)) {
      addUnique(projection.unknown_fact_types, observation.fact_type);
      addUnique(projection.discrepancies, 'UNKNOWN_FACT_TYPE');
      continue;
    }

    switch (observation.fact_type) {
      case 'github.pull_request':
        if (payload.state != null) projection.github.state = String(payload.state).toLowerCase();
        if (payload.merged != null) projection.github.merged = Boolean(payload.merged);
        if (payload.head_sha) projection.github.head_sha = String(payload.head_sha);
        break;
      case 'github.head':
        if (payload.head_sha) projection.github.head_sha = String(payload.head_sha);
        break;
      case 'github.checks':
        projection.github.checks_head_sha = payload.head_sha ? String(payload.head_sha) : null;
        projection.github.checks_conclusion = payload.conclusion ? String(payload.conclusion).toLowerCase() : null;
        break;
      case 'github.verification':
        projection.verification.verdict = payload.verdict ? String(payload.verdict) : null;
        projection.verification.head_sha = payload.head_sha ? String(payload.head_sha) : null;
        projection.verification.verified_at = payload.verified_at || observation.observed_at;
        break;
      case 'linear.state':
        projection.linear.workflow_state = payload.workflow_state ? String(payload.workflow_state) : null;
        projection.linear.lifecycle = payload.lifecycle ? String(payload.lifecycle) : null;
        projection.lifecycle = projection.linear.lifecycle;
        break;
      case 'linear.blocker':
        if (payload.active) {
          projection.blockers.push({
            code: 'EXTERNAL_BLOCKER_ACTIVE',
            type: String(payload.blocker_type || 'external'),
            description: String(payload.description || ''),
          });
        }
        break;
      case 'linear.retry':
        projection.retry.satisfied = payload.satisfied !== false;
        projection.retry.trigger = payload.trigger ? String(payload.trigger) : null;
        break;
      case 'gateway.execution':
        projection.execution.execution_id = payload.execution_id ? String(payload.execution_id) : projection.execution.execution_id;
        projection.execution.status = payload.status ? String(payload.status).toLowerCase() : null;
        if (payload.reconciled != null) projection.execution.reconciled = Boolean(payload.reconciled);
        break;
      case 'gateway.reconciliation':
        projection.execution.execution_id = payload.execution_id ? String(payload.execution_id) : projection.execution.execution_id;
        projection.execution.reconciled = payload.reconciled !== false;
        break;
      case 'schedule.participant':
        projection.execution.participant_observed = payload.observed !== false;
        projection.execution.participant_disposition = payload.disposition ? String(payload.disposition) : null;
        break;
      case 'owner.decision':
        upsertDecision(decisions, payload, observation);
        break;
    }
  }

  const workflow = String(projection.linear.workflow_state || '').toLowerCase();
  const lifecycle = String(projection.linear.lifecycle || '').toUpperCase();
  projection.linear.terminal = TERMINAL_LINEAR.has(workflow);
  if (projection.linear.terminal && ['BUILDABLE', 'IN_PROGRESS', 'AWAITING_HUMAN', 'AWAITING_LAURA'].includes(lifecycle)) {
    addUnique(projection.discrepancies, 'LINEAR_TERMINAL_LIFECYCLE_CONTRADICTION');
  }

  if (projection.github.checks_conclusion === 'failure') {
    addUnique(projection.discrepancies, 'CHECKS_FAILED');
    projection.blockers.push({ code: 'CHECKS_FAILED', type: 'verification', description: 'One or more checks failed.' });
  }
  projection.verification.fresh = Boolean(
    projection.verification.verdict === 'VERIFIED'
    && projection.verification.head_sha
    && projection.verification.head_sha === projection.github.head_sha
  );
  if (projection.verification.verdict && projection.github.head_sha && !projection.verification.fresh) {
    addUnique(projection.discrepancies, 'VERIFICATION_STALE');
  }
  if (projection.blockers.some((item) => item.code === 'EXTERNAL_BLOCKER_ACTIVE')) {
    addUnique(projection.discrepancies, 'EXTERNAL_BLOCKER_ACTIVE');
  }
  if (!projection.retry.satisfied) addUnique(projection.discrepancies, 'RETRY_TRIGGER_UNSATISFIED');

  projection.execution.terminal = TERMINAL_EXECUTION.has(String(projection.execution.status || ''));
  if (projection.execution.status === 'completed' && !projection.execution.reconciled) {
    addUnique(projection.discrepancies, 'EXECUTION_NOT_RECONCILED');
  }
  if (projection.execution.participant_observed === false) {
    addUnique(projection.discrepancies, 'SCHEDULED_PARTICIPANT_UNOBSERVED');
  }

  projection.terminal = projection.linear.terminal
    || projection.github.merged
    || TERMINAL_GITHUB.has(String(projection.github.state || ''));
  projection.executable = !projection.terminal
    && projection.blockers.length === 0
    && projection.retry.satisfied
    && projection.execution.participant_observed !== false;

  projection.owner_action.decisions = [...decisions.values()].sort((a, b) => a.category.localeCompare(b.category));
  projection.owner_action.required = projection.owner_action.decisions.length > 0;
  if (projection.owner_action.required) projection.next_action = projection.owner_action.decisions[0].recommended_action;
  else if (projection.discrepancies.includes('VERIFICATION_STALE')) projection.next_action = 'Re-verify the exact current head.';
  else if (projection.discrepancies.includes('CHECKS_FAILED')) projection.next_action = 'Correct the failing checks before verification.';
  else if (projection.discrepancies.includes('EXECUTION_NOT_RECONCILED')) projection.next_action = 'Reconcile the completed execution into its canonical work packet.';
  else if (!projection.executable) projection.next_action = 'Resolve blockers before dispatch.';
  else projection.next_action = 'No owner action required.';

  const digestable = { ...projection, projection_sha256: null };
  projection.projection_sha256 = await sha256Text(canonicalJson(digestable));
  return projection;
}