import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const PROJECT = 'Portfolio Orchestration';
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
const REQUEST_FIELDS = new Set(['project', 'items', 'idempotency_key', 'dry_run']);
const ITEM_FIELDS = new Set(['source', 'projection']);
const SOURCE_FIELDS = new Set(['kind', 'repo', 'issue_number', 'expected_revision']);
const PROJECTION_FIELDS = new Set([
  'title', 'state', 'lane', 'priority', 'objective', 'gate', 'acceptance',
  'repository', 'exact_coordinate', 'owner_impact', 'dependencies', 'promotion_condition',
]);
const DEPENDENCY_FIELDS = new Set(['kind', 'ref']);
const ITEM_REJECTION_CODES = new Set([
  'INVALID_PROJECTION', 'INVALID_LANE', 'INVALID_STATE', 'DEPENDENCY_NOT_FOUND',
  'UNSUPPORTED_SOURCE_KIND', 'GITHUB_APP_INSTALLATION_NOT_FOUND',
  'GITHUB_APP_PERMISSION_DENIED', 'GITHUB_PERMISSION_DENIED', 'SOURCE_NOT_FOUND', 'SOURCE_NOT_ISSUE',
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
function sameRepo(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

export function canonicalPortfolioSourceKey(repo, issueNumber) {
  return `github:${String(repo).trim().toLowerCase()}#issue:${Number(issueNumber)}`;
}

export function normalizePortfolioReconcileRequest(input) {
  const body = object(input, 'request', 'INVALID_REQUEST');
  exactFields(body, REQUEST_FIELDS, 'request', 'INVALID_REQUEST');
  const project = requiredString(body.project, 'project', 128, 'INVALID_REQUEST');
  if (project !== PROJECT) fail('INVALID_REQUEST', `project must be exactly ${PROJECT}`, { project }, 422);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25) {
    fail('INVALID_REQUEST', 'items must contain between 1 and 25 candidates', { count: Array.isArray(body.items) ? body.items.length : null }, 422);
  }
  const idempotencyKey = body.idempotency_key == null ? null : requiredString(body.idempotency_key, 'idempotency_key', 256, 'INVALID_REQUEST');
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') fail('INVALID_REQUEST', 'dry_run must be boolean', { field: 'dry_run' }, 422);
  return { project, items: body.items, idempotency_key: idempotencyKey, dry_run: Boolean(body.dry_run) };
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

  const projection = object(item.projection, `items[${index}].projection`);
  exactFields(projection, PROJECTION_FIELDS, `items[${index}].projection`);
  const title = requiredString(projection.title, `items[${index}].projection.title`, 255);
  const state = requiredString(projection.state, `items[${index}].projection.state`, 64);
  if (!ACTIVE_STATES.has(state)) fail('INVALID_STATE', 'state must be Todo or Backlog; In Progress belongs to work.claim', { state }, 422);
  const lane = requiredString(projection.lane, `items[${index}].projection.lane`, 128);
  if (!ACTIVE_LANES.has(lane)) fail('INVALID_LANE', 'lane is outside the adopted execution surface', { lane }, 422);
  const priority = Number(projection.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) fail('INVALID_PROJECTION', 'priority must be a Linear integer priority from 0 through 4', { priority }, 422);
  const objective = requiredString(projection.objective, `items[${index}].projection.objective`, 4000);
  const gate = requiredString(projection.gate, `items[${index}].projection.gate`, 2000);
  if (!Array.isArray(projection.acceptance) || projection.acceptance.length < 1 || projection.acceptance.length > 20) {
    fail('INVALID_PROJECTION', 'acceptance must contain between 1 and 20 bounded strings', { field: `items[${index}].projection.acceptance` }, 422);
  }
  const acceptance = projection.acceptance.map((entry, acceptanceIndex) => requiredString(entry, `items[${index}].projection.acceptance[${acceptanceIndex}]`, 1000));
  const repository = projection.repository == null ? null : canonicalRepo(projection.repository, `items[${index}].projection.repository`);
  if (repository && !sameRepo(repository, repo)) fail('INVALID_PROJECTION', 'projection.repository must match source.repo', { source_repo: repo, projection_repository: repository }, 422);
  const exactCoordinate = optionalString(projection.exact_coordinate, `items[${index}].projection.exact_coordinate`, 1000);
  const ownerImpact = optionalString(projection.owner_impact, `items[${index}].projection.owner_impact`, 500);
  const promotionCondition = optionalString(projection.promotion_condition, `items[${index}].projection.promotion_condition`, 2000);
  if (state === 'Backlog' && !promotionCondition) fail('INVALID_PROJECTION', 'Backlog requires promotion_condition', { state }, 422);

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
    source: { kind, repo, issue_number: source.issue_number, expected_revision: expectedRevision },
    projection: {
      title, state, lane, priority, objective, gate, acceptance,
      repository, exact_coordinate: exactCoordinate, owner_impact: ownerImpact,
      dependencies, promotion_condition: promotionCondition,
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
    repository: null, authority: null, objective: null, gate: null, acceptance: [],
    exact_coordinate: null, owner_impact: null, promotion_condition: null,
  };
  const simple = new Map([
    ['repository', 'repository'], ['authority', 'authority'], ['github authority', 'authority'],
    ['exact coordinate', 'exact_coordinate'], ['owner impact', 'owner_impact'], ['promotion condition', 'promotion_condition'],
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
  managed.exact_coordinate = managed.exact_coordinate ? normalizeProse(managed.exact_coordinate) : null;
  managed.owner_impact = managed.owner_impact ? normalizeProse(managed.owner_impact) : null;
  managed.promotion_condition = managed.promotion_condition ? normalizeProse(managed.promotion_condition) : null;
  return { managed, unknown };
}

export function buildLinearWorkDescription({ repo, issueNumber, projection }) {
  const lines = [
    `Repository: ${repo}`,
    `Authority: GitHub #${issueNumber}`,
    '',
    'Objective:',
    projection.objective.trim(),
    '',
    'Gate:',
    projection.gate.trim(),
    '',
    'Acceptance:',
    ...projection.acceptance.map(item => `- ${item.trim()}`),
  ];
  if (projection.exact_coordinate) lines.push('', `Exact coordinate: ${projection.exact_coordinate.trim()}`);
  if (projection.owner_impact) lines.push('', `Owner impact: ${projection.owner_impact.trim()}`);
  if (projection.promotion_condition) lines.push('', `Promotion condition: ${projection.promotion_condition.trim()}`);
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
    objective: normalizeProse(projection.objective),
    gate: normalizeProse(projection.gate),
    acceptance: projection.acceptance.map(normalizeProse),
    exact_coordinate: projection.exact_coordinate ? normalizeProse(projection.exact_coordinate) : null,
    owner_impact: projection.owner_impact ? normalizeProse(projection.owner_impact) : null,
    promotion_condition: projection.promotion_condition ? normalizeProse(projection.promotion_condition) : null,
  };
  const changed = [];
  if (!sameRepo(managed.repository, expected.repository)) changed.push('repository');
  if (!sameText(managed.authority, expected.authority)) changed.push('authority');
  if (!sameText(managed.objective, expected.objective)) changed.push('objective');
  if (!sameText(managed.gate, expected.gate)) changed.push('gate');
  if (canonicalJson((managed.acceptance || []).map(normalizeProse)) !== canonicalJson(expected.acceptance)) changed.push('acceptance');
  if (!sameText(managed.exact_coordinate, expected.exact_coordinate)) changed.push('exact_coordinate');
  if (!sameText(managed.owner_impact, expected.owner_impact)) changed.push('owner_impact');
  if (!sameText(managed.promotion_condition, expected.promotion_condition)) changed.push('promotion_condition');
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

export function createPortfolioReconcileService({ github, linear, identityStore, receiptStore, leaseStore, now = () => new Date().toISOString() } = {}) {
  if (!github || !linear || !identityStore || !leaseStore) throw new TypeError('github, linear, identityStore, and leaseStore are required');

  async function resolveExisting(sourceKey, repo, issueNumber) {
    const mapped = await identityStore.get(sourceKey);
    let mappedIssue = null;
    if (mapped) mappedIssue = await linear.getIssue(mapped.linear_issue_id || mapped.linear_identifier);
    if (mapped && !mappedIssue) {
      return { conflict: [mapped.linear_identifier || mapped.linear_issue_id].filter(Boolean), existing: null };
    }
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

  async function reconcileItem(rawItem, index, project, dryRun) {
    let item;
    let sourceKey = null;
    let sourceRevision = null;
    try {
      item = normalizeItem(rawItem, index);
      sourceKey = canonicalPortfolioSourceKey(item.source.repo, item.source.issue_number);
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
    sourceKey = canonicalPortfolioSourceKey(authoritativeRepo, item.source.issue_number);
    if (repository.archived === true) return rejected(sourceKey, null, 'REPOSITORY_ARCHIVED', dryRun);

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

    const resolution = await resolveExisting(sourceKey, authoritativeRepo, item.source.issue_number);
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

    const sourceOpen = String(githubIssue.state || '').toLowerCase() === 'open';
    if (!sourceOpen) {
      if (!existing) return rejected(sourceKey, sourceRevision, 'SOURCE_NOT_OPEN', dryRun);
      return rejected(sourceKey, sourceRevision, 'SOURCE_CLOSED_WITH_ACTIVE_LINEAR_WORK', dryRun, {
        linear_issue: existing.identifier,
        linear_issue_id: existing.id,
      });
    }

    let dependencies;
    try { dependencies = await validateDependencies(item, existing?.identifier || null); }
    catch (error) { return stableItemError(error, sourceKey, sourceRevision, dryRun); }

    if (!existing) {
      if (!NEW_ADMISSION_LANES.has(item.projection.lane)) return rejected(sourceKey, sourceRevision, 'INVALID_LANE', dryRun, { lane: item.projection.lane });
      const changedFields = ['title', 'state', 'lane', 'priority', 'description'];
      if (item.projection.dependencies.length) changedFields.push('dependencies');
      if (dryRun) {
        return { source_key: sourceKey, source_revision: sourceRevision, result: 'would_create', reason: 'CREATED', linear_issue: null, linear_issue_id: null, changed_fields: changedFields };
      }
      const created = await linear.createIssue({
        title: item.projection.title,
        description: buildLinearWorkDescription({ repo: authoritativeRepo, issueNumber: item.source.issue_number, projection: item.projection }),
        priority: item.projection.priority,
        teamId: project.team_id,
        projectId: project.id,
        stateId: stateId(project, item.projection.state),
        labelIds: [laneId(project, item.projection.lane)],
      });
      for (const dependency of dependencies) await linear.ensureDependencyRelation(created.identifier, dependency.identifier);
      const finalIssue = item.projection.dependencies.length ? await linear.getIssue(created.identifier) : created;
      await identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, finalIssue, sourceRevision));
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
    if (existing.state?.name !== item.projection.state) changedFields.push('state');
    if (laneName(existing) !== item.projection.lane) changedFields.push('lane');
    if (Number(existing.priority ?? 0) !== item.projection.priority) changedFields.push('priority');
    const descriptionChanges = descriptionDiff(existing.description, authoritativeRepo, item.source.issue_number, item.projection);
    changedFields.push(...descriptionChanges);
    const currentDeps = currentDependencyRefs(existing);
    const missingDependencies = dependencies.filter(dependency => !currentDeps.has(String(dependency.identifier).toUpperCase()));
    if (missingDependencies.length) changedFields.push('dependencies');

    if (!changedFields.length) {
      if (!dryRun) await identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, existing, sourceRevision));
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
      try { updated = await linear.updateIssue({ identifier: fresh.identifier, expectedRevision: fresh.updatedAt, input }); }
      catch (error) {
        if (error?.code === 'LINEAR_REVISION_MISMATCH') return stableItemError(error, sourceKey, sourceRevision, false);
        throw error;
      }
    }
    for (const dependency of missingDependencies) await linear.ensureDependencyRelation(updated.identifier, dependency.identifier);
    if (missingDependencies.length) updated = await linear.getIssue(updated.identifier);
    await identityStore.put(sourceIdentityRow(sourceKey, authoritativeRepo, item.source.issue_number, updated, sourceRevision));
    return {
      source_key: sourceKey, source_revision: sourceRevision, result: 'updated', reason: 'PROJECTION_UPDATED',
      linear_issue: updated.identifier, linear_issue_id: updated.id, changed_fields: changedFields,
    };
  }

  async function reconcile(input) {
    let normalized;
    let requestHash = null;
    let receiptClaimed = false;
    try {
      normalized = normalizePortfolioReconcileRequest(input);
      const semantic = { project: normalized.project, items: normalized.items, dry_run: normalized.dry_run };
      requestHash = await sha256Text(canonicalJson(semantic));

      if (!normalized.dry_run && normalized.idempotency_key) {
        if (!receiptStore) fail('IDEMPOTENCY_UNAVAILABLE', 'idempotency_key requires the configured reconciliation receipt store', null, 500);
        const claim = await receiptStore.claim(normalized.idempotency_key, requestHash);
        if (claim.kind === 'conflict') return { ok: false, error: 'IDEMPOTENCY_CONFLICT', message: 'idempotency_key was already used for a different semantic reconciliation request' };
        if (claim.kind === 'in_progress') return { ok: false, error: 'IDEMPOTENCY_IN_PROGRESS', message: 'an identical reconciliation request is already in progress' };
        if (claim.kind === 'existing') return { ...claim.receipt, idempotent_replay: true };
        receiptClaimed = true;
      }

      const project = await linear.resolveProject(normalized.project);
      if (!project) fail('PROJECT_NOT_FOUND', `${normalized.project} was not found in Linear`, { project: normalized.project }, 404);

      const items = [];
      for (let index = 0; index < normalized.items.length; index += 1) {
        items.push(await reconcileItem(normalized.items[index], index, project, normalized.dry_run));
      }
      const receipt = {
        ok: true,
        project: normalized.project,
        summary: summarize(items),
        items,
        idempotent_replay: false,
      };
      if (!normalized.dry_run && normalized.idempotency_key) await receiptStore.succeed(normalized.idempotency_key, requestHash, receipt);
      return receipt;
    } catch (error) {
      if (receiptClaimed && normalized?.idempotency_key && receiptStore) {
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
    if (teams.length !== 1) throw linearError('LINEAR_CONFIGURATION_ERROR', 'Portfolio Orchestration must resolve to exactly one Linear team.', { teams: teams.map(team => team.name) }, 502);
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
    const project = cachedProject || await resolveProject(PROJECT);
    if (!project) return [];
    const data = await gql(`query PortfolioLegacyIdentity($project: ID!) {
      issues(first: 250, filter: { project: { id: { eq: $project } } }) {
        nodes { id identifier title description priority updatedAt archivedAt project { id name } state { id name type } labels { nodes { id name } } }
      }
    }`, { project: project.id });
    const expectedRepo = String(repo).toLowerCase();
    const expectedAuthority = `github #${issueNumber}`;
    return (data.issues?.nodes || []).filter(issue => {
      const parsed = parseDescription(issue.description).managed;
      return sameRepo(parsed.repository, expectedRepo) && String(parsed.authority || '').toLowerCase() === expectedAuthority;
    }).map(issue => ({ ...normalizeIssue(issue), dependencies: undefined }));
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

  return { resolveProject, findBySource, getIssue, createIssue, updateIssue, ensureDependencyRelation };
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
  return {
    async claim(key, hash) {
      const token = crypto.randomUUID();
      const inserted = await dbBinding.query(`INSERT INTO portfolio_reconcile_receipts (idempotency_key, request_sha256, state, attempt_token)
        VALUES ($1,$2,'processing',$3::uuid) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [key, hash, token]);
      if (inserted.rows?.[0]) return { kind: 'claimed' };
      let row = (await dbBinding.query('SELECT * FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 LIMIT 1', [key])).rows?.[0];
      if (!row) return { kind: 'in_progress' };
      if (row.request_sha256 !== hash) return { kind: 'conflict' };
      if (row.state === 'succeeded' && row.receipt) return { kind: 'existing', receipt: typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt };
      const takeover = await dbBinding.query(`UPDATE portfolio_reconcile_receipts SET attempt_token = $3::uuid, updated_at = now()
        WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing'
          AND updated_at < now() - interval '${STALE_RECEIPT_SECONDS} seconds' RETURNING *`, [key, hash, token]);
      if (takeover.rows?.[0]) return { kind: 'claimed' };
      row = (await dbBinding.query('SELECT * FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 LIMIT 1', [key])).rows?.[0];
      if (row?.state === 'succeeded' && row.receipt) return { kind: 'existing', receipt: typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt };
      return { kind: 'in_progress' };
    },
    async succeed(key, hash, receipt) {
      await dbBinding.query("UPDATE portfolio_reconcile_receipts SET state = 'succeeded', receipt = $3::jsonb, updated_at = now() WHERE idempotency_key = $1 AND request_sha256 = $2", [key, hash, canonicalJson(receipt)]);
    },
    async abandon(key, hash) {
      await dbBinding.query("DELETE FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 AND request_sha256 = $2 AND state = 'processing'", [key, hash]);
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
  return createPortfolioReconcileService({
    github: options.github || createGitHubAppIssueAuthority(),
    linear: options.linear || createLinearPortfolioAuthority(options.api || api),
    identityStore: options.identityStore || createPostgresPortfolioIdentityStore(options.db || db),
    receiptStore: options.receiptStore || createPostgresPortfolioReceiptStore(options.db || db),
    leaseStore: options.leaseStore || createPostgresPortfolioLeaseReader(options.db || db),
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
  if (['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS'].includes(code)) return 409;
  if (['GITHUB_PERMISSION_DENIED', 'LINEAR_PERMISSION_DENIED'].includes(code)) return 403;
  if (['PROJECT_NOT_FOUND', 'GITHUB_APP_INSTALLATION_NOT_FOUND'].includes(code)) return 404;
  if (['GITHUB_APP_SETUP_REQUIRED', 'LINEAR_SETUP_REQUIRED'].includes(code)) return 412;
  if (code.startsWith('INVALID_')) return 422;
  return 502;
}

export const portfolioReconcileConfig = Object.freeze({
  project: PROJECT,
  source_kind: SOURCE_KIND,
  max_items: 25,
  active_states: [...ACTIVE_STATES],
  active_lanes: [...ACTIVE_LANES],
  new_admission_lanes: [...NEW_ADMISSION_LANES],
  source_key_format: 'github:owner/repo#issue:N',
  result_values: ['created', 'reused', 'updated', 'ignored', 'rejected'],
  stable_reasons: [
    'CREATED', 'EXACT_MATCH', 'PROJECTION_UPDATED', 'SOURCE_REVISION_MISMATCH',
    'SOURCE_NOT_OPEN', 'SOURCE_CLOSED_WITH_ACTIVE_LINEAR_WORK', 'REPOSITORY_ARCHIVED',
    'SOURCE_NOT_FOUND', 'SOURCE_NOT_ISSUE', 'IDENTITY_CONFLICT', 'ACTIVE_WORK_LEASE',
    'LINEAR_REVISION_MISMATCH', 'INVALID_PROJECTION', 'INVALID_LANE', 'INVALID_STATE',
    'DEPENDENCY_NOT_FOUND', 'ALREADY_TERMINAL', 'UNSUPPORTED_SOURCE_KIND',
    'GITHUB_APP_INSTALLATION_NOT_FOUND', 'GITHUB_APP_PERMISSION_DENIED', 'GITHUB_PERMISSION_DENIED',
  ],
});

export const portfolioReconcileInternals = Object.freeze({ normalizeItem, parseDescription, descriptionDiff, laneName, isTerminal });