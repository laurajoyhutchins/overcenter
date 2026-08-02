import { canonicalJson, sha256Text } from './canonical-json.js';

export const REDUCER_VERSION = 'portfolio-reducer-v2';

const TERMINAL_LINEAR = new Set(['done', 'completed', 'canceled', 'cancelled', 'duplicate']);
const TERMINAL_GITHUB = new Set(['closed', 'merged']);
const TERMINAL_EXECUTION = new Set([
  'completed', 'blocked', 'failed', 'no_change', 'canceled',
  'expired', 'invalidated', 'quarantined',
]);
const TERMINAL_WORK = new Set(['completed', 'canceled']);
const EXECUTABLE_WORK = new Set(['ready', 'in_progress']);
const OPEN_STATES = new Set(['open', 'active', 'new', 'unresolved', 'accepted']);
const CLOSED_STATES = new Set([
  'resolved', 'closed', 'completed', 'canceled', 'cancelled',
  'superseded', 'rejected',
]);
const KNOWN_FACTS = new Set([
  'github.pull_request', 'github.head', 'github.checks', 'github.verification',
  'linear.state', 'linear.blocker', 'linear.retry',
  'gateway.execution', 'gateway.reconciliation',
  'schedule.participant', 'owner.decision',
  'portfolio.work', 'portfolio.dependency', 'portfolio.transition',
  'lore.record', 'lore.finding', 'lore.transaction', 'lore.verification', 'lore.proposal',
  'deciduous.node', 'deciduous.edge', 'deciduous.outcome',
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

function strings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort()
    : [];
}

function clean(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function normalizedState(value) {
  return clean(value, null)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_') ?? null;
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
    idempotency_key: observation.idempotency_key,
  });
}

function keyed(map, key, value) {
  if (key) map.set(String(key), value);
}

function mapValues(map, sorter = null) {
  const values = [...map.values()];
  if (sorter) values.sort(sorter);
  return values;
}

function relationMap(dependencies, relation) {
  if (relation === 'blocked_by') return dependencies.blockedBy;
  if (relation === 'blocks') return dependencies.blocks;
  return dependencies.relatedTo;
}

async function priorRevision(entityKey, ordered, index) {
  if (index <= 0) return null;
  const prior = await reduceEntity(entityKey, ordered.slice(0, index));
  return prior.projection_sha256;
}

export async function reduceEntity(entityKey, observations) {
  const ordered = sorted(observations);
  const projection = {
    schema: 'portfolio-entity-projection-v2',
    entity_key: entityKey,
    entity_type: ordered.at(-1)?.entity_type || 'unknown',
    source_revisions: {},
    lifecycle: null,
    terminal: false,
    executable: true,
    portfolio: {
      semantic_key: null,
      title: null,
      objective: null,
      repository: null,
      state: null,
      priority: null,
      route: null,
      risk_class: null,
      acceptance: [],
      observed_at: null,
      latest_transition: null,
      rejected_transitions: [],
    },
    dependencies: { blocked_by: [], blocks: [], related_to: [] },
    lore: {
      records: [],
      findings: [],
      open_findings: [],
      transactions: [],
      proposals: [],
      constraints: [],
      procedures: [],
      verification: { status: null, repository_revision: null, verified_at: null },
    },
    deciduous: {
      nodes: [],
      edges: [],
      active_goals: [],
      unresolved: [],
      latest_outcome: null,
      outcomes: [],
    },
    github: {
      state: null,
      merged: false,
      head_sha: null,
      checks_head_sha: null,
      checks_conclusion: null,
    },
    linear: { workflow_state: null, lifecycle: null, terminal: false },
    execution: {
      execution_id: null,
      status: null,
      terminal: false,
      reconciled: false,
      participant_observed: null,
      participant_disposition: null,
    },
    blockers: [],
    retry: { satisfied: true, trigger: null },
    verification: { verdict: null, head_sha: null, fresh: false, verified_at: null },
    discrepancies: [],
    owner_action: { required: false, decisions: [], rejected: [] },
    next_action: null,
    unknown_fact_types: [],
    observation_count: ordered.length,
    input_watermark: ordered.at(-1)?.observed_at || null,
    reducer_version: REDUCER_VERSION,
    projection_sha256: null,
  };

  const decisions = new Map();
  const sourceClocks = new Map();
  const records = new Map();
  const findings = new Map();
  const transactions = new Map();
  const proposals = new Map();
  const nodes = new Map();
  const edges = new Map();
  const outcomes = new Map();
  const dependencies = {
    blockedBy: new Map(),
    blocks: new Map(),
    relatedTo: new Map(),
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const observation = ordered[index];
    const payload = observation.payload && typeof observation.payload === 'object'
      ? observation.payload
      : {};
    const sourceUpdatedAt = payload.source_updated_at
      ? Date.parse(String(payload.source_updated_at))
      : null;
    const priorSourceClock = sourceClocks.get(observation.source_system);
    if (Number.isFinite(sourceUpdatedAt) && priorSourceClock && sourceUpdatedAt < priorSourceClock.time) {
      addUnique(projection.discrepancies, 'SOURCE_REVISION_REGRESSION');
      continue;
    }
    projection.source_revisions[observation.source_system] = observation.source_revision;
    if (Number.isFinite(sourceUpdatedAt)) {
      sourceClocks.set(observation.source_system, {
        time: sourceUpdatedAt,
        revision: observation.source_revision,
      });
    }
    if (!KNOWN_FACTS.has(observation.fact_type)) {
      addUnique(projection.unknown_fact_types, observation.fact_type);
      addUnique(projection.discrepancies, 'UNKNOWN_FACT_TYPE');
      continue;
    }

    if (
      (observation.fact_type === 'portfolio.transition' || observation.fact_type === 'owner.decision')
      && payload.expected_revision
    ) {
      const actualRevision = await priorRevision(entityKey, ordered, index);
      if (actualRevision !== String(payload.expected_revision)) {
        const rejected = {
          idempotency_key: observation.idempotency_key,
          expected_revision: String(payload.expected_revision),
          actual_revision: actualRevision,
          observed_at: observation.observed_at,
          summary: String(payload.summary || ''),
        };
        if (observation.fact_type === 'portfolio.transition') {
          projection.portfolio.rejected_transitions.push(rejected);
          addUnique(projection.discrepancies, 'PORTFOLIO_TRANSITION_STALE');
        } else {
          projection.owner_action.rejected.push(rejected);
          addUnique(projection.discrepancies, 'OWNER_DECISION_STALE');
        }
        continue;
      }
    }

    switch (observation.fact_type) {
      case 'portfolio.work':
        projection.portfolio.semantic_key = clean(
          payload.semantic_key,
          projection.portfolio.semantic_key
        );
        projection.portfolio.title = clean(payload.title, projection.portfolio.title);
        projection.portfolio.objective = clean(payload.objective, projection.portfolio.objective);
        projection.portfolio.repository = clean(
          payload.repository,
          projection.portfolio.repository
        );
        projection.portfolio.state = normalizedState(payload.state) ?? projection.portfolio.state;
        projection.portfolio.priority = normalizedState(payload.priority)
          ?? projection.portfolio.priority;
        projection.portfolio.route = clean(payload.route, projection.portfolio.route);
        projection.portfolio.risk_class = clean(
          payload.risk_class,
          projection.portfolio.risk_class
        );
        if (Array.isArray(payload.acceptance)) {
          projection.portfolio.acceptance = strings(payload.acceptance);
        }
        projection.portfolio.observed_at = observation.observed_at;
        break;

      case 'portfolio.dependency': {
        const relation = normalizedState(payload.relation) || 'related_to';
        const target = clean(payload.target, null);
        if (!target) break;
        const map = relationMap(dependencies, relation);
        if (payload.active === false) map.delete(target);
        else map.set(target, target);
        break;
      }

      case 'portfolio.transition': {
        const nextState = normalizedState(payload.state)
          ?? ({
            completed: 'completed',
            blocked: 'blocked',
            handed_off: 'ready',
            pivoted: 'in_progress',
          }[normalizedState(payload.disposition)])
          ?? projection.portfolio.state;
        projection.portfolio.state = nextState;
        projection.portfolio.latest_transition = {
          idempotency_key: observation.idempotency_key,
          disposition: normalizedState(payload.disposition),
          state: nextState,
          summary: String(payload.summary || ''),
          evidence: strings(payload.evidence),
          next_action: clean(payload.next_action, null),
          observed_at: observation.observed_at,
          source_revision: observation.source_revision,
        };
        break;
      }

      case 'lore.record': {
        const recordId = clean(payload.record_id ?? payload.id, null);
        keyed(records, recordId, {
          record_id: recordId,
          record_type: clean(payload.record_type ?? payload.type, 'record'),
          title: clean(payload.title, ''),
          status: normalizedState(payload.status) ?? 'accepted',
          summary: clean(payload.summary, ''),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'lore.finding': {
        const findingId = clean(payload.finding_id ?? payload.id, null);
        keyed(findings, findingId, {
          finding_id: findingId,
          severity: normalizedState(payload.severity) ?? 'unspecified',
          status: normalizedState(payload.status) ?? 'open',
          blocking: payload.blocking !== false,
          summary: clean(payload.summary, ''),
          remediation: clean(payload.remediation, null),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'lore.transaction': {
        const transactionId = clean(payload.transaction_id ?? payload.id, null);
        keyed(transactions, transactionId, {
          transaction_id: transactionId,
          status: normalizedState(payload.status) ?? 'accepted',
          records: strings(payload.records),
          summary: clean(payload.summary, ''),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'lore.verification':
        projection.lore.verification = {
          status: normalizedState(payload.status ?? payload.verdict),
          repository_revision: clean(
            payload.repository_revision ?? payload.head_sha,
            null
          ),
          verified_at: clean(payload.verified_at, observation.observed_at),
        };
        break;

      case 'lore.proposal': {
        const proposalId = clean(payload.proposal_id ?? payload.id, null);
        keyed(proposals, proposalId, {
          proposal_id: proposalId,
          title: clean(payload.title, ''),
          status: normalizedState(payload.status) ?? 'proposed',
          summary: clean(payload.summary, ''),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'deciduous.node': {
        const nodeId = clean(payload.node_id ?? payload.id, null);
        keyed(nodes, nodeId, {
          node_id: nodeId,
          node_type: normalizedState(payload.node_type ?? payload.type) ?? 'observation',
          title: clean(payload.title, ''),
          status: normalizedState(payload.status) ?? 'active',
          summary: clean(payload.summary, ''),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'deciduous.edge': {
        const edgeId = clean(
          payload.edge_id ?? payload.id,
          `${payload.from ?? ''}:${payload.relation ?? ''}:${payload.to ?? ''}`
        );
        keyed(edges, edgeId, {
          edge_id: edgeId,
          from: clean(payload.from, null),
          to: clean(payload.to, null),
          relation: normalizedState(payload.relation) ?? 'related_to',
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        });
        break;
      }

      case 'deciduous.outcome': {
        const outcomeId = clean(
          payload.outcome_id ?? payload.id,
          observation.idempotency_key
        );
        const outcome = {
          outcome_id: outcomeId,
          status: normalizedState(payload.status) ?? 'completed',
          summary: clean(payload.summary, ''),
          evidence: strings(payload.evidence),
          source_revision: observation.source_revision,
          observed_at: observation.observed_at,
        };
        keyed(outcomes, outcomeId, outcome);
        projection.deciduous.latest_outcome = outcome;
        break;
      }

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
        projection.github.checks_conclusion = payload.conclusion
          ? String(payload.conclusion).toLowerCase()
          : null;
        break;

      case 'github.verification':
        projection.verification.verdict = payload.verdict ? String(payload.verdict) : null;
        projection.verification.head_sha = payload.head_sha ? String(payload.head_sha) : null;
        projection.verification.verified_at = payload.verified_at || observation.observed_at;
        break;

      case 'linear.state':
        projection.linear.workflow_state = payload.workflow_state
          ? String(payload.workflow_state)
          : null;
        projection.linear.lifecycle = payload.lifecycle ? String(payload.lifecycle) : null;
        if (!projection.portfolio.state) projection.lifecycle = projection.linear.lifecycle;
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
        projection.execution.execution_id = payload.execution_id
          ? String(payload.execution_id)
          : projection.execution.execution_id;
        projection.execution.status = payload.status
          ? String(payload.status).toLowerCase()
          : null;
        if (payload.reconciled != null) {
          projection.execution.reconciled = Boolean(payload.reconciled);
        }
        break;

      case 'gateway.reconciliation':
        projection.execution.execution_id = payload.execution_id
          ? String(payload.execution_id)
          : projection.execution.execution_id;
        projection.execution.reconciled = payload.reconciled !== false;
        break;

      case 'schedule.participant':
        projection.execution.participant_observed = payload.observed !== false;
        projection.execution.participant_disposition = payload.disposition
          ? String(payload.disposition)
          : null;
        break;

      case 'owner.decision':
        upsertDecision(decisions, payload, observation);
        break;
    }
  }

  projection.dependencies = {
    blocked_by: [...dependencies.blockedBy.keys()].sort(),
    blocks: [...dependencies.blocks.keys()].sort(),
    related_to: [...dependencies.relatedTo.keys()].sort(),
  };
  projection.lore.records = mapValues(
    records,
    (a, b) => a.record_id.localeCompare(b.record_id)
  );
  projection.lore.findings = mapValues(
    findings,
    (a, b) => a.finding_id.localeCompare(b.finding_id)
  );
  projection.lore.open_findings = projection.lore.findings.filter((finding) =>
    !CLOSED_STATES.has(finding.status)
    && (OPEN_STATES.has(finding.status) || !finding.status)
  );
  projection.lore.transactions = mapValues(
    transactions,
    (a, b) => a.transaction_id.localeCompare(b.transaction_id)
  );
  projection.lore.proposals = mapValues(
    proposals,
    (a, b) => a.proposal_id.localeCompare(b.proposal_id)
  );
  projection.lore.constraints = projection.lore.records.filter((record) =>
    record.record_type === 'constraint' && !CLOSED_STATES.has(record.status)
  );
  projection.lore.procedures = projection.lore.records.filter((record) =>
    record.record_type === 'procedure' && !CLOSED_STATES.has(record.status)
  );

  projection.deciduous.nodes = mapValues(
    nodes,
    (a, b) => a.node_id.localeCompare(b.node_id)
  );
  projection.deciduous.edges = mapValues(
    edges,
    (a, b) => a.edge_id.localeCompare(b.edge_id)
  );
  projection.deciduous.outcomes = mapValues(
    outcomes,
    (a, b) => a.observed_at.localeCompare(b.observed_at)
      || a.outcome_id.localeCompare(b.outcome_id)
  );
  projection.deciduous.latest_outcome = projection.deciduous.outcomes.at(-1)
    ?? projection.deciduous.latest_outcome;
  projection.deciduous.active_goals = projection.deciduous.nodes.filter((node) =>
    node.node_type === 'goal' && !CLOSED_STATES.has(node.status)
  );
  projection.deciduous.unresolved = projection.deciduous.nodes.filter((node) =>
    node.node_type !== 'outcome' && !CLOSED_STATES.has(node.status)
  );

  const workflow = String(projection.linear.workflow_state || '').toLowerCase();
  const lifecycle = String(projection.linear.lifecycle || '').toUpperCase();
  projection.linear.terminal = TERMINAL_LINEAR.has(workflow);
  if (
    projection.linear.terminal
    && ['BUILDABLE', 'IN_PROGRESS', 'AWAITING_HUMAN', 'AWAITING_LAURA'].includes(lifecycle)
  ) {
    addUnique(projection.discrepancies, 'LINEAR_TERMINAL_LIFECYCLE_CONTRADICTION');
  }

  if (projection.dependencies.blocked_by.length) {
    projection.blockers.push({
      code: 'PORTFOLIO_DEPENDENCY_BLOCKED',
      type: 'dependency',
      description: `Blocked by ${projection.dependencies.blocked_by.join(', ')}`,
    });
    addUnique(projection.discrepancies, 'PORTFOLIO_DEPENDENCY_BLOCKED');
  }
  for (const finding of projection.lore.open_findings.filter((item) => item.blocking)) {
    projection.blockers.push({
      code: 'LORE_FINDING_OPEN',
      type: 'lore',
      description: finding.summary || finding.finding_id,
      finding_id: finding.finding_id,
    });
  }
  if (projection.lore.open_findings.some((item) => item.blocking)) {
    addUnique(projection.discrepancies, 'LORE_FINDING_OPEN');
  }

  if (projection.github.checks_conclusion === 'failure') {
    addUnique(projection.discrepancies, 'CHECKS_FAILED');
    projection.blockers.push({
      code: 'CHECKS_FAILED',
      type: 'verification',
      description: 'One or more checks failed.',
    });
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
  if (!projection.retry.satisfied) {
    addUnique(projection.discrepancies, 'RETRY_TRIGGER_UNSATISFIED');
  }

  projection.execution.terminal = TERMINAL_EXECUTION.has(
    String(projection.execution.status || '')
  );
  if (projection.execution.status === 'completed' && !projection.execution.reconciled) {
    addUnique(projection.discrepancies, 'EXECUTION_NOT_RECONCILED');
  }
  if (projection.execution.participant_observed === false) {
    addUnique(projection.discrepancies, 'SCHEDULED_PARTICIPANT_UNOBSERVED');
  }

  projection.owner_action.decisions = [...decisions.values()].sort((a, b) =>
    a.category.localeCompare(b.category)
  );
  projection.owner_action.required = projection.owner_action.decisions.length > 0;
  if (projection.owner_action.required && !TERMINAL_WORK.has(projection.portfolio.state)) {
    projection.portfolio.state = 'awaiting_owner';
  }

  const workTerminal = TERMINAL_WORK.has(projection.portfolio.state);
  projection.terminal = workTerminal
    || projection.linear.terminal
    || projection.github.merged
    || TERMINAL_GITHUB.has(String(projection.github.state || ''));

  const hasPortfolioWork = Boolean(
    projection.portfolio.semantic_key || projection.entity_type === 'work_item'
  );
  const baseExecutable = hasPortfolioWork
    ? EXECUTABLE_WORK.has(projection.portfolio.state)
    : !projection.terminal;
  projection.executable = baseExecutable
    && !projection.terminal
    && projection.blockers.length === 0
    && projection.retry.satisfied
    && projection.execution.participant_observed !== false
    && !projection.owner_action.required;

  projection.lifecycle = projection.portfolio.state ?? projection.linear.lifecycle;

  if (projection.owner_action.required) {
    projection.next_action = projection.owner_action.decisions[0].recommended_action;
  } else if (projection.discrepancies.includes('PORTFOLIO_TRANSITION_STALE')) {
    projection.next_action = 'Refresh the work projection before recording another outcome.';
  } else if (projection.lore.open_findings.some((item) => item.blocking)) {
    const finding = projection.lore.open_findings.find((item) => item.blocking);
    projection.next_action = `Resolve LORE finding ${finding.finding_id}.`;
  } else if (projection.dependencies.blocked_by.length) {
    projection.next_action = `Wait for or resolve ${projection.dependencies.blocked_by[0]}.`;
  } else if (projection.discrepancies.includes('VERIFICATION_STALE')) {
    projection.next_action = 'Re-verify the exact current head.';
  } else if (projection.discrepancies.includes('CHECKS_FAILED')) {
    projection.next_action = 'Correct the failing checks before verification.';
  } else if (projection.discrepancies.includes('EXECUTION_NOT_RECONCILED')) {
    projection.next_action = 'Reconcile the completed execution into its canonical work item.';
  } else if (projection.portfolio.latest_transition?.next_action) {
    projection.next_action = projection.portfolio.latest_transition.next_action;
  } else if (projection.portfolio.state === 'backlog') {
    projection.next_action = 'Promote the work item to ready when its prerequisites are satisfied.';
  } else if (projection.portfolio.state === 'completed') {
    projection.next_action = 'No further work is required.';
  } else if (!projection.executable) {
    projection.next_action = 'Resolve blockers before dispatch.';
  } else {
    projection.next_action = projection.portfolio.objective || 'Proceed with the eligible work item.';
  }

  const digestable = { ...projection, projection_sha256: null };
  projection.projection_sha256 = await sha256Text(canonicalJson(digestable));
  return projection;
}