import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { repositoryIdentity } from 'lib/work-identity.js';
import { createPostgresRepositoryLifecycleService } from 'lib/repository-disposition.js';
import {
  classifyWorkSurfaceProjection,
  canonicalExecutableSourceKey,
  frontierLimitForProject,
  terminalStateForDisposition,
} from 'lib/work-surface-policy.js';

const SOURCE_KIND = 'github_issue';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTIVE_STATES = new Set(['Todo', 'Backlog']);
const ACTIVE_LANES = new Set([
  'lane:repo-implementation',
  'lane:source-implementation',
  'lane:verification',
  'lane:integration',
]);
const NEW_ADMISSION_LANES = new Set([
  'lane:repo-implementation',
  'lane:source-implementation',
]);
const TERMINAL_TYPES = new Set(['completed', 'canceled', 'duplicate']);
const REQUEST_FIELDS = new Set(['project', 'items', 'idempotency_key', 'dry_run', 'frontier_limit']);
const ITEM_FIELDS = new Set(['source', 'projection']);
const SOURCE_FIELDS = new Set(['kind', 'repo', 'issue_number', 'expected_revision', 'unit_key', 'canonical_key']);
const PROJECTION_FIELDS = new Set([
  'title', 'state', 'lane', 'priority',
  'outcome', 'next_action', 'actor', 'changes_authority_or_produces_evidence',
  'disposition', 'authoritative_complete',
  'objective', 'gate', 'acceptance', 'repository', 'exact_coordinate', 'owner_impact',
  'dependencies', 'promotion_condition',
]);
const DEPENDENCY_FIELDS = new Set(['kind', 'ref']);
const ITEM_REJECTION_CODES = new Set([
  'INVALID_PROJECTION', 'INVALID_LANE', 'INVALID_STATE', 'DEPENDENCY_NOT_FOUND',
  'UNSUPPORTED_SOURCE_KIND', 'GITHUB_APP_INSTALLATION_NOT_FOUND',
  'SOURCE_NOT_FOUND', 'SOURCE_NOT_ISSUE',
  'LINEAR_REVISION_MISMATCH',
]);
const DESCRIPTION_FIELDS = [
  'repository', 'authority', 'objective', 'gate', 'acceptance',
  'exact_coordinate', 'owner_impact', 'promotion_condition',
];
const STALE_RECEIPT_SECONDS = 30;

export class PortfolioReconcileError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'PortfolioReconcileError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new PortfolioReconcileError(code, message, details, httpStatus);
}

function object(value, field, code = 'INVALID_PROJECTION') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${field} must be an object`, { field }, 422);
  }
  return value;
}

function exactFields(value, allowed, field, code = 'INVALID_PROJECTION') {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length) fail(code, `${field} contains unknown fields`, { field, unknown }, 422);
}

function requiredString(value, field, max, code = 'INVALID_PROJECTION') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) fail(code, `${field} must be a non-empty string of at most ${max} characters`, { field }, 422);
  return text;
}

function optionalString(value, field, max, code = 'INVALID_PROJECTION') {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(String(value), field, max, code);
}

function canonicalRepo(value, field = 'repo', code = 'INVALID_PROJECTION') {
  const repo = requiredString(value, field, 256, code);
  if (!REPO_RE.test(repo)) fail(code, `${field} must be owner/repo`, { field, repo }, 422);
  return repo;
}

function normalizeProse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sameText(a, b) { return normalizeProse(a) === normalizeProse(b); }
// Repository coordinate normalization is centralized in lib/work-identity.js.
function sameRepo(a, b) { return repositoryIdentity(a) === repositoryIdentity(b); }

export function canonicalPortfolioSourceKey(repo, issueNumber, { unit_key = null, canonical_key = null } = {}) {
  return canonicalExecutableSourceKey({ repo, issue_number: issueNumber, unit_key, canonical_key });
}

export function normalizePortfolioReconcileRequest(input) {
  const body = object(input, 'request', 'INVALID_REQUEST');
  exactFields(body, REQUEST_FIELDS, 'request', 'INVALID_REQUEST');
  const project = requiredString(body.project, 'project', 128, 'INVALID_REQUEST');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25) {
    fail('INVALID_REQUEST', 'items must contain between 1 and 25 candidates', { count: Array.isArray(body.items) ? body.items.length : null }, 422);
  }
  const idempotencyKey = body.idempotency_key == null ? null : requiredString(body.idempotency_key, 'idempotency_key', 256, 'INVALID_REQUEST');
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') fail('INVALID_REQUEST', 'dry_run must be boolean', { field: 'dry_run' }, 422);
  let frontierLimit = null;
  if (body.frontier_limit !== undefined && body.frontier_limit !== null) {
    frontierLimit = Number(body.frontier_limit);
    if (!Number.isInteger(frontierLimit) || frontierLimit < 1 || frontierLimit > 25) fail('INVALID_REQUEST', 'frontier_limit must be an integer from 1 through 25', { field: 'frontier_limit' }, 422);
  }
  return { project, items: body.items, idempotency_key: idempotencyKey, dry_run: Boolean(body.dry_run), frontier_limit: frontierLimit };
}

function normalizeItem(raw, index) {
  const item = object(raw, `items[${index}]`);
  exactFields(item, ITEM_FIELDS, `items[${index}]`);
  const source = object(item.source, `items[${index}].source`);
  exactFields(source, SOURCE_FIELDS, `items[${index}].source`);
  const kind = requiredString(source.kind, `items[${index}].source.kind`, 64);
  if (kind !== SOURCE_KIND) fail('UNSUPPORTED_SOURCE_KIND', `only ${SOURCE_KIND} is supported`, { kind }, 422);
  const repo = canonicalRepo(source.repo, `items[${index}].source.repo`);
  if (!Number.isInteger(source.issue_number) || source.issue_number < 1 || source.issue_number > 2147483647) {
    fail('INVALID_PROJECTION', 'issue_number must be a positive integer', { field: `items[${index}].source.issue_number` }, 422);
  }
  const expectedRevision = optionalString(source.expected_revision, `items[${index}].source.expected_revision`, 128);
  const unitKey = optionalString(source.unit_key, `items[${index}].source.unit_key`, 256);
  const canonicalKey = optionalString(source.canonical_key, `items[${index}].source.canonical_key`, 256);
  try { canonicalExecutableSourceKey({ repo, issue_number: source.issue_number, unit_key: unitKey, canonical_key: canonicalKey }); }
  catch (error) { fail('INVALID_PROJECTION', String(error?.message || 'invalid executable source identity'), { field: canonicalKey ? `items[${index}].source.canonical_key` : `items[${index}].source.unit_key` }, 422); }

  const projection = object(item.projection, `items[${index}].projection`);
  exactFields(projection, PROJECTION_FIELDS, `items[${index}].projection`);
  const title = requiredString(projection.title, `items[${index}].projection.title`, 255);
  const lane = requiredString(projection.lane, `items[${index}].projection.lane`, 128);
  if (!ACTIVE_LANES.has(lane)) fail('INVALID_LANE', 'lane is outside the adopted execution surface', { lane }, 422);
  const priority = Number(projection.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) fail('INVALID_PROJECTION', 'priority must be a Linear integer priority from 0 through 4', { priority }, 422);

  const outcome = optionalString(projection.outcome, `items[${index}].projection.outcome`, 4000);
  const nextAction = optionalString(projection.next_action, `items[${index}].projection.next_action`, 2000);
  const actor = optionalString(projection.actor, `items[${index}].projection.actor`, 64) || 'none';
  const disposition = optionalString(projection.disposition, `items[${index}].projection.disposition`, 64) || 'KEEP_EXECUTABLE';
  if (projection.changes_authority_or_produces_evidence !== undefined && typeof projection.changes_authority_or_produces_evidence !== 'boolean') {
    fail('INVALID_PROJECTION', 'changes_authority_or_produces_evidence must be boolean', { field: `items[${index}].projection.changes_authority_or_produces_evidence` }, 422);
  }
  if (projection.authoritative_complete !== undefined && typeof projection.authoritative_complete !== 'boolean') {
    fail('INVALID_PROJECTION', 'authoritative_complete must be boolean', { field: `items[${index}].projection.authoritative_complete` }, 422);
  }
  const promotionCondition = optionalString(projection.promotion_condition, `items[${index}].projection.promotion_condition`, 2000);
  const policy = classifyWorkSurfaceProjection({
    disposition,
    outcome,
    next_action: nextAction,
    actor,
    changes_authority_or_produces_evidence: projection.changes_authority_or_produces_evidence === true,
    promotion_condition: promotionCondition,
  });
  const requestedState = optionalString(projection.state, `items[${index}].projection.state`, 64);
  if (requestedState && !ACTIVE_STATES.has(requestedState)) fail('INVALID_STATE', 'state must be Todo or Backlog; In Progress belongs to work.claim', { state: requestedState }, 422);
  if (policy.visible && requestedState && requestedState !== policy.linear_state) {
    fail('INVALID_STATE', `state must be ${policy.linear_state} for ${policy.disposition}`, { requested_state: requestedState, required_state: policy.linear_state }, 422);
  }

  const repository = projection.repository == null ? null : canonicalRepo(projection.repository, `items[${index}].projection.repository`);
  if (repository && !sameRepo(repository, repo)) fail('INVALID_PROJECTION', 'projection.repository must match source.repo', { source_repo: repo, projection_repository: repository }, 422);
  const exactCoordinate = optionalString(projection.exact_coordinate, `items[${index}].projection.exact_coordinate`, 1000);
  const ownerImpact = optionalString(projection.owner_impact, `items[${index}].projection.owner_impact`, 500);
  const objective = optionalString(projection.objective, `items[${index}].projection.objective`, 4000);
  const gate = optionalString(projection.gate, `items[${index}].projection.gate`, 2000);
  const rawAcceptance = projection.acceptance == null ? [] : projection.acceptance;
  if (!Array.isArray(rawAcceptance) || rawAcceptance.length > 20) fail('INVALID_PROJECTION', 'acceptance must be an array of at most 20 bounded strings', { field: `items[${index}].projection.acceptance` }, 422);
  const acceptance = rawAcceptance.map((entry, acceptanceIndex) => requiredString(entry, `items[${index}].projection.acceptance[${acceptanceIndex}]`, 1000));

  const rawDependencies = projection.dependencies == null ? [] : projection.dependencies;
  if (!Array.isArray(rawDependencies) || rawDependencies.length > 25) fail('INVALID_PROJECTION', 'dependencies must be an array of at most 25 explicit references', null, 422);
  const seen = new Set();
  const dependencies = [];
  for (let dependencyIndex = 0; dependencyIndex < rawDependencies.length; dependencyIndex += 1) {
    const dependency = object(rawDependencies[dependencyIndex], `items[${index}].projection.dependencies[${dependencyIndex}]`);
    exactFields(dependency, DEPENDENCY_FIELDS, `items[${index}].projection.dependencies[${dependencyIndex}]`);
    const dependencyKind = requiredString(dependency.kind, `items[${index}].projection.dependencies[${dependencyIndex}].kind`, 64);
    if (dependencyKind !== 'linear_issue') fail('INVALID_PROJECTION', 'dependency kind must be linear_issue', { kind: dependencyKind }, 422);
    const ref = requiredString(dependency.ref, `items[${index}].projection.dependencies[${dependencyIndex}].ref`, 128).toUpperCase();
    if (!seen.has(ref)) { seen.add(ref); dependencies.push({ kind: 'linear_issue', ref }); }
  }

  return {
    source: { kind, repo, issue_number: source.issue_number, expected_revision: expectedRevision, unit_key: unitKey, canonical_key: canonicalKey },
    projection: {
      title, state: policy.linear_state, lane, priority,
      outcome, next_action: nextAction, actor,
      changes_authority_or_produces_evidence: projection.changes_authority_or_produces_evidence === true,
      disposition: policy.disposition, authoritative_complete: projection.authoritative_complete === true,
      objective, gate, acceptance, repository, exact_coordinate: exactCoordinate, owner_impact: ownerImpact,
      dependencies, promotion_condition: promotionCondition, policy,
    },
  };
}

function fieldish(line) {
  const normalized = String(line || '').trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
  const match = normalized.match(/^([A-Za-z][A-Za-z0-9 _/-]{0,80}):\s*(.*)$/);
  return match ? { label: match[1].trim().toLowerCase(), value: match[2] } : null;
}

function parseDescription(description) {
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');
  const consumed = new Array(lines.length).fill(false);
  const managed = {
    repository: null, authority: null, outcome: null, next_action: null, promotion_condition: null,
    objective: null, gate: null, acceptance: [], exact_coordinate: null, owner_impact: null,
  };
  const simple = new Map([
    ['repository', 'repository'], ['authority', 'authority'], ['github authority', 'authority'],
    ['outcome', 'outcome'], ['next action', 'next_action'],
    ['promotion condition', 'promotion_condition'], ['exact coordinate', 'exact_coordinate'], ['owner impact', 'owner_impact'],
  ]);
  const sections = new Map([['objective', 'objective'], ['gate', 'gate'], ['acceptance', 'acceptance']]);

  for (let i = 0; i < lines.length; i += 1) {
    const token = fieldish(lines[i]);
    if (!token) continue;
    if (simple.has(token.label)) {
      consumed[i] = true;
      managed[simple.get(token.label)] = token.value.trim() || null;
      continue;
    }
    if (!sections.has(token.label)) continue;
    const key = sections.get(token.label);
    consumed[i] = true;
    const values = [];
    if (token.value.trim()) values.push(token.value.trim());
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = fieldish(lines[j]);
      if (next) break;
      consumed[j] = true;
      const line = lines[j].trim();
      if (line) values.push(line);
    }
    if (key === 'acceptance') {
      managed.acceptance = values.map(value => normalizeProse(value.replace(/^[-*+]\s*/, ''))).filter(Boolean);
    } else {
      managed[key] = values.length ? normalizeProse(values.join(' ')) : null;
    }
    i = j - 1;
  }

  const unknown = lines.filter((_, index) => !consumed[index]).join('\n').trim();
  managed.repository = managed.repository ? managed.repository.trim() : null;
  managed.authority = managed.authority ? normalizeProse(managed.authority) : null;
  managed.outcome = managed.outcome ? normalizeProse(managed.outcome) : null;
  managed.next_action = managed.next_action ? normalizeProse(managed.next_action) : null;
  managed.exact_coordinate = managed.exact_coordinate ? normalizeProse(managed.exact_coordinate) : null;
  managed.owner_impact = managed.owner_impact ? normalizeProse(managed.owner_impact) : null;
  managed.promotion_condition = managed.promotion_condition ? normalizeProse(managed.promotion_condition) : null;
  return { managed, unknown };
}

export function buildLinearWorkDescription({ repo, issueNumber, projection }) {
  const lines = [
    `Repository: ${repo}`,
    `Authority: GitHub #${issueNumber}`,
    `Outcome: ${projection.outcome || ''}`,
    `Next action: ${projection.next_action || ''}`,
  ];
  if (projection.promotion_condition) lines.push(`Promotion condition: ${projection.promotion_condition.trim()}`);
  return lines.join('\n').trim();
}

function mergeLinearWorkDescription(existing, args) {
  const parsed = parseDescription(existing);
  const managed = buildLinearWorkDescription(args);
  return parsed.unknown ? `${managed}\n\n${parsed.unknown}` : managed;
}

function descriptionDiff(existing, repo, issueNumber, projection) {
  const { managed } = parseDescription(existing);
  const expected = {
    repository: repo,
    authority: `GitHub #${issueNumber}`,
    outcome: normalizeProse(projection.outcome),
    next_action: normalizeProse(projection.next_action),
    promotion_condition: projection.promotion_condition ? normalizeProse(projection.promotion_condition) : null,
  };
  const changed = [];
  if (!sameRepo(managed.repository, expected.repository)) changed.push('repository');
  if (!sameText(managed.authority, expected.authority)) changed.push('authority');
  if (!sameText(managed.outcome, expected.outcome)) changed.push('outcome');
  if (!sameText(managed.next_action, expected.next_action)) changed.push('next_action');
  if (!sameText(managed.promotion_condition, expected.promotion_condition)) changed.push('promotion_condition');
  if (managed.objective || managed.gate || (managed.acceptance || []).length || managed.exact_coordinate || managed.owner_impact) changed.push('legacy_packet_fields');
  return changed;
}

function laneName(issue) {
  const lanes = (issue?.labels || []).map(label => String(label?.name || '')).filter(name => name.startsWith('lane:'));
  if (lanes.length === 1) return lanes[0];
  return null;
}

function isTerminal(issue) {
  return Boolean(issue?.archivedAt) || TERMINAL_TYPES.has(String(issue?.state?.type || '').toLowerCase());
}

function stateId(project, name) {
  const state = (project.states || []).find(candidate => candidate.name === name);
  if (!state) fail('LINEAR_CONFIGURATION_ERROR', `Linear state ${name} is not configured`, { state: name }, 502);
  return state.id;
}

function laneId(project, name) {
  const label = (project.labels || []).find(candidate => candidate.name === name);
  if (!label) fail('LINEAR_CONFIGURATION_ERROR', `Linear lane ${name} is not configured`, { lane: name }, 502);
  return label.id;
}

function currentDependencyRefs(issue) {
  return new Set((issue?.dependencies || []).map(value => String(value).toUpperCase()));
}

function resultName(base, dryRun) {
  if (!dryRun) return base;
  if (base === 'created') return 'would_create';
  if (base === 'reused') return 'would_reuse';
  if (base === 'updated') return 'would_update';
  if (base === 'ignored') return 'would_ignore';
  return 'would_reject';
}

function rejected(sourceKey, revision, reason, dryRun, extra = {}) {
  return {
    source_key: sourceKey || null,
    source_revision: revision || null,
    result: resultName('rejected', dryRun),
    reason,
    changed_fields: [],
    ...extra,
  };
}

function stableItemError(error, sourceKey, revision, dryRun) {
  const code = String(error?.code || '');
  if (!ITEM_REJECTION_CODES.has(code)) throw error;
  return rejected(sourceKey, revision, code, dryRun, error?.details && typeof error.details === 'object' ? error.details : {});
}

async function inspectGithubSource(github, source) {
  if (typeof github.inspectIssue === 'function') return github.inspectIssue(source.repo, source.issue_number);
  const repository = await github.getRepository(source.repo);
  const issue = repository ? await github.getIssue(source.repo, source.issue_number) : null;
  return { repository, issue };
}

function sourceIdentityRow(sourceKey, repo, issueNumber, linearIssue, sourceRevision) {
  return {
    source_key: sourceKey,
    source_kind: SOURCE_KIND,
    source_repo: repo,
    source_issue_number: issueNumber,
    linear_issue_id: linearIssue.id,
    linear_identifier: linearIssue.identifier,
    last_source_revision: sourceRevision,
  };
}

function summarize(items) {
  const dry = items.some(item => String(item.result || '').startsWith('would_'));
  const keys = dry
    ? ['would_create', 'would_reuse', 'would_update', 'would_ignore', 'would_reject']
    : ['created', 'reused', 'updated', 'ignored', 'rejected'];
  const summary = Object.fromEntries(keys.map(key => [key, 0]));
  for (const item of items) summary[item.result] = (summary[item.result] || 0) + 1;
  return summary;
}

function globalError(error) {
  if (error instanceof PortfolioReconcileError) {
    return { ok: false, error: error.code, message: error.message, ...(error.details && typeof error.details === 'object' ? error.details : {}) };
  }
  if (error?.code) return { ok: false, error: String(error.code), message: String(error.message || error.code), ...(error.details && typeof error.details === 'object' ? error.details : {}) };
  throw error;
}

export function createPortfolioReconcileService({ github, linear, identityStore, receiptStore, leaseStore, repositoryLifecycle = null, now = () => new Date().toISOString() } = {}) {
  if (!github || !linear || !identityStore || !leaseStore) throw new TypeError('github, linear, identityStore, and leaseStore are required');

  async function resolveExisting(sourceKey, repo, issueNumber, scopedIdentity = false) {
    const mapped = await identityStore.get(sourceKey);
    let mappedIssue = null;
    if (mapped) mappedIssue = await linear.getIssue(mapped.linear_issue_id || mapped.linear_identifier);
    if (mapped && !mappedIssue) {
      return { conflict: [mapped.linear_identifier || mapped.linear_issue_id].filter(Boolean), existing: null };
    }
    if (scopedIdentity) return { conflict: null, existing: mappedIssue };
    const matches = await linear.findBySource(repo, issueNumber);
    const all = new Map();
    if (mappedIssue) all.set(mappedIssue.id, mappedIssue);
    for (const match of matches || []) all.set(match.id, match);
    if (all.size > 1) return { conflict: [...all.values()].map(issue => issue.identifier).sort(), existing: null };
    return { conflict: null, existing: all.size === 1 ? [...all.values()][0] : null };
  }

  async function validateDependencies(item, existingIdentifier = null) {
    const resolved = [];
    for (const dependency of item.projection.dependencies) {
      if (existingIdentifier && dependency.ref === String(existingIdentifier).toUpperCase()) {
        fail('INVALID_PROJECTION', 'an issue cannot depend on itself', { dependency: dependency.ref }, 422);
      }
      const issue = await linear.getIssue(dependency.ref);
      if (!issue) fail('DEPENDENCY_NOT_FOUND', `Linear dependency ${dependency.ref} was not found`, { dependency: dependency.ref }, 422);
      resolved.push(issue);
    }
    return resolved;
  }

  async function reconcileItem(rawItem, index, project, dryRun, onEffect = null, frontier = null) {
    async function durableEffect(effect, metadata, operation) {
      if (onEffect) await onEffect({ phase: 'dispatching', effect, ...metadata });
      const value = await operation();
      if (onEffect) {
        await onEffect({
          phase: 'confirmed',
          effect,
          ...metadata,
          ...(value?.identifier ? { linear_issue: value.identifier, linear_issue_id: value.id || null } : {}),
        });
      }
      return value;
    }
    async function terminalizeExisting(existingIssue, targetState, reason) {
      const activeLease = await leaseStore.getActive(existingIssue.identifier, now());
      if (activeLease) {
        return rejected(sourceKey, sourceRevision, 'ACTIVE_WORK_LEASE', dryRun, {
          linear_issue: existingIssue.identifier,
          linear_issue_id: existingIssue.id,
          lease_expires_at: activeLease.expires_at,
          requested_disposition: item?.projection?.disposition || null,
        });
      }
      if (dryRun) {
        return {
          source_key: sourceKey, source_revision: sourceRevision, result: 'would_update', reason,
          linear_issue: existingIssue.identifier, linear_issue_id: existingIssue.id, changed_fields: ['state'],
          target_state: targetState,
        };
      }
      const fresh = await linear.getIssue(existingIssue.identifier);
      if (!fresh || fresh.updatedAt !== existingIssue.updatedAt) {
        return rejected(sourceKey, sourceRevision, 'LINEAR_REVISION_MISMATCH', false, {
          linear_issue: existingIssue.identifier,
          linear_issue_id: existingIssue.id,
          expected_revision: existingIssue.updatedAt,
          actual_revision: fresh?.updatedAt || null,
        });
      }
      const updated = await durableEffect('linear.update_issue', { source_key: sourceKey, linear_issue: fresh.identifier }, () => linear.updateIssue({
        identifier: fresh.identifier,
        expectedRevision: fresh.updatedAt,
        input: { stateId: stateId(project, targetState) },
      }));
      if (frontier && !isTerminal(existingIssue) && isTerminal(updated)) frontier.active_count = Math.max(0, frontier.active_count - 1);
      return {
        source_key: sourceKey, source_revision: sourceRevision, result: 'updated', reason,
        linear_issue: updated.identifier, linear_issue_id: updated.id, changed_fields: ['state'], target_state: targetState,
      };
    }
    let item;
    let sourceKey = null;
    let sourceRevision = null;
    try {
      item = normalizeItem(rawItem, index);
      sourceKey = canonicalPortfolioSourceKey(item.source.repo, item.source.issue_number, item.source);
    } catch (error) {
      return stableItemError(error, sourceKey, sourceRevision, dryRun);
    }

    let inspection;
    try {
      inspection = await inspectGithubSource(github, item.source);
    } catch (error) {
      return stableItemError(error, sourceKey, sourceRevision, dryRun);
    }
    const repository = inspection?.repository || null;
    if (!repository) return rejected(sourceKey, null, 'SOURCE_NOT_FOUND', dryRun);
    const authoritativeRepo = canonicalRepo(repository.full_name || item.source.repo, 'github.repository.full_name');
    sourceKey = canonicalPortfolioSourceKey(authoritativeRepo, item.source.issue_number, item.source);

    const githubIssue = inspection?.issue || null;
    if (!githubIssue || Number(githubIssue.number) !== item.source.issue_number) return rejected(sourceKey, null, 'SOURCE_NOT_FOUND', dryRun);
    if (githubIssue.pull_request) return rejected(sourceKey, githubIssue.updated_at || null, 'SOURCE_NOT_ISSUE', dryRun);
    sourceRevision = String(githubIssue.updated_at || '');
    if (!sourceRevision) fail('GITHUB_UPSTREAM_ERROR', 'GitHub issue did not include updated_at', { source_key: sourceKey }, 502);
    if (item.source.expected_revision && item.source.expected_revision !== sourceRevision) {
      return rejected(sourceKey, sourceRevision, 'SOURCE_REVISION_MISMATCH', dryRun, {
        expected_revision: item.source.expected_revision,
        actual_revision: sourceRevision,
      });
    }

    const scopedIdentity = Boolean(item.source.unit_key || item.source.canonical_key);
    const resolution = await resolveExisting(sourceKey, authoritativeRepo, item.source.issue_number, scopedIdentity);
    if (resolution.conflict) return rejected(sourceKey, sourceRevision, 'IDENTITY_CONFLICT', dryRun, { conflicts: resolution.conflict });
    let existing = resolution.existing;

    if (existing && isTerminal(existing)) {
      return {
        source_key: sourceKey,
        source_revision: sourceRevision,
        result: resultName('ignored', dryRun),
        reason: 'ALREADY_TERMINAL',
        linear_issue: existing.identifier,
        linear_issue_id: existing.id,
        changed_fields: [],
      };
    }

    let lifecycle = null;
    if (repositoryLifecycle && typeof repositoryLifecycle.observe === 'function') lifecycle = await repositoryLifecycle.observe(authoritativeRepo);
    const repositoryDisposed = repository.archived === true || lifecycle?.ordinary_work_enabled === false;
    if (repositoryDisposed) {
      const disposition = lifecycle?.disposition === 'SUPERSEDED' ? 'SUPERSEDED' : 'DISPOSED_REPOSITORY';
      if (existing) return terminalizeExisting(existing, 'Canceled', disposition);
      return rejected(sourceKey, sourceRevision, disposition, dryRun, {
        disposition: lifecycle?.disposition || (repository.archived === true ? 'ARCHIVED' : null),
        successor_repository: lifecycle?.successor_repository || null,
      });
    }

    if (!item.projection.policy.visible) {
      if (!existing) return rejected(sourceKey, sourceRevision, item.projection.disposition, dryRun, { admitted: false });
      const targetState = terminalStateForDisposition(item.projection.disposition, { authoritative_complete: item.projection.authoritative_complete });
      return terminalizeExisting(existing, targetState || 'Canceled', item.projection.disposition);
    }

    const sourceOpen = String(githubIssue.state || '').toLowerCase() === 'open';
    if (!sourceOpen) {
      if (!existing) return rejected(sourceKey, sourceRevision, 'SOURCE_NOT_OPEN', dryRun);
      return terminalizeExisting(existing, 'Done', 'SOURCE_CLOSED');
    }

    let dependencies;
    try { dependencies = await validateDependencies(item, existing?.identifier || null); }
    catch (error) { return stableItemError(error, sourceKey, sourceRevision, dryRun); }

    if (!existing) {
      if (!NEW_ADMISSION_LANES.has(item.projection.lane)) return rejected(sourceKey, sourceRevision, 'PHASE_TICKET_NOT_ADMITTED', dryRun, { lane: item.projection.lane });
      if (frontier?.limit && frontier.active_count >= frontier.limit) {
        return rejected(sourceKey, sourceRevision, 'FRONTIER_LIMIT_REACHED', dryRun, { frontier_limit: frontier.limit, active_count: frontier.active_count });
      }
      const changedFields = ['title', 'state', 'lane', 'priority', 'description'];
      if (item.projection.dependencies.length) changedFields.push('dependencies');
      if (dryRun) {
        return { source_key: sourceKey, source_revision: sourceRevision, result: 'would_create', reason: 'CREATED', linear_issue: null, linear_issue_id: null, changed_fields: changedFields };
      }
      const created = await durableEffect('linear.create_issue', { source_key: sourceKey }, () => linear.createIssue({
        title: item.projection.title,
        description: buildLinearWorkDescription({ repo: authoritativeRepo, issueNumber: item.source.issue_number, projection: item.projection }),
        priority: item.projection.priority,
        teamId: project.team_id,
        projectId: project.id,
        stateId: stateId(project, item.projection.state),
        labelIds: [laneId(project, item.projection.lane)],
      }));
      for (const dependency of dependencies) {
        await durableEffect('linear.ensure_dependency', {
          source_key: sourceKey,
          linear_issue: created.identifier,
          dependency: dependency.identifier,
        }, () => linear.ensureDependencyRelation(created.identifier, dependency.identifier));
      }
      const finalIssue = item.projection.dependencies.length ? await linear.getIssue(created.identifier) : created;
      await durableEffect('identity.put', { source_key: sourceKey, linear_issue: finalIssue.identifier }, () => identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, finalIssue, sourceRevision)));
      if (frontier) frontier.active_count += 1;
      return {
        source_key: sourceKey, source_revision: sourceRevision, result: 'created', reason: 'CREATED',
        linear_issue: finalIssue.identifier, linear_issue_id: finalIssue.id, changed_fields: changedFields,
      };
    }

    if (existing.dependencies === undefined) {
      const detailed = await linear.getIssue(existing.identifier);
      if (!detailed) return rejected(sourceKey, sourceRevision, 'IDENTITY_CONFLICT', dryRun, { conflicts: [existing.identifier] });
      existing = detailed;
    }

    const changedFields = [];
    if (existing.title !== item.projection.title) changedFields.push('title');
    if (existing.project?.id !== project.id) changedFields.push('project');
    if (existing.state?.name !== item.projection.state) changedFields.push('state');
    if (laneName(existing) !== item.projection.lane) changedFields.push('lane');
    if (Number(existing.priority ?? 0) !== item.projection.priority) changedFields.push('priority');
    const descriptionChanges = descriptionDiff(existing.description, authoritativeRepo, item.source.issue_number, item.projection);
    changedFields.push(...descriptionChanges);
    const currentDeps = currentDependencyRefs(existing);
    const missingDependencies = dependencies.filter(dependency => !currentDeps.has(String(dependency.identifier).toUpperCase()));
    if (missingDependencies.length) changedFields.push('dependencies');

    if (!changedFields.length) {
      if (!dryRun) {
        await durableEffect('identity.put', { source_key: sourceKey, linear_issue: existing.identifier }, () => identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, existing, sourceRevision)));
      }
      return {
        source_key: sourceKey, source_revision: sourceRevision, result: resultName('reused', dryRun), reason: 'EXACT_MATCH',
        linear_issue: existing.identifier, linear_issue_id: existing.id, changed_fields: [],
      };
    }

    const activeLease = await leaseStore.getActive(existing.identifier, now());
    if (activeLease) {
      return rejected(sourceKey, sourceRevision, 'ACTIVE_WORK_LEASE', dryRun, {
        linear_issue: existing.identifier,
        linear_issue_id: existing.id,
        lease_expires_at: activeLease.expires_at,
      });
    }

    if (dryRun) {
      return {
        source_key: sourceKey, source_revision: sourceRevision, result: 'would_update', reason: 'PROJECTION_UPDATED',
        linear_issue: existing.identifier, linear_issue_id: existing.id, changed_fields: changedFields,
      };
    }

    const fresh = await linear.getIssue(existing.identifier);
    if (!fresh || fresh.updatedAt !== existing.updatedAt) {
      return rejected(sourceKey, sourceRevision, 'LINEAR_REVISION_MISMATCH', false, {
        linear_issue: existing.identifier,
        linear_issue_id: existing.id,
        expected_revision: existing.updatedAt,
        actual_revision: fresh?.updatedAt || null,
      });
    }

    const input = {};
    if (changedFields.includes('title')) input.title = item.projection.title;
    if (changedFields.includes('project')) input.projectId = project.id;
    if (changedFields.includes('priority')) input.priority = item.projection.priority;
    if (changedFields.includes('state')) input.stateId = stateId(project, item.projection.state);
    if (changedFields.includes('lane')) {
      const preserved = (fresh.labels || []).filter(label => !String(label.name || '').startsWith('lane:')).map(label => label.id);
      input.labelIds = [...preserved, laneId(project, item.projection.lane)];
    }
    if (descriptionChanges.length) {
      input.description = mergeLinearWorkDescription(fresh.description, { repo: authoritativeRepo, issueNumber: item.source.issue_number, projection: item.projection });
    }

    let updated = fresh;
    if (Object.keys(input).length) {
      try {
        updated = await durableEffect('linear.update_issue', { source_key: sourceKey, linear_issue: fresh.identifier }, () => linear.updateIssue({ identifier: fresh.identifier, expectedRevision: fresh.updatedAt, input }));
      } catch (error) {
        if (error?.code === 'LINEAR_REVISION_MISMATCH') return stableItemError(error, sourceKey, sourceRevision, false);
        throw error;
      }
    }
    for (const dependency of missingDependencies) {
      await durableEffect('linear.ensure_dependency', {
        source_key: sourceKey,
        linear_issue: updated.identifier,
        dependency: dependency.identifier,
      }, () => linear.ensureDependencyRelation(updated.identifier, dependency.identifier));
    }
    if (missingDependencies.length) updated = await linear.getIssue(updated.identifier);
    await durableEffect('identity.put', { source_key: sourceKey, linear_issue: updated.identifier }, () => identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, updated, sourceRevision)));
    return {
      source_key: sourceKey, source_revision: sourceRevision, result: 'updated', reason: 'PROJECTION_UPDATED',
      linear_issue: updated.identifier, linear_issue_id: updated.id, changed_fields: changedFields,
    };
  }

  async function reconcile(input) {
    let normalized;
    let requestHash = null;
    let receiptClaimed = false;
    let recovering = false;
    let progress = { version: 'portfolio-reconcile-progress-v1', may_have_mutated: false, items: [] };

    function progressEntry(index) {
      let entry = progress.items.find(candidate => candidate.index === index);
      if (!entry) {
        entry = { index, state: 'pending', may_have_mutated: false, last_effect: null, result: null };
        progress.items.push(entry);
        progress.items.sort((a, b) => a.index - b.index);
      }
      return entry;
    }

    async function checkpoint(index, update) {
      if (!normalized?.idempotency_key || normalized.dry_run || !receiptStore) return;
      const entry = progressEntry(index);
      Object.assign(entry, update);
      if (update.may_have_mutated === true) {
        entry.may_have_mutated = true;
        progress.may_have_mutated = true;
      }
      await receiptStore.checkpoint(normalized.idempotency_key, requestHash, update.phase || 'item.progress', progress);
    }

    try {
      normalized = normalizePortfolioReconcileRequest(input);
      const semantic = { project: normalized.project, items: normalized.items, dry_run: normalized.dry_run, frontier_limit: normalized.frontier_limit };
      requestHash = await sha256Text(canonicalJson(semantic));

      if (!normalized.dry_run && normalized.idempotency_key) {
        if (!receiptStore) fail('IDEMPOTENCY_UNAVAILABLE', 'idempotency_key requires the configured reconciliation receipt store', null, 500);
        const claim = await receiptStore.claim(normalized.idempotency_key, requestHash);
        if (claim.kind === 'conflict') return { ok: false, error: 'IDEMPOTENCY_CONFLICT', message: 'idempotency_key was already used for a different semantic reconciliation request' };
        if (claim.kind === 'in_progress') return { ok: false, error: 'IDEMPOTENCY_IN_PROGRESS', message: 'an identical reconciliation request is already in progress' };
        if (claim.kind === 'existing') return { ...claim.receipt, idempotent_replay: true };
        receiptClaimed = true;
        recovering = claim.kind === 'recover';
        if (claim.progress && typeof claim.progress === 'object') {
          progress = {
            version: 'portfolio-reconcile-progress-v1',
            may_have_mutated: Boolean(claim.progress.may_have_mutated),
            items: Array.isArray(claim.progress.items) ? claim.progress.items : [],
          };
        }
      }

      const project = await linear.resolveProject(normalized.project);
      if (!project) fail('PROJECT_NOT_FOUND', `${normalized.project} was not found in Linear`, { project: normalized.project }, 404);
      const frontierLimit = frontierLimitForProject(normalized.project, normalized.frontier_limit);
      const frontier = {
        limit: frontierLimit,
        active_count: frontierLimit && typeof linear.countActiveProjectIssues === 'function'
          ? await linear.countActiveProjectIssues(project.id)
          : 0,
      };

      const items = [];
      const materialRecoveryReasons = new Set(['SOURCE_REVISION_MISMATCH', 'IDENTITY_CONFLICT', 'LINEAR_REVISION_MISMATCH', 'SOURCE_CLOSED_WITH_ACTIVE_LINEAR_WORK']);
      for (let index = 0; index < normalized.items.length; index += 1) {
        const prior = progress.items.find(candidate => candidate.index === index) || null;
        if (prior?.state === 'completed' && prior.result) {
          items.push({ ...prior.result, recovery_outcome: prior.result.recovery_outcome || 'effect_confirmed' });
          continue;
        }

        const hadUncertainEffect = Boolean(prior?.may_have_mutated || prior?.state === 'uncertain');
        const onEffect = normalized.idempotency_key && !normalized.dry_run ? async (effect) => {
          await checkpoint(index, {
            state: 'uncertain',
            may_have_mutated: true,
            phase: `item.${index}.${effect.phase}`,
            last_effect: {
              phase: effect.phase,
              effect: effect.effect,
              source_key: effect.source_key || null,
              linear_issue: effect.linear_issue || null,
              linear_issue_id: effect.linear_issue_id || null,
              dependency: effect.dependency || null,
            },
          });
        } : null;

        const itemResult = await reconcileItem(normalized.items[index], index, project, normalized.dry_run, onEffect, frontier);
        if (hadUncertainEffect && itemResult?.result === 'rejected' && materialRecoveryReasons.has(itemResult.reason)) {
          const details = {
            index,
            source_key: itemResult.source_key || null,
            reason: itemResult.reason,
            source_revision: itemResult.source_revision || null,
            prior_effect: prior?.last_effect || null,
          };
          await checkpoint(index, { state: 'uncertain', phase: `item.${index}.material_conflict`, recovery_outcome: 'material_conflict' });
          throw new PortfolioReconcileError(
            'PORTFOLIO_RECONCILE_RECOVERY_CONFLICT',
            'authoritative state materially changed while recovering an indeterminate reconciliation item',
            details,
            409,
          );
        }

        const output = hadUncertainEffect ? { ...itemResult, recovery_outcome: 'effect_confirmed' } : itemResult;
        items.push(output);
        await checkpoint(index, {
          state: 'completed',
          phase: `item.${index}.completed`,
          result: output,
          recovery_outcome: hadUncertainEffect ? 'effect_confirmed' : null,
        });
      }
      const receipt = {
        ok: true,
        project: normalized.project,
        summary: summarize(items),
        items,
        idempotent_replay: false,
        ...(recovering ? { recovered_indeterminate: true } : {}),
      };
      if (!normalized.dry_run && normalized.idempotency_key) await receiptStore.succeed(normalized.idempotency_key, requestHash, receipt, progress);
      return receipt;
    } catch (error) {
      if (receiptClaimed && normalized?.idempotency_key && receiptStore) {
        if (progress.may_have_mutated) {
          try {
            await receiptStore.markIndeterminate(normalized.idempotency_key, requestHash, progress, {
              error: String(error?.code || 'PORTFOLIO_RECONCILE_ERROR'),
              message: String(error?.message || 'portfolio reconciliation failed'),
            });
          } catch { /* preserve original failure */ }
          if (error?.code === 'PORTFOLIO_RECONCILE_RECOVERY_CONFLICT') return globalError(error);
          return {
            ok: false,
            error: 'PORTFOLIO_RECONCILE_INDETERMINATE',
            message: 'portfolio reconciliation may have performed a durable effect; retry only with the identical semantic request and idempotency_key',
            may_have_mutated: true,
            idempotency_key: normalized.idempotency_key,
            request_sha256: requestHash,
          };
        }
        try { await receiptStore.abandon(normalized.idempotency_key, requestHash); } catch { /* preserve original failure */ }
      }
      return globalError(error);
    }
  }

  return { reconcile };
}

function linearError(code, message, details = null, status = null) {
  return new PortfolioReconcileError(code, message, details, status);
}

export function createLinearPortfolioAuthority(apiBinding = api) {
  let cachedProject = null;

  async function gql(query, variables = {}) {
    let response;
    try {
      response = await apiBinding.call('linear', { method: 'POST', path: '', headers: { 'Content-Type': 'application/json' }, body: { query, variables } });
    } catch (error) {
      const message = String(error?.message || 'Linear connection failed');
      if (/412|required.*not set|setup/i.test(message)) throw linearError('LINEAR_SETUP_REQUIRED', 'Configure the existing Linear connection in Hatchable Setup.', null, 412);
      throw linearError('LINEAR_UPSTREAM_ERROR', message, null, 502);
    }
    const status = Number(response?.status || 0);
    if (status === 401 || status === 403) throw linearError('LINEAR_PERMISSION_DENIED', 'Linear authorization denied the requested operation.', { upstream_status: status }, 403);
    if (status < 200 || status >= 300) throw linearError('LINEAR_UPSTREAM_ERROR', `Linear returned HTTP ${status || 'unknown'}`, { upstream_status: status || null }, 502);
    let body = response.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { throw linearError('LINEAR_UPSTREAM_ERROR', 'Linear returned invalid JSON', null, 502); }
    }
    if (Array.isArray(body?.errors) && body.errors.length) {
      const message = String(body.errors[0]?.message || 'Linear GraphQL request failed');
      const codes = body.errors.map(error => String(error?.extensions?.code || ''));
      if (codes.some(code => /AUTH|PERMISSION|FORBIDDEN/i.test(code)) || /permission|forbidden|unauthorized/i.test(message)) {
        throw linearError('LINEAR_PERMISSION_DENIED', message, { errors: body.errors.map(error => ({ message: error.message, code: error.extensions?.code || null })) }, 403);
      }
      throw linearError('LINEAR_UPSTREAM_GRAPHQL', message, { errors: body.errors.map(error => ({ message: error.message, code: error.extensions?.code || null })) }, 502);
    }
    return body?.data || {};
  }

  function normalizeIssue(issue) {
    if (!issue) return null;
    const inverse = issue.inverseRelations?.nodes || [];
    const dependencies = inverse
      .filter(relation => relation.type === 'blocks' && relation.issue?.identifier)
      .map(relation => relation.issue.identifier);
    return {
      ...issue,
      labels: issue.labels?.nodes || issue.labels || [],
      dependencies,
    };
  }

  async function resolveProject(name) {
    const projectData = await gql(`query PortfolioProject($name: String!) { projects(first: 2, filter: { name: { eq: $name } }) { nodes { id name } } }`, { name });
    const nodes = projectData.projects?.nodes || [];
    if (nodes.length !== 1) return null;
    const project = nodes[0];
    const teamData = await gql(`query PortfolioProjectTeam($id: String!) { project(id: $id) { id name teams(first: 5) { nodes { id name } } } }`, { id: project.id });
    const teams = teamData.project?.teams?.nodes || [];
    if (teams.length !== 1) throw linearError('LINEAR_CONFIGURATION_ERROR', 'Selected Linear project must resolve to exactly one team.', { project: project.name, teams: teams.map(team => team.name) }, 502);
    const team = teams[0];
    const config = await gql(`query PortfolioTeamConfig($id: String!) { team(id: $id) { states(first: 50) { nodes { id name type } } labels(first: 100) { nodes { id name } } } }`, { id: team.id });
    cachedProject = {
      id: project.id,
      name: project.name,
      team_id: team.id,
      states: config.team?.states?.nodes || [],
      labels: config.team?.labels?.nodes || [],
    };
    return cachedProject;
  }

  async function findBySource(repo, issueNumber) {
    const project = cachedProject;
    if (!project?.team_id) throw linearError('LINEAR_CONFIGURATION_ERROR', 'resolveProject must run before source identity discovery.', null, 500);
    const expectedRepo = String(repo).toLowerCase();
    const expectedAuthority = `github #${issueNumber}`;
    const matches = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const data = await gql(`query PortfolioLegacyIdentity($team: ID!, $after: String) {
        issues(first: 100, after: $after, filter: { team: { id: { eq: $team } } }, includeArchived: true) {
          nodes { id identifier title description priority updatedAt archivedAt project { id name } state { id name type } labels { nodes { id name } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { team: project.team_id, after });
      for (const issue of data.issues?.nodes || []) {
        const parsed = parseDescription(issue.description).managed;
        if (sameRepo(parsed.repository, expectedRepo) && String(parsed.authority || '').toLowerCase() === expectedAuthority) {
          matches.push({ ...normalizeIssue(issue), dependencies: undefined });
        }
      }
      const pageInfo = data.issues?.pageInfo || {};
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }
    return matches;
  }

  async function getIssue(ref) {
    const data = await gql(`query PortfolioIssue($id: String!) {
      issue(id: $id) {
        id identifier title description priority updatedAt archivedAt
        project { id name }
        state { id name type }
        labels { nodes { id name } }
        relations(first: 50) { nodes { id type issue { id identifier } relatedIssue { id identifier } } }
        inverseRelations(first: 50) { nodes { id type issue { id identifier } relatedIssue { id identifier } } }
      }
    }`, { id: ref });
    return normalizeIssue(data.issue || null);
  }

  async function createIssue(input) {
    const data = await gql(`mutation PortfolioIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`, { input });
    if (data.issueCreate?.success !== true || !data.issueCreate?.issue?.identifier) throw linearError('LINEAR_MUTATION_FAILED', 'Linear did not confirm issue creation.', null, 502);
    return getIssue(data.issueCreate.issue.identifier);
  }

  async function updateIssue({ identifier, expectedRevision, input }) {
    const fresh = await getIssue(identifier);
    if (!fresh || fresh.updatedAt !== expectedRevision) {
      throw linearError('LINEAR_REVISION_MISMATCH', 'Linear issue changed before update.', { expected_revision: expectedRevision, actual_revision: fresh?.updatedAt || null }, 409);
    }
    const data = await gql(`mutation PortfolioIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id: fresh.id, input });
    if (data.issueUpdate?.success !== true) throw linearError('LINEAR_MUTATION_FAILED', 'Linear did not confirm issue update.', null, 502);
    return getIssue(identifier);
  }

  async function countActiveProjectIssues(projectId) {
    const data = await gql(`query PortfolioProjectActiveIssues($id: String!) {
      project(id: $id) {
        issues(first: 250) { nodes { id archivedAt state { type } } }
      }
    }`, { id: projectId });
    return (data.project?.issues?.nodes || []).filter(issue => !issue.archivedAt && !TERMINAL_TYPES.has(String(issue.state?.type || '').toLowerCase())).length;
  }

  async function ensureDependencyRelation(issueRef, dependencyRef) {
    let current = await getIssue(issueRef);
    const dependency = await getIssue(dependencyRef);
    if (!current || !dependency) throw linearError('DEPENDENCY_NOT_FOUND', `Dependency ${dependencyRef} was not found.`, { dependency: dependencyRef }, 422);
    if (currentDependencyRefs(current).has(String(dependency.identifier).toUpperCase())) return current;
    const data = await gql(`mutation PortfolioDependencyCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }`, {
      input: { type: 'blocks', issueId: dependency.id, relatedIssueId: current.id },
    });
    if (data.issueRelationCreate?.success !== true) throw linearError('LINEAR_MUTATION_FAILED', 'Linear did not confirm dependency relation creation.', null, 502);
    current = await getIssue(issueRef);
    return current;
  }

  return { resolveProject, findBySource, getIssue, createIssue, updateIssue, countActiveProjectIssues, ensureDependencyRelation };
}

function githubApiError(code, message, details = null, status = null) {
  return new PortfolioReconcileError(code, message, details, status);
}

export function createGitHubIssueApiAdapter(apiClient) {
  async function call(path, { allow404 = false } = {}) {
    const response = await apiClient.call('github', { method: 'GET', path, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 300) return response.body;
    if (allow404 && status === 404) return null;
    if (status === 401 || status === 403) throw githubApiError('GITHUB_PERMISSION_DENIED', 'GitHub denied repository issue read access.', { upstream_status: status }, status);
    if (status === 404) throw githubApiError('SOURCE_NOT_FOUND', 'GitHub source was not found.', { upstream_status: 404 }, 404);
    throw githubApiError('GITHUB_UPSTREAM_ERROR', `GitHub returned HTTP ${status || 'unknown'}`, { upstream_status: status || null }, 502);
  }
  function pathFor(repo) {
    const [owner, name] = repo.split('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }
  return {
    async inspectIssue(repo, issueNumber) {
      const base = pathFor(repo);
      const repository = await call(base, { allow404: true });
      if (!repository) return { repository: null, issue: null };
      const issue = await call(`${base}/issues/${issueNumber}`, { allow404: true });
      return { repository, issue };
    },
  };
}

export function createGitHubAppIssueAuthority() {
  return {
    async inspectIssue(repo, issueNumber) {
      try {
        return await withGitHubAppApiClient(repo, async apiClient => createGitHubIssueApiAdapter(apiClient).inspectIssue(repo, issueNumber), { permissionProfile: 'portfolio_reconcile' });
      } catch (error) {
        if (error instanceof PortfolioReconcileError) throw error;
        const message = String(error?.message || 'GitHub App authentication failed.');
        if (/config\/get 412|declared as required but not set/i.test(message)) throw githubApiError('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key in Hatchable Setup.', null, 412);
        if (Number(error?.status) === 404) throw githubApiError('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository.', { upstream_status: 404 }, 404);
        if (Number(error?.status) === 422) throw githubApiError('GITHUB_APP_PERMISSION_DENIED', 'The installed GitHub App is not configured for the repository issue-read permission required by this primitive.', {
          upstream_status: 422,
          required_permissions: { metadata: 'read', issues: 'read' },
        }, 403);
        if ([401, 403].includes(Number(error?.status))) throw githubApiError('GITHUB_PERMISSION_DENIED', message, { upstream_status: Number(error.status) }, 403);
        throw githubApiError(error?.code || 'GITHUB_APP_AUTH_ERROR', message, error?.status ? { upstream_status: Number(error.status) } : null, 502);
      }
    },
  };
}

export function createPostgresPortfolioIdentityStore(dbBinding = db) {
  return {
    async get(sourceKey) {
      const result = await dbBinding.query('SELECT * FROM portfolio_work_identity WHERE source_key = $1 LIMIT 1', [sourceKey]);
      return result.rows?.[0] || null;
    },
    async put(row) {
      const result = await dbBinding.query(`INSERT INTO portfolio_work_identity (
        source_key, source_kind, source_repo, source_issue_number, linear_issue_id, linear_identifier, last_source_revision
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (source_key) DO UPDATE SET
        source_kind = EXCLUDED.source_kind,
        source_repo = EXCLUDED.source_repo,
        source_issue_number = EXCLUDED.source_issue_number,
        linear_issue_id = EXCLUDED.linear_issue_id,
        linear_identifier = EXCLUDED.linear_identifier,
        last_source_revision = EXCLUDED.last_source_revision,
        updated_at = now()
      RETURNING *`, [row.source_key, row.source_kind, row.source_repo, row.source_issue_number, row.linear_issue_id, row.linear_identifier, row.last_source_revision]);
      return result.rows?.[0] || null;
    },
  };
}

export function createPostgresPortfolioReceiptStore(dbBinding = db) {
  function parsed(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return value;
  }
  return {
    async claim(key, hash) {
      const token = crypto.randomUUID();
      const inserted = await dbBinding.query(`INSERT INTO portfolio_reconcile_receipts (idempotency_key, request_sha256, state, attempt_token, phase, progress)
        VALUES ($1,$2,'processing',$3::uuid,'pre_effect',$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [
        key, hash, token, JSON.stringify({ version: 'portfolio-reconcile-progress-v1', may_have_mutated: false, items: [] }),
      ]);
      if (inserted.rows?.[0]) return { kind: 'claimed', progress: parsed(inserted.rows[0].progress) };
      let row = (await dbBinding.query('SELECT * FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 LIMIT 1', [key])).rows?.[0];
      if (!row) return { kind: 'in_progress' };
      if (row.request_sha256 !== hash) return { kind: 'conflict' };
      if (row.state === 'succeeded' && row.receipt) return { kind: 'existing', receipt: parsed(row.receipt) };
      if (row.state === 'indeterminate') {
        const recovered = await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET state = 'processing', attempt_token = $3::uuid,
          phase = 'recovery', updated_at = now() WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'indeterminate' RETURNING *`, [key, hash, token]);
        const recoveryRow = recovered.rows?.[0];
        if (recoveryRow) return { kind: 'recover', progress: parsed(recoveryRow.progress), last_error: parsed(recoveryRow.last_error) };
      }
      const existingProgress = parsed(row.progress);
      const staleHasEffects = Boolean(existingProgress?.may_have_mutated);
      if (row.state === 'processing' && staleHasEffects && Date.parse(row.updated_at) < Date.now() - STALE_RECEIPT_SECONDS * 1000) {
        const recovered = await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET state = 'processing', attempt_token = $3::uuid,
          phase = 'recovery', updated_at = now() WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing'
          AND updated_at < now() - interval '${STALE_RECEIPT_SECONDS} seconds' RETURNING *`, [key, hash, token]);
        const recoveryRow = recovered.rows?.[0];
        if (recoveryRow) return { kind: 'recover', progress: parsed(recoveryRow.progress), last_error: parsed(recoveryRow.last_error) };
      }
      const takeover = await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET attempt_token = $3::uuid, phase = 'pre_effect', updated_at = now()
        WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing'
          AND COALESCE((progress->>'may_have_mutated')::boolean, false) = false
          AND updated_at < now() - interval '${STALE_RECEIPT_SECONDS} seconds' RETURNING *`, [key, hash, token]);
      if (takeover.rows?.[0]) return { kind: 'claimed', progress: parsed(takeover.rows[0].progress) };
      row = (await dbBinding.query('SELECT * FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 LIMIT 1', [key])).rows?.[0];
      if (row?.state === 'succeeded' && row.receipt) return { kind: 'existing', receipt: parsed(row.receipt) };
      return { kind: 'in_progress' };
    },
    async checkpoint(key, hash, phase, progress) {
      const result = await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET phase = $3, progress = $4::jsonb, updated_at = now()
        WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing' RETURNING idempotency_key`, [key, hash, phase, canonicalJson(progress)]);
      if (!result.rows?.[0]) fail('IDEMPOTENCY_IN_PROGRESS', 'reconciliation receipt ownership was lost before a durable effect boundary', { idempotency_key: key }, 409);
    },
    async markIndeterminate(key, hash, progress, error) {
      await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET state = 'indeterminate', phase = 'indeterminate', progress = $3::jsonb,
        last_error = $4::jsonb, updated_at = now() WHERE idempotency_key = $1 AND request_sha256 = $2`, [key, hash, canonicalJson(progress), canonicalJson(error || {})]);
    },
    async succeed(key, hash, receipt, progress = null) {
      await dbBinding.query("UPDATE portfolio_reconcile_receipts SET state = 'succeeded', phase = 'completed', receipt = $3::jsonb, progress = COALESCE($4::jsonb, progress), last_error = NULL, updated_at = now() WHERE idempotency_key = $1 AND request_sha256 = $2", [key, hash, canonicalJson(receipt), progress ? canonicalJson(progress) : null]);
    },
    async abandon(key, hash) {
      await dbBinding.query("DELETE FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing' AND COALESCE((progress->>'may_have_mutated')::boolean, false) = false", [key, hash]);
    },
  };
}

export function createPostgresPortfolioLeaseReader(dbBinding = db) {
  return {
    async getActive(workRef, nowValue) {
      const result = await dbBinding.query(`SELECT s.work_ref, s.gate, s.lease_id, s.expires_at
        FROM work_lease_slots s JOIN work_leases l ON l.lease_id = s.lease_id
        WHERE s.work_ref = $1 AND s.expires_at > $2::timestamptz AND l.status IN ('claiming','active','settling')
        ORDER BY s.expires_at DESC LIMIT 1`, [workRef, nowValue]);
      return result.rows?.[0] || null;
    },
  };
}

export function createPostgresPortfolioReconcileService(options = {}) {
  const dbBinding = options.db || db;
  return createPortfolioReconcileService({
    github: options.github || createGitHubAppIssueAuthority(),
    linear: options.linear || createLinearPortfolioAuthority(options.api || api),
    identityStore: options.identityStore || createPostgresPortfolioIdentityStore(dbBinding),
    receiptStore: options.receiptStore || createPostgresPortfolioReceiptStore(dbBinding),
    leaseStore: options.leaseStore || createPostgresPortfolioLeaseReader(dbBinding),
    repositoryLifecycle: options.repositoryLifecycle || createPostgresRepositoryLifecycleService({ db: dbBinding, api: options.api || api, now: options.now }),
    now: options.now,
  });
}

export async function reconcilePortfolioWorkSurface(input, options = {}) {
  return createPostgresPortfolioReconcileService(options).reconcile(input);
}

export async function reconcilePortfolioWorkSurfaceWithGitHubApp(input, options = {}) {
  return reconcilePortfolioWorkSurface(input, options);
}

export function statusForPortfolioReconcileResult(result) {
  if (result?.ok) return 200;
  const code = String(result?.error || 'PORTFOLIO_RECONCILE_ERROR');
  if (code === 'INVALID_REQUEST') return 400;
  if (['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'PORTFOLIO_RECONCILE_INDETERMINATE', 'PORTFOLIO_RECONCILE_RECOVERY_CONFLICT'].includes(code)) return 409;
  if (['GITHUB_APP_PERMISSION_DENIED', 'GITHUB_PERMISSION_DENIED', 'LINEAR_PERMISSION_DENIED'].includes(code)) return 403;
  if (['PROJECT_NOT_FOUND', 'GITHUB_APP_INSTALLATION_NOT_FOUND'].includes(code)) return 404;
  if (['GITHUB_APP_SETUP_REQUIRED', 'LINEAR_SETUP_REQUIRED'].includes(code)) return 412;
  if (code.startsWith('INVALID_')) return 422;
  return 502;
}

export const portfolioReconcileConfig = Object.freeze({
  source_kind: SOURCE_KIND,
  max_items: 25,
  active_states: [...ACTIVE_STATES],
  active_lanes: [...ACTIVE_LANES],
  new_admission_lanes: [...NEW_ADMISSION_LANES],
  source_key_format: 'github:owner/repo#issue:N[#unit:key] or canonical:key',
  result_values: ['created', 'reused', 'updated', 'ignored', 'rejected'],
  stable_reasons: [
    'CREATED', 'EXACT_MATCH', 'PROJECTION_UPDATED', 'SOURCE_REVISION_MISMATCH',
    'SOURCE_NOT_OPEN', 'SOURCE_CLOSED', 'SOURCE_NOT_FOUND', 'SOURCE_NOT_ISSUE',
    'IDENTITY_CONFLICT', 'ACTIVE_WORK_LEASE', 'LINEAR_REVISION_MISMATCH',
    'INVALID_PROJECTION', 'INVALID_LANE', 'INVALID_STATE', 'DEPENDENCY_NOT_FOUND',
    'ALREADY_TERMINAL', 'UNSUPPORTED_SOURCE_KIND', 'PHASE_TICKET_NOT_ADMITTED',
    'FRONTIER_LIMIT_REACHED', 'KEEP_EXECUTABLE', 'BLOCKED_EXTERNAL', 'WAITING_HUMAN',
    'DERIVED_STATE', 'HISTORICAL_REFERENCE', 'SUPERSEDED', 'DUPLICATE',
    'DISPOSED_REPOSITORY', 'NO_EXECUTABLE_ACTION',
    'GITHUB_APP_INSTALLATION_NOT_FOUND', 'GITHUB_APP_PERMISSION_DENIED', 'GITHUB_PERMISSION_DENIED',
  ],
});

export const portfolioReconcileInternals = Object.freeze({ normalizeItem, parseDescription, descriptionDiff, laneName, isTerminal });