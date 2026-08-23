import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from './canonical-json.js';
import { repositoryIdentity } from './work-identity.js';
import { createPostgresRepositoryLifecycleService } from './repository-disposition.js';
import { createPostgresSkillExecutionService } from './skill-execution.js';

const ACTIVE_STATE = 'In Progress'; // legacy pre-cutover receipt marker only; the live Linear state is Started (unused)
const EXECUTABLE_STATE = 'Todo';
const SLOT_OWNERSHIP_PROTOCOL = 'lease-slot-v2';
const DEFAULT_LEASE_SECONDS = 1800;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 3600;
const MAX_TOTAL_LEASE_SECONDS = 10800;
const DEFAULT_HEARTBEAT_SECONDS = 1800;
const MIN_HEARTBEAT_SECONDS = 60;
const MAX_HEARTBEAT_SECONDS = 3600;
const MAX_SAME_PROGRESS_HEARTBEATS = 2;
const EXECUTION_LANES = new Set([
  'lane:repo-implementation',
  'lane:source-implementation',
  'lane:verification',
  'lane:integration',
]);
const SUCCESSOR = Object.freeze({
  'lane:repo-implementation': { state: 'Todo', lane: 'lane:verification' },
  'lane:source-implementation': { state: 'Todo', lane: 'lane:verification' },
  'lane:verification': { state: 'Todo', lane: 'lane:integration' },
  'lane:integration': { state: 'Done', lane: 'lane:integration' },
});
const PHASE_NEXT_ACTION = Object.freeze({
  'lane:repo-implementation': 'Repair the current authoritative repository candidate, then prepare it for verification.',
  'lane:source-implementation': 'Repair the current authoritative source/data candidate, then prepare it for verification.',
  'lane:verification': 'Verify the current authoritative candidate against its acceptance evidence.',
  'lane:integration': 'Integrate the exact verified candidate under current repository policy.',
});
const COMPLETED_TRANSITIONS = Object.freeze({
  'lane:repo-implementation': new Set(['Todo|lane:verification']),
  'lane:source-implementation': new Set(['Todo|lane:verification']),
  'lane:verification': new Set([
    'Todo|lane:integration',
    'Todo|lane:repo-implementation',
    'Todo|lane:source-implementation',
  ]),
  'lane:integration': new Set([
    'Done|lane:integration',
    'Todo|lane:verification',
    'Todo|lane:repo-implementation',
    'Todo|lane:source-implementation',
  ]),
});
const DISPOSITIONS = new Set(['completed', 'requeue', 'blocked']);
const REQUEUE_CLASSES = new Set([
  'resume_progress',
  'retry_runtime_failure',
  'wait_for_observable_change',
  'stale_candidate',
  'insufficient_execution_window',
]);
// Checkpoint next actions are bounded continuation evidence, not an authority or routing enum.
// Keep the schema stable while allowing the worker to describe the actual next mechanical action.
const NEXT_ACTION_MAX_LENGTH = 128;
const CONTINUATION_SCHEMA = 'work-continuation-v1';
const CHECKPOINT_SCHEMA = 'work-checkpoint-v1';
const INTERNAL_LEASE_REF = Symbol('internal-lease-ref');
const LEASE_REF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(code, message, details = null) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

function requiredString(value, name, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw err('REQUEST_INVALID', `${name} is invalid`, { field: name });
  return text;
}

export function normalizeLeaseRef(value) {
  const ref = requiredString(value, 'lease_ref', 128);
  if (!LEASE_REF_UUID.test(ref)) throw err('REQUEST_INVALID', 'lease_ref must be a UUID', { field: 'lease_ref' });
  return ref.toLowerCase();
}

function optionalString(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(String(value), name, max);
}

function normalizeLane(value) {
  if (!value) return null;
  const text = String(value).trim();
  return text.startsWith('lane:') ? text : `lane:${text}`;
}

function laneOf(issue) {
  const lanes = (issue.labels || []).filter(label => String(label.name || '').startsWith('lane:'));
  return lanes.length === 1 ? lanes[0] : null;
}

function stateByName(issue, name) {
  return (issue.teamStates || []).find(state => state.name === name) || null;
}

function labelByName(issue, name) {
  return (issue.teamLabels || []).find(label => label.name === name) || null;
}

function isExecutable(issue) {
  const lane = laneOf(issue);
  return issue.archivedAt == null
    && issue.state?.name === EXECUTABLE_STATE
    && lane
    && EXECUTION_LANES.has(lane.name);
}

function parseField(description, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'i');
  for (const rawLine of String(description || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
    const match = line.match(matcher);
    if (match) return match[1].trim();
  }
  return null;
}

function normalizeProse(value) {
  return value == null ? null : String(value).replace(/\s+/g, ' ').trim() || null;
}

function parseManagedExecutionDescription(description) {
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');
  const managed = {
    repository: normalizeProse(parseField(description, 'Repository')),
    authority: normalizeProse(parseField(description, 'Authority') || parseField(description, 'GitHub authority')),
    outcome: normalizeProse(parseField(description, 'Outcome')),
    next_action: normalizeProse(parseField(description, 'Next action')),
    objective: null,
    gate: null,
    acceptance: parseField(description, 'Acceptance') ? [normalizeProse(parseField(description, 'Acceptance'))].filter(Boolean) : [],
    exact_coordinate: normalizeProse(parseField(description, 'Exact coordinate')),
    owner_impact: normalizeProse(parseField(description, 'Owner impact')),
    promotion_condition: normalizeProse(parseField(description, 'Promotion condition')),
  };
  const sectionNames = new Map([
    ['objective:', 'objective'],
    ['gate:', 'gate'],
    ['acceptance:', 'acceptance'],
  ]);
  for (let i = 0; i < lines.length; i += 1) {
    const key = sectionNames.get(lines[i].trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').toLowerCase());
    if (!key) continue;
    const values = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (!trimmed) break;
      const structural = trimmed.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
      if (sectionNames.has(structural.toLowerCase())) break;
      if (/^(repository|authority|github authority|outcome|next action|exact coordinate|owner impact|promotion condition)\s*:/i.test(structural)) break;
      values.push(structural.replace(/^[-*]\s+/, ''));
    }
    if (key === 'acceptance') managed.acceptance = values.map(normalizeProse).filter(Boolean);
    else managed[key] = normalizeProse(values.join(' '));
  }
  return managed;
}

function executionProjection(issue) {
  const lane = laneOf(issue);
  const managed = parseManagedExecutionDescription(issue.description);
  return {
    work_ref: issue.identifier || null,
    project: issue.project?.name || null,
    project_id: issue.project?.id || null,
    team: issue.team?.name || null,
    team_id: issue.team?.id || null,
    archived_at: issue.archivedAt || null,
    state: issue.state?.name || null,
    state_id: issue.state?.id || null,
    state_type: issue.state?.type || null,
    lane: lane?.name || null,
    lane_id: lane?.id || null,
    priority: issue.priority ?? null,
    ...managed,
    dependencies: (issue.relations || []).map(r => ({
      type: r.type || null,
      work_ref: r.relatedIssue?.identifier || null,
    })).sort((a, b) => `${a.type}|${a.work_ref}`.localeCompare(`${b.type}|${b.work_ref}`)),
  };
}

function legacyExecutionProjection(snapshotValue) {
  if (!snapshotValue || typeof snapshotValue !== 'object') return null;
  const expected = {};
  const copy = (from, to = from) => { if (Object.prototype.hasOwnProperty.call(snapshotValue, from)) expected[to] = snapshotValue[from]; };
  for (const key of ['project','project_id','archived_at','state','state_id','lane','lane_id','priority','repository','authority','exact_coordinate','owner_impact']) copy(key);
  if (Object.prototype.hasOwnProperty.call(snapshotValue, 'acceptance')) {
    expected.acceptance = snapshotValue.acceptance == null ? [] : [normalizeProse(snapshotValue.acceptance)].filter(Boolean);
  }
  if (Array.isArray(snapshotValue.relations)) {
    expected.dependencies = snapshotValue.relations.map(r => ({ type: r.type || null, work_ref: r.work_ref || null }))
      .sort((a, b) => `${a.type}|${a.work_ref}`.localeCompare(`${b.type}|${b.work_ref}`));
  }
  return expected;
}

function projectionMatchesExpected(issue, expected) {
  if (!expected || typeof expected !== 'object') return false;
  const current = executionProjection(issue);
  const comparable = {};
  for (const key of Object.keys(expected)) comparable[key] = current[key];
  return canonicalJson(comparable) === canonicalJson(expected);
}

function projectionDiff(expected, current) {
  const keys = [...new Set([...Object.keys(expected || {}), ...Object.keys(current || {})])].sort();
  return keys.filter(key => canonicalJson(expected?.[key]) !== canonicalJson(current?.[key]));
}

// Repository coordinate normalization is centralized in lib/work-identity.js.

function scopeAllowsProjection(scope, projection) {
  if (!scope) return true;
  if (scope.project && projection.project !== scope.project && projection.project_id !== scope.project) return false;
  if (scope.team && projection.team !== scope.team && projection.team_id !== scope.team) return false;
  if (Array.isArray(scope.projects) && scope.projects.length
    && !scope.projects.includes(projection.project)
    && !scope.projects.includes(projection.project_id)) return false;
  if (Array.isArray(scope.lanes) && scope.lanes.length && !scope.lanes.includes(projection.lane)) return false;
  if (Array.isArray(scope.repositories) && scope.repositories.length) {
    const repository = repositoryIdentity(projection.repository);
    if (!scope.repositories.some(candidate => repositoryIdentity(candidate) === repository)) return false;
  }
  return true;
}

function snapshot(issue) {
  const lane = laneOf(issue);
  return {
    title: issue.title,
    description: issue.description || '',
    priority: issue.priority ?? null,
    archived_at: issue.archivedAt || null,
    project: issue.project?.name || null,
    project_id: issue.project?.id || null,
    state: issue.state?.name || null,
    state_id: issue.state?.id || null,
    lane: lane?.name || null,
    lane_id: lane?.id || null,
    labels: (issue.labels || []).map(label => ({ id: label.id || null, name: label.name || null }))
      .sort((a, b) => `${a.name}|${a.id}`.localeCompare(`${b.name}|${b.id}`)),
    repository: parseField(issue.description, 'Repository'),
    authority: parseField(issue.description, 'Authority') || parseField(issue.description, 'GitHub authority'),
    exact_coordinate: parseField(issue.description, 'Exact coordinate'),
    acceptance: parseField(issue.description, 'Acceptance') || parseField(issue.description, 'Lane exit'),
    owner_impact: parseField(issue.description, 'Owner impact'),
    relations: (issue.relations || []).map(r => ({
      type: r.type,
      work_ref: r.relatedIssue?.identifier || null,
      title: r.relatedIssue?.title || null,
    })).sort((a, b) => `${a.type}|${a.work_ref}|${a.title}`.localeCompare(`${b.type}|${b.work_ref}|${b.title}`)),
  };
}

function snapshotMatchesExpected(issue, expected) {
  if (!expected || typeof expected !== 'object') return false;
  const current = snapshot(issue);
  const comparable = {};
  for (const key of Object.keys(expected)) comparable[key] = current[key];
  return canonicalJson(comparable) === canonicalJson(expected);
}

function leaseExecutionProjection(lease) {
  return lease?.claim_receipt?.execution_projection
    || legacyExecutionProjection(lease?.claim_receipt?.snapshot || null);
}

function leaseSnapshotMatches(issue, lease) {
  return projectionMatchesExpected(issue, leaseExecutionProjection(lease));
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function defaultTokenFactory() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `wlt_${base64url(bytes)}`;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw err('REQUEST_INVALID', 'evidence must be an array of at most 50 items');
  return value.map((item, index) => ({
    kind: requiredString(item?.kind, `evidence[${index}].kind`, 128),
    ref: requiredString(item?.ref, `evidence[${index}].ref`, 1024),
  }));
}

function normalizeSha(value, name, length) {
  const text = requiredString(value, name, length);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(text)) throw err('REQUEST_INVALID', `${name} must be a ${length}-character hex digest`, { field: name });
  return text.toLowerCase();
}

function normalizeCandidate(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err('REQUEST_INVALID', 'candidate must be an object');
  const kind = requiredString(value.kind, 'candidate.kind', 64);
  if (kind === 'github_pull_request') {
    const pullRequest = Number(value.pull_request);
    if (!Number.isInteger(pullRequest) || pullRequest < 1) throw err('REQUEST_INVALID', 'candidate.pull_request must be a positive integer');
    return {
      kind,
      repository: requiredString(value.repository, 'candidate.repository', 256),
      pull_request: pullRequest,
      head_sha: normalizeSha(value.head_sha, 'candidate.head_sha', 40),
    };
  }
  if (kind === 'git_head') {
    return {
      kind,
      repository: requiredString(value.repository, 'candidate.repository', 256),
      branch: optionalString(value.branch, 'candidate.branch', 256),
      head_sha: normalizeSha(value.head_sha, 'candidate.head_sha', 40),
    };
  }
  if (kind === 'retained_object') {
    const size = value.size == null ? null : Number(value.size);
    if (size !== null && (!Number.isInteger(size) || size < 0)) throw err('REQUEST_INVALID', 'candidate.size must be a non-negative integer');
    return {
      kind,
      object_id: requiredString(value.object_id, 'candidate.object_id', 512),
      sha256: value.sha256 == null ? null : normalizeSha(value.sha256, 'candidate.sha256', 64),
      size,
    };
  }
  if (kind === 'source_coordinate') {
    return {
      kind,
      ref: requiredString(value.ref, 'candidate.ref', 1024),
      revision: optionalString(value.revision, 'candidate.revision', 1024),
    };
  }
  throw err('REQUEST_INVALID', 'candidate.kind is unsupported', { kind });
}

function normalizeAuthorityRevisions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 25) throw err('REQUEST_INVALID', 'authority_revisions must be an array of at most 25 items');
  return value.map((item, index) => ({
    kind: requiredString(item?.kind, `authority_revisions[${index}].kind`, 128),
    ref: requiredString(item?.ref, `authority_revisions[${index}].ref`, 1024),
    revision: requiredString(item?.revision, `authority_revisions[${index}].revision`, 1024),
  }));
}

function normalizeCheckpointPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err('REQUEST_INVALID', 'checkpoint must be an object');
  if (value.schema != null && value.schema !== CHECKPOINT_SCHEMA) throw err('REQUEST_INVALID', `checkpoint.schema must be ${CHECKPOINT_SCHEMA}`);
  const nextAction = requiredString(value.next_action_kind, 'checkpoint.next_action_kind', NEXT_ACTION_MAX_LENGTH);
  return {
    schema: CHECKPOINT_SCHEMA,
    phase: requiredString(value.phase, 'checkpoint.phase', 128),
    next_action_kind: nextAction,
    candidate: normalizeCandidate(value.candidate),
    completed: normalizeEvidence(value.completed),
    evidence: normalizeEvidence(value.evidence),
    authority_revisions: normalizeAuthorityRevisions(value.authority_revisions),
  };
}

function normalizeContinuation(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err('REQUEST_INVALID', 'continuation must be an object');
  if (value.schema != null && value.schema !== CONTINUATION_SCHEMA) throw err('REQUEST_INVALID', `continuation.schema must be ${CONTINUATION_SCHEMA}`);
  const packet = {
    schema: CONTINUATION_SCHEMA,
    candidate: normalizeCandidate(value.candidate),
    checkpoint: value.checkpoint == null ? null : normalizeCheckpointPayload(value.checkpoint),
    evidence: normalizeEvidence(value.evidence),
  };
  if (!packet.candidate && !packet.checkpoint && packet.evidence.length === 0) throw err('REQUEST_INVALID', 'continuation must contain candidate, checkpoint, or evidence');
  return packet;
}

function normalizeLeaseSelector(input) {
  if (input?.[INTERNAL_LEASE_REF] === true) {
    return { lease_ref: normalizeLeaseRef(input?.lease_ref) };
  }
  return { lease_token: requiredString(input?.lease_token, 'lease_token', 256) };
}

function normalizeCheckpointRequest(input) {
  return {
    ...normalizeLeaseSelector(input),
    checkpoint: normalizeCheckpointPayload(input?.checkpoint),
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function normalizeHeartbeatRequest(input) {
  const extendSeconds = input?.extend_seconds == null ? DEFAULT_HEARTBEAT_SECONDS : Number(input.extend_seconds);
  if (!Number.isInteger(extendSeconds) || extendSeconds < MIN_HEARTBEAT_SECONDS || extendSeconds > MAX_HEARTBEAT_SECONDS) {
    throw err('REQUEST_INVALID', `extend_seconds must be an integer from ${MIN_HEARTBEAT_SECONDS} to ${MAX_HEARTBEAT_SECONDS}`);
  }
  return {
    ...normalizeLeaseSelector(input),
    run_id: requiredString(input?.run_id, 'run_id', 512),
    extend_seconds: extendSeconds,
    checkpoint: input?.checkpoint == null ? null : normalizeCheckpointPayload(input.checkpoint),
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function mergeContinuation(requestContinuation, checkpointRow, settlementEvidence) {
  const checkpoint = requestContinuation?.checkpoint || checkpointRow?.checkpoint || null;
  const evidence = requestContinuation?.evidence?.length ? requestContinuation.evidence : normalizeEvidence(settlementEvidence);
  const candidate = requestContinuation?.candidate || checkpoint?.candidate || null;
  if (!candidate && !checkpoint && evidence.length === 0) return null;
  return { schema: CONTINUATION_SCHEMA, candidate, checkpoint, evidence };
}

function normalizeClaimRequest(input) {
  const leaseSeconds = input?.lease_seconds == null ? DEFAULT_LEASE_SECONDS : Number(input.lease_seconds);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < MIN_LEASE_SECONDS || leaseSeconds > MAX_LEASE_SECONDS) {
    throw err('REQUEST_INVALID', `lease_seconds must be an integer from ${MIN_LEASE_SECONDS} to ${MAX_LEASE_SECONDS}`);
  }
  return {
    work_ref: requiredString(input?.work_ref, 'work_ref', 128),
    run_id: requiredString(input?.run_id, 'run_id', 512),
    expected_revision: optionalString(input?.expected_revision, 'expected_revision', 256),
    expected_state: optionalString(input?.expected_state, 'expected_state', 128),
    expected_lane: normalizeLane(optionalString(input?.expected_lane, 'expected_lane', 128)),
    lease_seconds: leaseSeconds,
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function normalizeSettleRequest(input) {
  const disposition = requiredString(input?.disposition, 'disposition', 32).toLowerCase();
  if (!DISPOSITIONS.has(disposition)) throw err('REQUEST_INVALID', 'disposition must be completed, requeue, or blocked');
  const reason = optionalString(input?.reason, 'reason', 2000);
  const promotion = optionalString(input?.promotion_condition, 'promotion_condition', 2000);
  if (disposition === 'blocked' && (!reason || !promotion)) {
    throw err('REQUEST_INVALID', 'blocked settlement requires reason and promotion_condition');
  }
  const requeueClass = optionalString(input?.requeue_class, 'requeue_class', 64);
  if (requeueClass && disposition !== 'requeue') throw err('REQUEST_INVALID', 'requeue_class is allowed only for requeue settlement');
  if (requeueClass && !REQUEUE_CLASSES.has(requeueClass)) throw err('REQUEST_INVALID', 'requeue_class is unsupported', { requeue_class: requeueClass });
  const nextState = optionalString(input?.next_state, 'next_state', 128);
  const nextLane = normalizeLane(optionalString(input?.next_lane, 'next_lane', 128));
  if ((nextState || nextLane) && disposition !== 'completed') {
    throw err('REQUEST_INVALID', 'next_state and next_lane are allowed only for completed settlement');
  }
  if ((nextState && !nextLane) || (!nextState && nextLane)) {
    throw err('REQUEST_INVALID', 'next_state and next_lane must be provided together');
  }
  return {
    ...normalizeLeaseSelector(input),
    disposition,
    evidence: normalizeEvidence(input?.evidence),
    reason,
    promotion_condition: promotion,
    requeue_class: requeueClass,
    continuation: normalizeContinuation(input?.continuation),
    next_state: nextState,
    next_lane: nextLane,
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function blockedDescription(description, reason, promotion) {
  const marker = '\n\n## Execution blocker\n';
  const base = String(description || '').split(marker)[0].trimEnd();
  return `${base}${marker}\nBlocked: ${reason}\n\nPromotion condition: ${promotion}`;
}

function successorDescription(description, target) {
  if (target?.state !== EXECUTABLE_STATE) return null;
  const nextAction = PHASE_NEXT_ACTION[target?.lane];
  if (!nextAction || !parseField(description, 'Next action')) return null;
  let changed = false;
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    const match = line.match(/^(\s*(?:#{1,6}\s*)?\*{0,2}Next action\s*:\*{0,2}\s*).+$/i);
    if (!match) return line;
    changed = true;
    return `${match[1]}${nextAction}`;
  });
  return changed ? lines.join('\n') : null;
}

function settlementPlan(lease, request, issue, continuation = null) {
  const replay_request = {
    disposition: request.disposition,
    evidence: request.evidence,
    reason: request.reason,
    promotion_condition: request.promotion_condition,
    requeue_class: request.requeue_class,
    continuation,
    next_state: request.next_state,
    next_lane: request.next_lane,
  };
  if (request.disposition === 'requeue') {
    return { state: lease.previous_state, lane: lease.previous_lane, description: null, evidence: request.evidence, requeue_class: request.requeue_class, continuation, replay_request };
  }
  if (request.disposition === 'blocked') {
    return {
      state: 'Backlog',
      lane: lease.previous_lane,
      description: blockedDescription(issue.description, request.reason, request.promotion_condition),
      evidence: request.evidence,
      continuation,
      replay_request,
    };
  }
  const successor = SUCCESSOR[lease.gate];
  if (!successor) throw err('NON_EXECUTABLE_WORK', `No configured successor exists for ${lease.gate}`);
  const target = request.next_state && request.next_lane
    ? { state: request.next_state, lane: request.next_lane }
    : successor;
  const allowed = COMPLETED_TRANSITIONS[lease.gate];
  if (!allowed?.has(`${target.state}|${target.lane}`)) {
    throw err('INVALID_SUCCESSOR', 'completed settlement successor is not valid for the current gate', {
      gate: lease.gate,
      next_state: target.state,
      next_lane: target.lane,
    });
  }
  return { ...target, description: successorDescription(issue.description, target), evidence: request.evidence, continuation, replay_request };
}

function issueMatches(issue, { state, lane }) {
  return issue.state?.name === state && laneOf(issue)?.name === lane;
}

function leaseOwnershipProtocol(lease) {
  return lease?.claim_receipt?.ownership_protocol || 'linear-in-progress-v1';
}

function leaseOwnedState(lease) {
  if (leaseOwnershipProtocol(lease) === SLOT_OWNERSHIP_PROTOCOL) return lease.previous_state;
  return lease?.claim_receipt?.current_state || ACTIVE_STATE;
}

function isSlotOwnedLease(lease) {
  return leaseOwnershipProtocol(lease) === SLOT_OWNERSHIP_PROTOCOL;
}

function publicLease(lease) {
  if (!lease) return null;
  return {
    lease_id: lease.lease_id,
    work_ref: lease.work_ref,
    gate: lease.gate,
    run_id: lease.run_id,
    status: lease.status,
    created_at: lease.created_at,
    expires_at: lease.expires_at,
  };
}

async function executionEvidence(issue) {
  const execution_projection = executionProjection(issue);
  return {
    execution_projection,
    execution_fingerprint: await sha256Text(canonicalJson(execution_projection)),
  };
}

async function continuationFromLease(store, lease) {
  if (!lease) return null;
  if (lease.status === 'settled' && lease.settle_plan?.continuation) {
    const packet = lease.settle_plan.continuation;
    return {
      packet,
      packet_sha256: lease.settle_plan.continuation_sha256 || await sha256Text(canonicalJson(packet)),
      successor_execution_fingerprint: lease.settle_receipt?.successor_execution_fingerprint || null,
      recovered_from_expired_lease: false,
      disposition: lease.settle_receipt?.disposition || lease.settle_plan?.replay_request?.disposition || null,
    };
  }
  if (lease.status === 'expired' && (lease.reconciliation?.restored === true || lease.reconciliation?.released_without_linear_mutation === true)) {
    const checkpointRow = await store.getLatestCheckpoint(lease.lease_id);
    if (!checkpointRow?.checkpoint) return null;
    const packet = { schema: CONTINUATION_SCHEMA, candidate: checkpointRow.checkpoint.candidate || null, checkpoint: checkpointRow.checkpoint, evidence: checkpointRow.checkpoint.evidence || [] };
    return {
      packet,
      packet_sha256: await sha256Text(canonicalJson(packet)),
      successor_execution_fingerprint: lease.reconciliation?.successor_execution_fingerprint || null,
      recovered_from_expired_lease: true,
      disposition: 'expired_recovery',
    };
  }
  return null;
}

async function resolveContinuation(store, workRef, gate, currentFingerprint) {
  if (typeof store.listContinuationCandidates !== 'function') return null;
  const candidates = await store.listContinuationCandidates(workRef, gate);
  for (let i = 0; i < candidates.length; i += 1) {
    const lease = candidates[i];
    const resolved = await continuationFromLease(store, lease);
    if (!resolved || resolved.successor_execution_fingerprint !== currentFingerprint) continue;
    let sameDigestCount = 0;
    for (let j = i; j < candidates.length; j += 1) {
      const prior = await continuationFromLease(store, candidates[j]);
      if (!prior || prior.packet_sha256 !== resolved.packet_sha256 || prior.successor_execution_fingerprint !== currentFingerprint) break;
      sameDigestCount += 1;
    }
    return {
      source_lease_id: lease.lease_id,
      source_run_id: lease.run_id,
      from_gate: lease.gate,
      recovered_from_expired_lease: resolved.recovered_from_expired_lease,
      disposition: resolved.disposition,
      packet_sha256: resolved.packet_sha256,
      packet: resolved.packet,
      no_progress_streak: Math.max(0, sameDigestCount - 1),
      stalled_continuation: sameDigestCount >= 3,
    };
  }
  return null;
}

export function createWorkLeaseService({ store, authoritative, repositoryLifecycle = null, skillRequirements = null, now = () => new Date().toISOString(), tokenFactory = defaultTokenFactory } = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function assertRepositoryExecutable(issue) {
    if (!repositoryLifecycle || typeof repositoryLifecycle.observe !== 'function') return null;
    const projection = executionProjection(issue);
    const repository = repositoryIdentity(projection.repository);
    if (!repository) throw err('NON_EXECUTABLE_WORK', 'work item has no canonical repository coordinate', { work_ref: issue?.identifier || null });
    const lifecycle = await repositoryLifecycle.observe(repository);
    if (lifecycle?.ordinary_work_enabled === false) {
      throw err('REPOSITORY_DISPOSED', 'repository disposition prohibits ordinary executable work', {
        repository: lifecycle.repository || repository,
        disposition: lifecycle.disposition || null,
        successor_repository: lifecycle.successor_repository || null,
      });
    }
    return lifecycle;
  }

  async function assertLeaseRepositoryExecutable(lease, issue, phase) {
    try {
      return await assertRepositoryExecutable(issue);
    } catch (error) {
      if (error?.code !== 'REPOSITORY_DISPOSED') throw error;
      const currentProjection = executionProjection(issue);
      await store.invalidateLease(lease.lease_id, {
        observed_revision: issue?.updatedAt || null,
        claimed_revision: lease.active_revision,
        changed_fields: ['repository_disposition'],
        claim: leaseExecutionProjection(lease),
        current: currentProjection,
        repository: error.details?.repository || repositoryIdentity(currentProjection.repository),
        disposition: error.details?.disposition || null,
        successor_repository: error.details?.successor_repository || null,
        invalidated_at: now(),
        phase,
        reconciliation_reason: 'repository_disposed',
      });
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      throw error;
    }
  }

  async function resolveLease(request) {
    if (request.lease_ref) return store.getLeaseById(request.lease_ref);
    const tokenHash = await sha256Text(request.lease_token);
    return store.getLeaseByTokenHash(tokenHash);
  }

  function byRef(input) {
    return { ...input, [INTERNAL_LEASE_REF]: true };
  }

  async function reconcileExpired(workRef, gate) {
    const slot = await store.getSlot(workRef, gate);
    if (!slot || Date.parse(slot.expires_at) > Date.parse(now())) return null;
    const lease = await store.getLeaseById(slot.lease_id);
    if (!lease) {
      await store.releaseSlot(workRef, gate, slot.lease_id);
      return { restored: false, reason: 'MISSING_LEASE' };
    }
    let current = await authoritative.getIssue(workRef);
    let restored = false;
    let releasedWithoutLinearMutation = false;
    let reason = 'AUTHORITATIVE_STATE_CHANGED';
    const ownedState = leaseOwnedState(lease);
    if (lease.status === 'active'
      && leaseSnapshotMatches(current, lease)
      && issueMatches(current, { state: ownedState, lane: lease.gate })) {
      if (isSlotOwnedLease(lease)) {
        releasedWithoutLinearMutation = true;
        reason = 'RELEASED_EXPIRED_SLOT_ONLY_OWNERSHIP';
      } else {
        current = await authoritative.transition({
          issue: current,
          expectedRevision: current.updatedAt,
          expectedState: ACTIVE_STATE,
          expectedLane: lease.gate,
          targetState: lease.previous_state,
          targetLane: lease.previous_lane,
        });
        restored = true;
        reason = 'RESTORED_PREVIOUS_EXECUTABLE_STATE';
      }
    }
    const continuationReady = restored || releasedWithoutLinearMutation;
    const restoredEvidence = continuationReady ? await executionEvidence(current) : null;
    const latestCheckpoint = typeof store.getLatestCheckpoint === 'function' ? await store.getLatestCheckpoint(lease.lease_id) : null;
    await store.markExpired(lease.lease_id, {
      restored,
      released_without_linear_mutation: releasedWithoutLinearMutation,
      reason,
      observed_revision: current.updatedAt,
      reconciled_at: now(),
      successor_execution_projection: restoredEvidence?.execution_projection || null,
      successor_execution_fingerprint: restoredEvidence?.execution_fingerprint || null,
      checkpoint_sha256: latestCheckpoint?.checkpoint_sha256 || null,
    });
    await store.releaseSlot(workRef, gate, lease.lease_id);
    return { restored, released_without_linear_mutation: releasedWithoutLinearMutation, reason };
  }

  async function recoverClaimReplay(existing, requestHash) {
    if (existing.claim_request_hash !== requestHash) throw err('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used for a different claim request');
    if (existing.status === 'settled') throw err('LEASE_ALREADY_SETTLED', 'the lease from this claim was already settled');
    if (existing.status === 'expired') throw err('LEASE_EXPIRED', 'the lease from this claim has expired');
    if (existing.status === 'invalidated') throw err('WORK_STATE_CHANGED', 'the authoritative work item changed after claim');
    if (existing.status === 'rejected') {
      const rejection = existing.reconciliation || {};
      throw err(rejection.rejection_code || 'ALREADY_CLAIMED', 'the original claim request was rejected', rejection.rejection_details || null);
    }
    if (existing.claim_receipt) return { ...existing.claim_receipt, idempotent_replay: true };
    if (existing.status === 'claiming') {
      const slot = await store.getSlot(existing.work_ref, existing.gate);
      const issue = await authoritative.getIssue(existing.work_ref);
      if (slot?.lease_id === existing.lease_id) {
        const slotOnly = issueMatches(issue, { state: existing.previous_state, lane: existing.gate });
        const legacyLinearOwned = issueMatches(issue, { state: ACTIVE_STATE, lane: existing.gate });
        if (slotOnly || legacyLinearOwned) {
          const evidence = await executionEvidence(issue);
          const receipt = {
            ok: true,
            work_ref: existing.work_ref,
            lease_token: existing.lease_token,
            lease_id: existing.lease_id,
            expires_at: existing.expires_at,
            previous_state: existing.previous_state,
            current_state: issue.state.name,
            lane: existing.gate,
            authoritative_revision: issue.updatedAt,
            ownership_protocol: slotOnly ? SLOT_OWNERSHIP_PROTOCOL : 'linear-in-progress-v1',
            idempotent_replay: true,
            continuation: existing.predecessor_continuation || null,
            snapshot: snapshot(issue),
            ...evidence,
          };
          await store.activateLease(existing.lease_id, issue.updatedAt, receipt);
          return receipt;
        }
      }
    }
    throw err('CLAIM_INDETERMINATE', 'the original claim has no recoverable success receipt');
  }

  async function claim(input) {
    const request = normalizeClaimRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    const prior = await store.getClaimByIdempotency(request.idempotency_key);
    if (prior) return recoverClaimReplay(prior, requestHash);

    let issue = await authoritative.getIssue(request.work_ref);
    let lane = laneOf(issue);
    if (!lane) throw err('NON_EXECUTABLE_WORK', 'work item must have exactly one lane label');
    await assertRepositoryExecutable(issue);
    if (request.expected_revision && issue.updatedAt !== request.expected_revision) {
      throw err('WORK_STATE_CHANGED', 'authoritative Linear revision did not match observed_revision', {
        expected_revision: request.expected_revision,
        actual_revision: issue.updatedAt || null,
      });
    }
    const initialSlot = await store.getSlot(request.work_ref, lane.name);
    if (initialSlot && Date.parse(initialSlot.expires_at) > Date.parse(now())) {
      throw err('ALREADY_CLAIMED', 'another unexpired lease owns this work item', {
        work_ref: request.work_ref,
        expires_at: initialSlot.expires_at,
      });
    }

    // Preconditions describe the authoritative state the caller actually observed.
    // Check them before expired-lease reconciliation mutates transient In Progress
    // back to the prior executable state.
    if (request.expected_state && issue.state?.name !== request.expected_state) {
      throw err('STATE_MISMATCH', 'authoritative state did not match expected_state', { expected_state: request.expected_state, actual_state: issue.state?.name || null });
    }
    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane did not match expected_lane', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }

    let runBudget = null;
    if (typeof store.getRunBudget === 'function') {
      runBudget = await store.getRunBudget(request.run_id);
      if (!runBudget) throw err('RUN_NOT_REGISTERED', 'work.claim requires a registered orchestration run', { run_id: request.run_id });
      if (runBudget.status && runBudget.status !== 'active') throw err('RUN_BUDGET_EXHAUSTED', 'orchestration run is not active', { run_id: request.run_id, status: runBudget.status });
      const initialProjection = executionProjection(issue);
      const scope = runBudget.scope || null;
      if (!scopeAllowsProjection(scope, initialProjection)) {
        throw err('RUN_SCOPE_VIOLATION', 'work item is outside the registered orchestration run scope', {
          run_id: request.run_id,
          team: initialProjection.team,
          project: initialProjection.project,
          lane: initialProjection.lane,
          repository: initialProjection.repository,
        });
      }
    }

    const expiredReconciliation = await reconcileExpired(request.work_ref, lane.name);
    issue = await authoritative.getIssue(request.work_ref);
    lane = laneOf(issue);

    if (request.expected_revision && issue.updatedAt !== request.expected_revision) {
      throw err('WORK_STATE_CHANGED', 'authoritative Linear revision changed during claim reconciliation', {
        expected_revision: request.expected_revision,
        actual_revision: issue.updatedAt || null,
      });
    }
    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane changed during claim reconciliation', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }

    // Legacy/pre-adoption runs may have left Linear in transient In Progress with
    // no lease record at all. Under the adopted protocol, In Progress without a
    // live Hatchable slot carries no execution authority. A caller that just
    // observed that exact state may repair it optimistically to Todo, then claim
    // normally. The Linear revision fence prevents overwriting a concurrent edit.
    let orphanRecovered = false;
    if (request.expected_state === ACTIVE_STATE && issue.state?.name === ACTIVE_STATE) {
      const postReconcileSlot = await store.getSlot(request.work_ref, lane.name);
      if (!postReconcileSlot) {
        issue = await authoritative.transition({
          issue,
          expectedRevision: issue.updatedAt,
          expectedState: ACTIVE_STATE,
          expectedLane: lane.name,
          targetState: EXECUTABLE_STATE,
          targetLane: lane.name,
        });
        lane = laneOf(issue);
        orphanRecovered = true;
      }
    }

    // Reconciliation may intentionally restore a truthfully observed In Progress
    // item to its prior executable state, either from an expired lease or from an
    // orphaned pre-lease transient state. Every other post-reconcile change must
    // still satisfy the caller's optimistic preconditions.
    if (request.expected_state
      && !(request.expected_state === ACTIVE_STATE && (expiredReconciliation?.restored || orphanRecovered))
      && issue.state?.name !== request.expected_state) {
      throw err('STATE_MISMATCH', 'authoritative state changed during claim reconciliation', { expected_state: request.expected_state, actual_state: issue.state?.name || null });
    }
    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane changed during claim reconciliation', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }
    if (!isExecutable(issue)) {
      throw err('NON_EXECUTABLE_WORK', 'work item is not currently executable', { actual_state: issue.state?.name || null, actual_lane: lane?.name || null, project: issue.project?.name || null });
    }

    const preClaimEvidence = await executionEvidence(issue);
    const predecessorContinuation = await resolveContinuation(store, issue.identifier, lane.name, preClaimEvidence.execution_fingerprint);

    const createdAt = now();
    const createdMs = Date.parse(createdAt);
    let expiresMs = createdMs + request.lease_seconds * 1000;
    if (runBudget) {
      const cutoffMs = Date.parse(runBudget.deadline_at) - Number(runBudget.settlement_reserve_seconds || 0) * 1000;
      const minimumMs = Number(runBudget.minimum_new_gate_seconds || 0) * 1000;
      if (!Number.isFinite(cutoffMs) || cutoffMs - createdMs < minimumMs) {
        throw err('RUN_BUDGET_EXHAUSTED', 'insufficient run budget remains to acquire a fresh gate', {
          run_id: request.run_id,
          deadline_at: runBudget.deadline_at || null,
          settlement_reserve_seconds: Number(runBudget.settlement_reserve_seconds || 0),
          minimum_new_gate_seconds: Number(runBudget.minimum_new_gate_seconds || 0),
        });
      }
      expiresMs = Math.min(expiresMs, cutoffMs);
    }
    const hardExpiresMs = Math.min(createdMs + MAX_TOTAL_LEASE_SECONDS * 1000, runBudget ? Date.parse(runBudget.deadline_at) - Number(runBudget.settlement_reserve_seconds || 0) * 1000 : Number.POSITIVE_INFINITY);
    const expiresAt = new Date(expiresMs).toISOString();
    const hardExpiresAt = new Date(hardExpiresMs).toISOString();
    const leaseToken = tokenFactory();
    const tokenHash = await sha256Text(leaseToken);
    const lease = {
      lease_id: crypto.randomUUID(), work_ref: issue.identifier, gate: lane.name, run_id: request.run_id,
      lease_token: leaseToken, token_hash: tokenHash, claim_idempotency_key: request.idempotency_key,
      claim_request_hash: requestHash, claim_request: request, predecessor_continuation: predecessorContinuation,
      status: 'claiming', created_at: createdAt, expires_at: expiresAt, hard_expires_at: hardExpiresAt,
      previous_state: issue.state.name, previous_state_id: issue.state.id, previous_lane: lane.name,
      previous_lane_id: lane.id, claim_revision: issue.updatedAt,
    };
    const inserted = await store.insertLease(lease);
    if (!inserted.inserted) return recoverClaimReplay(inserted.lease, requestHash);

    const acquired = await store.tryAcquireSlot(issue.identifier, lane.name, lease.lease_id, expiresAt);
    if (!acquired) {
      const active = await store.getSlot(issue.identifier, lane.name);
      await store.rejectLease(lease.lease_id, 'ALREADY_CLAIMED', { expires_at: active?.expires_at || null });
      throw err('ALREADY_CLAIMED', 'another unexpired lease owns this work item', { work_ref: issue.identifier, expires_at: active?.expires_at || null });
    }

    let ownedIssue;
    try {
      ownedIssue = await authoritative.getIssue(issue.identifier);
    } catch (error) {
      await store.rejectLease(lease.lease_id, error?.code || 'LINEAR_READ_FAILED', { upstream_code: error?.code || null });
      await store.releaseSlot(issue.identifier, lane.name, lease.lease_id);
      throw error;
    }
    const currentProjection = executionProjection(ownedIssue);
    if (!projectionMatchesExpected(ownedIssue, preClaimEvidence.execution_projection)
      || !issueMatches(ownedIssue, { state: issue.state.name, lane: lane.name })) {
      const changedFields = projectionDiff(preClaimEvidence.execution_projection, currentProjection);
      await store.rejectLease(lease.lease_id, 'WORK_STATE_CHANGED', {
        changed_fields: changedFields,
        claim: preClaimEvidence.execution_projection,
        current: currentProjection,
      });
      await store.releaseSlot(issue.identifier, lane.name, lease.lease_id);
      throw err('WORK_STATE_CHANGED', 'authoritative execution contract changed while acquiring the lease slot', {
        changed_fields: changedFields,
        claim: preClaimEvidence.execution_projection,
        current: currentProjection,
      });
    }

    const evidence = await executionEvidence(ownedIssue);
    const receipt = {
      ok: true,
      work_ref: issue.identifier,
      lease_token: leaseToken,
      lease_id: lease.lease_id,
      expires_at: expiresAt,
      hard_expires_at: hardExpiresAt,
      run_budget_deadline: runBudget?.deadline_at || null,
      previous_state: issue.state.name,
      current_state: ownedIssue.state.name,
      lane: lane.name,
      authoritative_revision: ownedIssue.updatedAt,
      ownership_protocol: SLOT_OWNERSHIP_PROTOCOL,
      idempotent_replay: false,
      continuation: predecessorContinuation,
      pre_claim_execution_fingerprint: preClaimEvidence.execution_fingerprint,
      snapshot: snapshot(ownedIssue),
      ...evidence,
    };
    await store.activateLease(lease.lease_id, ownedIssue.updatedAt, receipt);
    return receipt;
  }

  async function checkpoint(input) {
    const request = normalizeCheckpointRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    const lease = await resolveLease(request);
    if (!lease) throw err('LEASE_INVALID', request.lease_ref ? 'lease reference is invalid' : 'lease token is invalid');
    const prior = await store.getCheckpointByIdempotency(lease.lease_id, request.idempotency_key);
    if (prior) {
      if (prior.request_sha256 !== requestHash) throw err('IDEMPOTENCY_CONFLICT', 'checkpoint idempotency_key was already used for a different request');
      return {
        ok: true,
        work_ref: lease.work_ref,
        lease_id: lease.lease_id,
        gate: lease.gate,
        checkpoint: prior.checkpoint,
        checkpoint_sha256: prior.checkpoint_sha256,
        created_at: prior.created_at,
        idempotent_replay: true,
      };
    }
    if (Date.parse(lease.expires_at) <= Date.parse(now())) throw err('LEASE_EXPIRED', 'lease has expired');
    if (lease.status !== 'active') throw err('LEASE_INVALID', `lease is ${lease.status}`);
    const slot = await store.getSlot(lease.work_ref, lease.gate);
    if (!slot || slot.lease_id !== lease.lease_id || Date.parse(slot.expires_at) <= Date.parse(now())) throw err('LEASE_EXPIRED', 'lease no longer owns the active slot');
    const current = await authoritative.getIssue(lease.work_ref);
    await assertLeaseRepositoryExecutable(lease, current, 'checkpoint');
    const claimProjection = leaseExecutionProjection(lease);
    const currentProjection = executionProjection(current);
    const ownedState = leaseOwnedState(lease);
    if (!projectionMatchesExpected(current, claimProjection) || !issueMatches(current, { state: ownedState, lane: lease.gate })) {
      const changedFields = projectionDiff(claimProjection || {}, currentProjection);
      await store.invalidateLease(lease.lease_id, { observed_revision: current.updatedAt, claimed_revision: lease.active_revision, changed_fields: changedFields, claim: claimProjection, current: currentProjection, invalidated_at: now(), phase: 'checkpoint' });
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      throw err('WORK_STATE_CHANGED', 'authoritative execution contract changed before checkpoint', { changed_fields: changedFields, claim: claimProjection, current: currentProjection });
    }
    const checkpointSha = await sha256Text(canonicalJson(request.checkpoint));
    const saved = await store.insertCheckpoint(lease.lease_id, request.idempotency_key, requestHash, request.checkpoint, checkpointSha, now());
    return {
      ok: true,
      work_ref: lease.work_ref,
      lease_id: lease.lease_id,
      gate: lease.gate,
      checkpoint: saved.checkpoint,
      checkpoint_sha256: saved.checkpoint_sha256,
      created_at: saved.created_at,
      idempotent_replay: false,
    };
  }

  async function heartbeat(input) {
    const request = normalizeHeartbeatRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    const lease = await resolveLease(request);
    if (!lease) throw err('LEASE_INVALID', request.lease_ref ? 'lease reference is invalid' : 'lease token is invalid');
    if (lease.run_id !== request.run_id) throw err('LEASE_INVALID', 'heartbeat run_id does not match lease ownership');
    const prior = typeof store.getHeartbeatByIdempotency === 'function' ? await store.getHeartbeatByIdempotency(lease.lease_id, request.idempotency_key) : null;
    if (prior) {
      if (prior.request_sha256 !== requestHash) throw err('IDEMPOTENCY_CONFLICT', 'heartbeat idempotency_key was already used for a different request');
      return {
        ok: true, work_ref: lease.work_ref, lease_id: lease.lease_id, gate: lease.gate,
        expires_at: prior.new_expires_at, previous_expires_at: prior.previous_expires_at,
        progress_sha256: prior.progress_sha256, created_at: prior.created_at, idempotent_replay: true,
      };
    }
    const observedNow = now();
    if (Date.parse(lease.expires_at) <= Date.parse(observedNow)) throw err('LEASE_EXPIRED', 'lease has expired');
    if (lease.status !== 'active') throw err('LEASE_INVALID', `lease is ${lease.status}`);
    const slot = await store.getSlot(lease.work_ref, lease.gate);
    if (!slot || slot.lease_id !== lease.lease_id || Date.parse(slot.expires_at) <= Date.parse(observedNow)) throw err('LEASE_EXPIRED', 'lease no longer owns the active slot');

    const current = await authoritative.getIssue(lease.work_ref);
    await assertLeaseRepositoryExecutable(lease, current, 'heartbeat');
    const claimProjection = leaseExecutionProjection(lease);
    const currentProjection = executionProjection(current);
    const ownedState = leaseOwnedState(lease);
    if (!projectionMatchesExpected(current, claimProjection) || !issueMatches(current, { state: ownedState, lane: lease.gate })) {
      const changedFields = projectionDiff(claimProjection || {}, currentProjection);
      await store.invalidateLease(lease.lease_id, { observed_revision: current.updatedAt, claimed_revision: lease.active_revision, changed_fields: changedFields, claim: claimProjection, current: currentProjection, invalidated_at: observedNow, phase: 'heartbeat' });
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      throw err('WORK_STATE_CHANGED', 'authoritative execution contract changed before heartbeat', { changed_fields: changedFields, claim: claimProjection, current: currentProjection });
    }

    let checkpointRow = null;
    if (request.checkpoint) {
      const checkpointSha = await sha256Text(canonicalJson(request.checkpoint));
      checkpointRow = await store.insertCheckpoint(lease.lease_id, request.idempotency_key, requestHash, request.checkpoint, checkpointSha, observedNow);
    } else if (typeof store.getLatestCheckpoint === 'function') {
      checkpointRow = await store.getLatestCheckpoint(lease.lease_id);
    }
    if (!checkpointRow?.checkpoint_sha256) throw err('CHECKPOINT_REQUIRED', 'heartbeat requires a durable progress checkpoint');
    const progressSha = checkpointRow.checkpoint_sha256;
    const recent = typeof store.listRecentHeartbeats === 'function' ? await store.listRecentHeartbeats(lease.lease_id, MAX_SAME_PROGRESS_HEARTBEATS) : [];
    const sameProgress = (recent || []).filter(row => row.progress_sha256 === progressSha).length;
    if (sameProgress >= MAX_SAME_PROGRESS_HEARTBEATS) throw err('NO_PROGRESS_HEARTBEAT', 'lease cannot be extended repeatedly without materially advanced checkpoint progress', { progress_sha256: progressSha, same_progress_heartbeats: sameProgress });

    const createdMs = Date.parse(lease.created_at);
    const hardMs = lease.hard_expires_at ? Date.parse(lease.hard_expires_at) : createdMs + MAX_TOTAL_LEASE_SECONDS * 1000;
    let capMs = hardMs;
    const runBudget = typeof store.getRunBudget === 'function' ? await store.getRunBudget(lease.run_id) : null;
    if (typeof store.getRunBudget === 'function' && !runBudget) throw err('RUN_NOT_REGISTERED', 'work.heartbeat requires the lease run to remain registered', { run_id: lease.run_id });
    if (runBudget?.status && runBudget.status !== 'active') throw err('RUN_BUDGET_EXHAUSTED', 'orchestration run is not active', {
      run_id: lease.run_id,
      status: runBudget.status,
      lease_ref: lease.lease_id,
      work_ref: lease.work_ref,
      gate: lease.gate,
      checkpoint_sha256: progressSha,
      checkpoint_already_durable: true,
      required_transition: 'settle_before_more_work',
      required_command: 'work.settle',
    });
    if (runBudget) capMs = Math.min(capMs, Date.parse(runBudget.deadline_at) - Number(runBudget.settlement_reserve_seconds || 0) * 1000);
    const desiredMs = Math.max(Date.parse(lease.expires_at), Date.parse(observedNow) + request.extend_seconds * 1000);
    const newExpiryMs = Math.min(desiredMs, capMs);
    if (!Number.isFinite(newExpiryMs) || newExpiryMs <= Date.parse(lease.expires_at)) {
      const limitCode = runBudget && capMs <= Date.parse(lease.expires_at) ? 'RUN_BUDGET_EXHAUSTED' : 'HEARTBEAT_LIMIT_REACHED';
      const details = {
        hard_expires_at: new Date(hardMs).toISOString(),
        run_deadline_at: runBudget?.deadline_at || null,
        lease_ref: lease.lease_id,
        work_ref: lease.work_ref,
        gate: lease.gate,
        checkpoint_sha256: progressSha,
        checkpoint_already_durable: true,
      };
      details.required_transition = 'settle_before_more_work';
      details.required_command = 'work.settle';
      throw err(limitCode, 'heartbeat cannot extend lease beyond its bounded execution horizon', details);
    }
    const newExpiresAt = new Date(newExpiryMs).toISOString();
    const saved = await store.extendLeaseWithHeartbeat({
      lease_id: lease.lease_id, work_ref: lease.work_ref, gate: lease.gate,
      idempotency_key: request.idempotency_key, request_sha256: requestHash, progress_sha256: progressSha,
      previous_expires_at: lease.expires_at, new_expires_at: newExpiresAt, created_at: observedNow,
    });
    return {
      ok: true, work_ref: lease.work_ref, lease_id: lease.lease_id, gate: lease.gate,
      previous_expires_at: lease.expires_at, expires_at: newExpiresAt,
      hard_expires_at: lease.hard_expires_at || new Date(hardMs).toISOString(),
      checkpoint_sha256: progressSha, progress_sha256: progressSha,
      heartbeat_count: Number(saved?.heartbeat_count || lease.heartbeat_count || 0), created_at: observedNow,
      idempotent_replay: false,
    };
  }

  async function settle(input) {
    const request = normalizeSettleRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    let lease = await resolveLease(request);
    if (!lease) throw err('LEASE_INVALID', request.lease_ref ? 'lease reference is invalid' : 'lease token is invalid');

    if (lease.settle_idempotency_key) {
      if (lease.settle_idempotency_key !== request.idempotency_key || lease.settle_request_hash !== requestHash) {
        throw err('LEASE_ALREADY_SETTLED', 'lease has already been consumed by a different settlement request');
      }
      if (lease.settle_receipt) return { ...lease.settle_receipt, idempotent_replay: true };
    }
    if (Date.parse(lease.expires_at) <= Date.parse(now())) throw err('LEASE_EXPIRED', 'lease has expired');
    if (!['active', 'settling'].includes(lease.status)) {
      if (lease.status === 'settled') throw err('LEASE_ALREADY_SETTLED', 'lease has already been consumed');
      throw err('LEASE_INVALID', `lease is ${lease.status}`);
    }
    const slot = await store.getSlot(lease.work_ref, lease.gate);
    if (!slot || slot.lease_id !== lease.lease_id || Date.parse(slot.expires_at) <= Date.parse(now())) {
      throw err('LEASE_EXPIRED', 'lease no longer owns the active slot');
    }
    if (request.disposition === 'completed' && skillRequirements?.assertCompletionRequirements) {
      await skillRequirements.assertCompletionRequirements({ run_id: lease.run_id });
    }

    let current = await authoritative.getIssue(lease.work_ref);
    let plan = lease.settle_plan;
    if (!plan) {
      const latestCheckpoint = typeof store.getLatestCheckpoint === 'function' ? await store.getLatestCheckpoint(lease.lease_id) : null;
      const continuation = mergeContinuation(request.continuation, latestCheckpoint, request.evidence);
      if (request.disposition === 'requeue' && request.requeue_class === 'resume_progress' && !continuation?.checkpoint) {
        throw err('CHECKPOINT_REQUIRED', 'resume_progress requeue requires a durable checkpoint');
      }
      if (request.disposition === 'requeue' && request.requeue_class === 'stale_candidate' && !continuation?.candidate) {
        throw err('REQUEST_INVALID', 'stale_candidate requeue requires an exact candidate continuation');
      }
      if (request.disposition === 'requeue' && request.requeue_class === 'wait_for_observable_change' && !request.reason) {
        throw err('REQUEST_INVALID', 'wait_for_observable_change requeue requires reason');
      }
      plan = settlementPlan(lease, request, current, continuation);
      plan.continuation_sha256 = continuation ? await sha256Text(canonicalJson(continuation)) : null;
    }

    const ownedState = leaseOwnedState(lease);
    if (lease.status === 'settling' && issueMatches(current, plan)) {
      const successorEvidence = await executionEvidence(current);
      const receipt = {
        ok: true, work_ref: lease.work_ref, lease_id: lease.lease_id, disposition: request.disposition,
        previous_state: ownedState, current_state: current.state.name, previous_lane: lease.gate,
        current_lane: laneOf(current)?.name || null, settled_at: now(), idempotent_replay: true,
        requeue_class: plan.requeue_class || null,
        continuation_sha256: plan.continuation_sha256 || null,
        claim_authoritative_revision: lease.active_revision,
        settlement_authoritative_revision: current.updatedAt,
        successor_execution_projection: successorEvidence.execution_projection,
        successor_execution_fingerprint: successorEvidence.execution_fingerprint,
        execution_precondition_verified: true,
      };
      await store.completeSettlement(lease.lease_id, request.idempotency_key, requestHash, plan, receipt, receipt.settled_at);
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      return receipt;
    }

    await assertLeaseRepositoryExecutable(lease, current, 'settlement');
    const claimProjection = leaseExecutionProjection(lease);
    const currentProjection = executionProjection(current);
    const projectionMatches = projectionMatchesExpected(current, claimProjection);
    if (!projectionMatches || !issueMatches(current, { state: ownedState, lane: lease.gate })) {
      const changedFields = projectionDiff(claimProjection || {}, currentProjection);
      await store.invalidateLease(lease.lease_id, {
        observed_revision: current.updatedAt,
        claimed_revision: lease.active_revision,
        changed_fields: changedFields,
        claim: claimProjection,
        current: currentProjection,
        invalidated_at: now(),
      });
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      throw err('WORK_STATE_CHANGED', 'authoritative execution contract changed after claim', {
        changed_fields: changedFields,
        claim: claimProjection,
        current: currentProjection,
        claim_authoritative_revision: lease.active_revision,
        actual_revision: current.updatedAt,
      });
    }

    const preSettlementRevision = current.updatedAt;
    lease = await store.beginSettlement(lease.lease_id, request.idempotency_key, requestHash, plan);
    if (issueMatches(current, plan) && plan.description === null) {
      const settledAt = now();
      const successorEvidence = await executionEvidence(current);
      const receipt = {
        ok: true,
        work_ref: lease.work_ref,
        lease_id: lease.lease_id,
        disposition: request.disposition,
        previous_state: ownedState,
        current_state: current.state.name,
        previous_lane: lease.gate,
        current_lane: laneOf(current)?.name || null,
        settled_at: settledAt,
        idempotent_replay: false,
        requeue_class: plan.requeue_class || null,
        continuation_sha256: plan.continuation_sha256 || null,
        claim_authoritative_revision: lease.active_revision,
        pre_settlement_authoritative_revision: preSettlementRevision,
        settlement_authoritative_revision: current.updatedAt,
        successor_execution_projection: successorEvidence.execution_projection,
        successor_execution_fingerprint: successorEvidence.execution_fingerprint,
        authoritative_revision_changed_before_settlement: lease.active_revision !== preSettlementRevision,
        execution_precondition_verified: true,
        linear_mutation_performed: false,
      };
      await store.completeSettlement(lease.lease_id, request.idempotency_key, requestHash, plan, receipt, settledAt);
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      return receipt;
    }
    try {
      current = await authoritative.transition({
        issue: current,
        expectedRevision: current.updatedAt,
        expectedState: ownedState,
        expectedLane: lease.gate,
        targetState: plan.state,
        targetLane: plan.lane,
        description: plan.description,
      });
    } catch (error) {
      if (error?.code === 'WORK_STATE_CHANGED') {
        const fresh = await authoritative.getIssue(lease.work_ref);
        const claim = leaseExecutionProjection(lease);
        const observed = executionProjection(fresh);
        const changedFields = projectionDiff(claim || {}, observed);
        await store.invalidateLease(lease.lease_id, {
          observed_revision: fresh.updatedAt,
          claimed_revision: lease.active_revision,
          changed_fields: changedFields,
          claim,
          current: observed,
          invalidated_at: now(),
          phase: 'settlement_transition',
        });
        await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
        throw err('WORK_STATE_CHANGED', 'authoritative execution contract changed during settlement', {
          changed_fields: changedFields,
          claim,
          current: observed,
          claim_authoritative_revision: lease.active_revision,
          actual_revision: fresh.updatedAt,
        });
      }
      throw error;
    }

    const settledAt = now();
    const successorEvidence = await executionEvidence(current);
    const receipt = {
      ok: true,
      work_ref: lease.work_ref,
      lease_id: lease.lease_id,
      disposition: request.disposition,
      previous_state: ownedState,
      current_state: current.state.name,
      previous_lane: lease.gate,
      current_lane: laneOf(current)?.name || null,
      settled_at: settledAt,
      idempotent_replay: false,
      requeue_class: plan.requeue_class || null,
      continuation_sha256: plan.continuation_sha256 || null,
      claim_authoritative_revision: lease.active_revision,
      pre_settlement_authoritative_revision: preSettlementRevision,
      settlement_authoritative_revision: current.updatedAt,
      successor_execution_projection: successorEvidence.execution_projection,
      successor_execution_fingerprint: successorEvidence.execution_fingerprint,
      authoritative_revision_changed_before_settlement: lease.active_revision !== preSettlementRevision,
      execution_precondition_verified: true,
    };
    await store.completeSettlement(lease.lease_id, request.idempotency_key, requestHash, plan, receipt, settledAt);
    await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
    return receipt;
  }

  return {
    claim,
    checkpoint,
    heartbeat,
    settle,
    checkpointByRef: (input) => checkpoint(byRef(input)),
    heartbeatByRef: (input) => heartbeat(byRef(input)),
    settleByRef: (input) => settle(byRef(input)),
    reconcileExpired,
  };
}

export function createLinearAuthority(apiBinding = api) {
  async function gql(query, variables) {
    const response = await apiBinding.call('linear', { method: 'POST', path: '', headers: { 'Content-Type': 'application/json' }, body: { query, variables } });
    if (!response || response.status < 200 || response.status >= 300) throw err('LINEAR_UPSTREAM_HTTP', `Linear returned HTTP ${response?.status ?? 'unknown'}`);
    let body = response.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (body?.errors?.length) throw err('LINEAR_UPSTREAM_GRAPHQL', String(body.errors[0]?.message || 'Linear GraphQL request failed'), { errors: body.errors.map(e => ({ message: e.message, code: e.extensions?.code || null })) });
    return body?.data || {};
  }

  async function getIssue(workRef) {
    const data = await gql(`query WorkLeaseIssue($id: String!) {
      issue(id: $id) {
        id identifier title description priority updatedAt archivedAt
        project { id name }
        state { id name type }
        labels { nodes { id name } }
        relations { nodes { id type relatedIssue { id identifier title } } }
        team {
          id name
          states { nodes { id name type } }
          labels { nodes { id name } }
        }
      }
    }`, { id: workRef });
    const issue = data.issue;
    if (!issue) throw err('WORK_NOT_FOUND', `Linear issue ${workRef} was not found`);
    return {
      ...issue,
      labels: issue.labels?.nodes || [],
      relations: issue.relations?.nodes || [],
      teamStates: issue.team?.states?.nodes || [],
      teamLabels: issue.team?.labels?.nodes || [],
    };
  }

  async function transition({ issue, expectedRevision, expectedState, expectedLane, targetState, targetLane, description = null }) {
    const fresh = await getIssue(issue.identifier);
    const freshLane = laneOf(fresh);
    if (!projectionMatchesExpected(fresh, executionProjection(issue)) || fresh.state?.name !== expectedState || freshLane?.name !== expectedLane) {
      throw err('WORK_STATE_CHANGED', 'Linear work item changed before transition', {
        actual_state: fresh.state?.name || null,
        actual_lane: freshLane?.name || null,
        expected_revision: expectedRevision,
        actual_revision: fresh.updatedAt,
      });
    }
    const state = stateByName(fresh, targetState);
    const targetLabel = labelByName(fresh, targetLane);
    if (!state || !targetLabel) throw err('LINEAR_CONFIGURATION_ERROR', 'target state or lane is not configured in Linear', { target_state: targetState, target_lane: targetLane });
    const input = { stateId: state.id };
    if (freshLane.name !== targetLane) {
      input.addedLabelIds = [targetLabel.id];
      input.removedLabelIds = [freshLane.id];
    }
    if (description !== null) input.description = description;
    const data = await gql(`mutation WorkLeaseTransition($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`, { id: fresh.id, input });
    if (data.issueUpdate?.success !== true) throw err('LINEAR_TRANSITION_FAILED', 'Linear did not confirm issue transition');
    const updated = await getIssue(fresh.identifier);
    if (!issueMatches(updated, { state: targetState, lane: targetLane })) {
      throw err('LINEAR_TRANSITION_FAILED', 'Linear transition did not reach the requested state/lane', { actual_state: updated.state?.name || null, actual_lane: laneOf(updated)?.name || null });
    }
    return updated;
  }

  return { getIssue, transition };
}

export function createPostgresLeaseStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    async getClaimByIdempotency(key) { return row('SELECT * FROM work_leases WHERE claim_idempotency_key = $1', [key]); },
    async getLeaseById(id) { return row('SELECT * FROM work_leases WHERE lease_id = $1', [id]); },
    async getLeaseByTokenHash(hash) { return row('SELECT * FROM work_leases WHERE token_hash = $1', [hash]); },
    async getSlot(workRef, gate) { return row('SELECT * FROM work_lease_slots WHERE work_ref = $1 AND gate = $2', [workRef, gate]); },
    async getCheckpointByIdempotency(leaseId, key) { return row('SELECT * FROM work_lease_checkpoints WHERE lease_id = $1 AND idempotency_key = $2', [leaseId, key]); },
    async getLatestCheckpoint(leaseId) { return row('SELECT * FROM work_lease_checkpoints WHERE lease_id = $1 ORDER BY created_at DESC LIMIT 1', [leaseId]); },
    async getHeartbeatByIdempotency(leaseId, key) { return row('SELECT * FROM work_lease_heartbeats WHERE lease_id = $1 AND idempotency_key = $2', [leaseId, key]); },
    async listRecentHeartbeats(leaseId, limit = 2) { const result = await dbBinding.query(`SELECT * FROM work_lease_heartbeats WHERE lease_id = $1 ORDER BY created_at DESC LIMIT ${Math.min(20, Math.max(1, Number(limit) || 2))}`, [leaseId]); return result.rows || []; },
    async getRunBudget(runId) { return row('SELECT status, deadline_at, settlement_reserve_seconds, minimum_new_gate_seconds, scope FROM orchestration_runs WHERE run_id = $1', [runId]); },
    async listContinuationCandidates(workRef, gate) {
      const result = await dbBinding.query("SELECT * FROM work_leases WHERE work_ref = $1 AND ((status = 'settled' AND settle_plan->>'lane' = $2 AND settle_plan->'continuation' IS NOT NULL) OR (status = 'expired' AND gate = $2 AND (reconciliation->>'restored' = 'true' OR reconciliation->>'released_without_linear_mutation' = 'true'))) ORDER BY COALESCE(settled_at, updated_at) DESC LIMIT 20", [workRef, gate]);
      return result.rows || [];
    },
    async insertCheckpoint(leaseId, idem, requestHash, checkpoint, checkpointSha, createdAt) {
      const inserted = await row('INSERT INTO work_lease_checkpoints (lease_id, idempotency_key, request_sha256, checkpoint, checkpoint_sha256, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (lease_id, idempotency_key) DO NOTHING RETURNING *', [leaseId, idem, requestHash, JSON.stringify(checkpoint), checkpointSha, createdAt]);
      if (inserted) return inserted;
      const existing = await this.getCheckpointByIdempotency(leaseId, idem);
      if (existing?.request_sha256 === requestHash) return existing;
      throw err('IDEMPOTENCY_CONFLICT', 'checkpoint idempotency_key was already used for a different request');
    },
    async insertLease(lease) {
      if (typeof dbBinding.transaction !== 'function') throw err('LEASE_STORAGE_UNAVAILABLE', 'lease insertion requires transactional database support');
      const params = [
        lease.lease_id, lease.work_ref, lease.gate, lease.run_id, lease.lease_token, lease.token_hash,
        lease.claim_idempotency_key, lease.claim_request_hash, JSON.stringify(lease.claim_request), JSON.stringify(lease.predecessor_continuation), lease.status, lease.created_at, lease.expires_at, lease.hard_expires_at,
        lease.previous_state, lease.previous_state_id, lease.previous_lane, lease.previous_lane_id, lease.claim_revision,
      ];
      const tx = await dbBinding.transaction([
        { sql: 'SELECT run_id,status,deadline_at FROM orchestration_runs WHERE run_id=$1 FOR UPDATE', params: [lease.run_id] },
        { sql: `INSERT INTO work_leases (
            lease_id, work_ref, gate, run_id, lease_token, token_hash, claim_idempotency_key, claim_request_hash, claim_request, predecessor_continuation,
            status, created_at, expires_at, hard_expires_at, previous_state, previous_state_id, previous_lane, previous_lane_id, claim_revision
          )
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
          FROM orchestration_runs r
          WHERE r.run_id=$4 AND r.status='active' AND r.deadline_at > $12
          ON CONFLICT (claim_idempotency_key) DO NOTHING RETURNING *`, params },
      ]);
      const lockedRun = tx.results?.[0]?.rows?.[0] || null;
      const inserted = tx.results?.[1]?.rows?.[0] || null;
      if (!lockedRun) throw err('RUN_NOT_REGISTERED', 'work.claim requires a registered orchestration run', { run_id: lease.run_id });
      if (lockedRun.status !== 'active' || Date.parse(lockedRun.deadline_at) <= Date.parse(lease.created_at)) throw err('RUN_BUDGET_EXHAUSTED', 'orchestration run is not active at lease insertion', { run_id: lease.run_id, status: lockedRun.status, deadline_at: lockedRun.deadline_at });
      if (inserted) return { inserted: true, lease: inserted };
      const existing = await this.getClaimByIdempotency(lease.claim_idempotency_key);
      if (existing) return { inserted: false, lease: existing };
      throw err('RUN_BUDGET_EXHAUSTED', 'orchestration run could not acquire a lease after run-state fencing', { run_id: lease.run_id });
    },
    async tryAcquireSlot(workRef, gate, leaseId, expiresAt) {
      return Boolean(await row('INSERT INTO work_lease_slots (work_ref, gate, lease_id, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (work_ref, gate) DO NOTHING RETURNING lease_id', [workRef, gate, leaseId, expiresAt]));
    },
    async activateLease(id, activeRevision, receipt) {
      return row("UPDATE work_leases SET status = 'active', active_revision = $2, claim_receipt = $3::jsonb, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, activeRevision, JSON.stringify(receipt)]);
    },
    async extendLeaseWithHeartbeat(input) {
      if (typeof dbBinding.transaction !== 'function') throw err('HEARTBEAT_STORAGE_UNAVAILABLE', 'heartbeat persistence requires transactional database support');
      const attemptToken = crypto.randomUUID();
      const params = [
        input.lease_id, input.work_ref, input.gate, input.idempotency_key,
        input.request_sha256, input.progress_sha256, input.new_expires_at,
        input.created_at, input.previous_expires_at, attemptToken,
      ];
      const tx = await dbBinding.transaction([
        {
          sql: `SELECT l.lease_id
            FROM work_leases l
            JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=$2 AND s.gate=$3
            WHERE l.lease_id=$1 AND l.status='active' AND l.expires_at > $8 AND s.expires_at > $8
            FOR UPDATE OF l,s`,
          params,
        },
        {
          sql: `INSERT INTO work_lease_heartbeats (
              lease_id,idempotency_key,request_sha256,progress_sha256,previous_expires_at,new_expires_at,created_at,attempt_token
            )
            SELECT $1,$4,$5,$6,$9,$7,$8,$10
            WHERE EXISTS (
              SELECT 1 FROM work_leases l
              JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=$2 AND s.gate=$3
              WHERE l.lease_id=$1 AND l.status='active' AND l.expires_at > $8 AND s.expires_at > $8
            )
            ON CONFLICT (lease_id,idempotency_key) DO NOTHING
            RETURNING *`,
          params,
        },
        {
          sql: `UPDATE work_lease_slots s SET expires_at=$7, updated_at=now()
            WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at > $8
              AND EXISTS (
                SELECT 1 FROM work_lease_heartbeats h
                WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.request_sha256=$5 AND h.attempt_token=$10
              )
            RETURNING s.lease_id`,
          params,
        },
        {
          sql: `UPDATE work_leases l SET expires_at=$7, last_heartbeat_at=$8, heartbeat_count=heartbeat_count+1, updated_at=now()
            WHERE l.lease_id=$1 AND l.status='active' AND l.expires_at > $8
              AND EXISTS (
                SELECT 1 FROM work_lease_slots s
                WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at=$7
              )
              AND EXISTS (
                SELECT 1 FROM work_lease_heartbeats h
                WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.request_sha256=$5 AND h.attempt_token=$10
              )
            RETURNING l.heartbeat_count`,
          params,
        },
        {
          sql: `SELECT 1 / CASE WHEN
              NOT EXISTS (
                SELECT 1 FROM work_lease_heartbeats h
                WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.attempt_token=$10
              )
              OR (
                EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$1 AND l.expires_at=$7 AND l.last_heartbeat_at=$8)
                AND EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at=$7)
              )
            THEN 1 ELSE 0 END AS atomicity_guard`,
          params,
        },
      ]);
      const reservation = tx?.results?.[1]?.rows?.[0] || null;
      const slot = tx?.results?.[2]?.rows?.[0] || null;
      const lease = tx?.results?.[3]?.rows?.[0] || null;
      if (reservation && slot && lease) return { ...reservation, heartbeat_count: Number(lease.heartbeat_count || 0) };
      const existing = await this.getHeartbeatByIdempotency(input.lease_id, input.idempotency_key);
      if (existing?.request_sha256 === input.request_sha256) return existing;
      throw err('LEASE_EXPIRED', 'lease or slot could not be atomically extended');
    },
    async rejectLease(id, code, details) {
      return row("UPDATE work_leases SET status = 'rejected', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, JSON.stringify({ rejection_code: code, rejection_details: details })]);
    },
    async markExpired(id, reconciliation) {
      return row("UPDATE work_leases SET status = 'expired', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 AND status <> 'settled' RETURNING *", [id, JSON.stringify(reconciliation)]);
    },
    async invalidateLease(id, reconciliation) {
      return row("UPDATE work_leases SET status = 'invalidated', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 AND status <> 'settled' RETURNING *", [id, JSON.stringify(reconciliation)]);
    },
    async releaseSlot(workRef, gate, leaseId) {
      const result = await dbBinding.query('DELETE FROM work_lease_slots WHERE work_ref = $1 AND gate = $2 AND lease_id = $3', [workRef, gate, leaseId]);
      return result.rowCount || 0;
    },
    async beginSettlement(id, idem, hash, plan) {
      const updated = await row("UPDATE work_leases SET status = 'settling', settle_idempotency_key = $2, settle_request_hash = $3, settle_plan = $4::jsonb, updated_at = now() WHERE lease_id = $1 AND status = 'active' AND settle_idempotency_key IS NULL RETURNING *", [id, idem, hash, JSON.stringify(plan)]);
      if (updated) return updated;
      const existing = await this.getLeaseById(id);
      if (existing?.settle_idempotency_key === idem && existing?.settle_request_hash === hash) return existing;
      throw err('LEASE_ALREADY_SETTLED', 'lease settlement was already started by another request');
    },
    async completeSettlement(id, idem, hash, plan, receipt, settledAt) {
      return row("UPDATE work_leases SET status = 'settled', settle_idempotency_key = $2, settle_request_hash = $3, settle_plan = $4::jsonb, settle_receipt = $5::jsonb, settled_at = $6, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, idem, hash, JSON.stringify(plan), JSON.stringify(receipt), settledAt]);
    },
  };
}

export function createPostgresWorkLeaseService(options = {}) {
  return createWorkLeaseService({
    store: createPostgresLeaseStore(options.db || db),
    authoritative: createLinearAuthority(options.api || api),
    repositoryLifecycle: options.repositoryLifecycle || createPostgresRepositoryLifecycleService({ db: options.db || db, api: options.api || api, now: options.now }),
    skillRequirements: options.skillRequirements || createPostgresSkillExecutionService({ db: options.db || db }),
    now: options.now,
    tokenFactory: options.tokenFactory,
  });
}

export function statusForWorkLeaseError(error) {
  const code = String(error?.code || 'WORK_LEASE_ERROR');
  if (code === 'REQUEST_INVALID') return 400;
  if (code === 'WORK_NOT_FOUND') return 404;
  if (['ALREADY_CLAIMED','STATE_MISMATCH','LANE_MISMATCH','NON_EXECUTABLE_WORK','LEASE_INVALID','LEASE_EXPIRED','LEASE_ALREADY_SETTLED','WORK_STATE_CHANGED','IDEMPOTENCY_CONFLICT','CLAIM_INDETERMINATE','INVALID_SUCCESSOR','CHECKPOINT_REQUIRED','RUN_BUDGET_EXHAUSTED','RUN_NOT_REGISTERED','RUN_SCOPE_VIOLATION','HEARTBEAT_LIMIT_REACHED','NO_PROGRESS_HEARTBEAT','SKILL_REQUIREMENT_UNSATISFIED'].includes(code)) return 409;
  if (code.startsWith('LINEAR_')) return 502;
  return 500;
}

export const workLeaseConfig = Object.freeze({
  active_state: ACTIVE_STATE,
  default_lease_seconds: DEFAULT_LEASE_SECONDS,
  min_lease_seconds: MIN_LEASE_SECONDS,
  max_lease_seconds: MAX_LEASE_SECONDS,
  max_total_lease_seconds: MAX_TOTAL_LEASE_SECONDS,
  default_heartbeat_seconds: DEFAULT_HEARTBEAT_SECONDS,
  max_same_progress_heartbeats: MAX_SAME_PROGRESS_HEARTBEATS,
  dispositions: [...DISPOSITIONS],
  requeue_classes: [...REQUEUE_CLASSES],
  next_action_max_length: NEXT_ACTION_MAX_LENGTH,
  continuation_schema: CONTINUATION_SCHEMA,
  checkpoint_schema: CHECKPOINT_SCHEMA,
  execution_lanes: [...EXECUTION_LANES],
  successor: SUCCESSOR,
});

export const workLeaseInternals = Object.freeze({ normalizeClaimRequest, normalizeCheckpointRequest, normalizeHeartbeatRequest, normalizeSettleRequest, settlementPlan, isExecutable, laneOf, snapshot, executionProjection, executionEvidence, scopeAllowsProjection, publicLease });