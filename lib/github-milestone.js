import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATE_FIELDS = Object.freeze(['title', 'description', 'state', 'due_on']);
const STATE_FIELD_SET = new Set(STATE_FIELDS);
const MAX_SCAN_PAGES = 10;

function fail(code, message, details = null, httpStatus = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.httpStatus = httpStatus;
  throw error;
}

function exactFields(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${name} contains unsupported fields`, { field: name, unknown }, 422);
}

function normalizeTitle(value) {
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'title must be a string', { field: 'title' }, 422);
  const title = value.trim();
  if (!title || title.length > 256) fail('INVALID_REQUEST', 'title must contain 1..256 characters', { field: 'title' }, 422);
  return title;
}

function normalizeDescription(value) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'description must be a string or null', { field: 'description' }, 422);
  if (value.length > 10000) fail('INVALID_REQUEST', 'description must be at most 10000 characters', { field: 'description' }, 422);
  return value;
}

function normalizeLifecycleState(value) {
  if (value !== 'open' && value !== 'closed') fail('INVALID_REQUEST', 'state must be open or closed', { field: 'state' }, 422);
  return value;
}

function normalizeDueOn(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', 'due_on must be an RFC3339 timestamp or null', { field: 'due_on' }, 422);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('INVALID_REQUEST', 'due_on must be an RFC3339 timestamp or null', { field: 'due_on' }, 422);
  return new Date(timestamp).toISOString();
}

function normalizeState(value, name, { requireTitle = false, requireOne = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', `${name} must be an object`, { field: name }, 422);
  exactFields(value, STATE_FIELD_SET, name);
  const state = {};
  for (const field of STATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (field === 'title') state.title = normalizeTitle(value.title);
    else if (field === 'description') state.description = normalizeDescription(value.description);
    else if (field === 'state') state.state = normalizeLifecycleState(value.state);
    else if (field === 'due_on') state.due_on = normalizeDueOn(value.due_on);
  }
  if (requireTitle && !state.title) fail('INVALID_REQUEST', `${name}.title is required`, { field: `${name}.title` }, 422);
  if (requireOne && Object.keys(state).length === 0) fail('INVALID_REQUEST', `${name} must declare at least one field`, { field: name }, 422);
  return state;
}

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be in owner/repo form', { repo }, 422);
  return repo;
}

export function normalizeGithubMilestoneRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'request must be an object', null, 422);
  exactFields(input, new Set(['repo', 'desired_state', 'expected_state']), 'request');
  const desired = normalizeState(input.desired_state, 'desired_state', { requireTitle: true });
  const normalized = { repo: validateRepo(input.repo), desired_state: desired };
  if (Object.prototype.hasOwnProperty.call(input, 'expected_state')) {
    const expected = normalizeState(input.expected_state, 'expected_state', { requireOne: true });
    if (expected.title && expected.title !== desired.title) {
      fail('INVALID_REQUEST', 'expected_state.title must match desired_state.title; milestone rename is not supported', { field: 'expected_state.title' }, 422);
    }
    normalized.expected_state = expected;
  }
  return normalized;
}

function basePath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/milestones`;
}

function normalizeObservedMilestone(value) {
  return {
    number: Number(value?.number || 0),
    title: String(value?.title || ''),
    description: value?.description ?? null,
    state: value?.state === 'closed' ? 'closed' : 'open',
    due_on: value?.due_on ? new Date(value.due_on).toISOString() : null,
    html_url: value?.html_url ? String(value.html_url) : null,
  };
}

function stateOf(milestone) {
  return Object.fromEntries(STATE_FIELDS.map((field) => [field, milestone[field]]));
}

function sameValue(left, right) { return left === right; }
function subsetMatches(observed, expected) { return Object.keys(expected).every((field) => sameValue(observed[field], expected[field])); }
function mismatchedFields(observed, expected) { return Object.keys(expected).filter((field) => !sameValue(observed[field], expected[field])).sort(); }
function pickState(state, fields) { return Object.fromEntries(fields.map((field) => [field, state[field]])); }

function transportFailure(response, phase, path, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated });
  if (status === 401 || status === 403) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, upstream_status: status, required_permissions: { issues: 'write', metadata: 'read' }, ...evidence };
  }
  if (status === 404) return { ok: false, error: 'GITHUB_NOT_FOUND', message, upstream_status: status, ...evidence };
  return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message, ...(status ? { upstream_status: status } : {}), ...evidence };
}

async function safeRead(apiClient, path, options, phase) {
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { method: 'GET', path }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || 'GitHub read failed.'), phase, github_path: path, attempts: Number(error?.githubTransportAttempts || 1), may_have_mutated: false };
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, path, false);
    failure.github_path = path;
    failure.attempts = retried.attempts;
    return failure;
  }
  return { ok: true, body: response.body, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
}

async function findByTitle(apiClient, normalized, options = {}, phase = 'inspect') {
  const root = basePath(normalized.repo);
  const matches = [];
  const evidence = [];
  for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
    const path = `${root}?state=all&per_page=100&page=${page}`;
    const read = await safeRead(apiClient, path, options, `${phase}.list`);
    if (!read.ok) return read;
    const items = Array.isArray(read.body) ? read.body : [];
    evidence.push(read.evidence);
    for (const item of items) {
      if (String(item?.title || '') === normalized.desired_state.title) matches.push(normalizeObservedMilestone(item));
    }
    if (matches.length > 1) {
      return { ok: false, error: 'GITHUB_MILESTONE_TITLE_AMBIGUOUS', message: 'More than one GitHub milestone has the requested exact title.', repo: normalized.repo, title: normalized.desired_state.title, milestone_numbers: matches.map((item) => item.number).sort((a, b) => a - b), phase, may_have_mutated: false };
    }
    if (items.length < 100) return { ok: true, milestone: matches[0] || null, evidence };
  }
  if (matches.length === 1) return { ok: true, milestone: matches[0], evidence };
  return { ok: false, error: 'GITHUB_MILESTONE_SCAN_INCOMPLETE', message: 'Milestone lookup reached the bounded pagination limit before proving the title absent.', repo: normalized.repo, title: normalized.desired_state.title, phase, may_have_mutated: false };
}

async function readByNumber(apiClient, normalized, number, options = {}, phase = 'verify') {
  const path = `${basePath(normalized.repo)}/${number}`;
  const read = await safeRead(apiClient, path, options, phase);
  if (!read.ok) return read;
  return { ok: true, milestone: normalizeObservedMilestone(read.body), evidence: read.evidence };
}

function success(normalized, outcome, before, after, changedFields, evidence = {}) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    title: normalized.desired_state.title,
    milestone_number: after.number,
    milestone_url: after.html_url,
    desired_state: normalized.desired_state,
    before: before ? stateOf(before) : null,
    after: stateOf(after),
    changed: changedFields.length > 0,
    changed_fields: changedFields,
    verified: true,
    evidence,
  };
}

function indeterminate(normalized, before, changedFields, details = {}) {
  return { ok: false, error: 'GITHUB_MILESTONE_INDETERMINATE', message: 'Milestone mutation may have occurred, but authoritative desired state is not verified.', repo: normalized.repo, title: normalized.desired_state.title, desired_state: normalized.desired_state, before: before ? stateOf(before) : null, changed_fields: changedFields, phase: 'verify', may_have_mutated: true, ...details };
}

async function reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, evidence = {}) {
  const observed = await findByTitle(apiClient, normalized, options, 'verify');
  if (observed.ok && observed.milestone && subsetMatches(stateOf(observed.milestone), normalized.desired_state)) {
    return success(normalized, 'reconciled_after_indeterminate_write', before, observed.milestone, changedFields, { ...evidence, verify: observed.evidence });
  }
  if (observed.ok) return indeterminate(normalized, before, changedFields, { observed_state: observed.milestone ? stateOf(observed.milestone) : null });
  return indeterminate(normalized, before, changedFields, { verification_error: observed.error });
}

export async function ensureGithubMilestone(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubMilestoneRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}), ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) }; }

  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };

  const observed = await findByTitle(apiClient, normalized, options, 'inspect');
  if (!observed.ok) return observed;
  const before = observed.milestone;
  const beforeState = before ? stateOf(before) : null;

  if (before && subsetMatches(beforeState, normalized.desired_state)) {
    return success(normalized, 'already_compliant', before, before, [], { inspect: observed.evidence });
  }

  if (normalized.expected_state) {
    if (!before || !subsetMatches(beforeState, normalized.expected_state)) {
      const fields = Object.keys(normalized.expected_state).sort();
      return { ok: false, error: 'GITHUB_MILESTONE_STATE_CHANGED', message: 'Observed milestone does not match expected_state.', repo: normalized.repo, title: normalized.desired_state.title, expected_state: normalized.expected_state, observed_state: before ? pickState(beforeState, fields) : null, mismatched_fields: before ? mismatchedFields(beforeState, normalized.expected_state) : fields, desired_state: normalized.desired_state, phase: 'precondition', may_have_mutated: false };
    }
  }

  if (!before) {
    const changedFields = Object.keys(normalized.desired_state).sort();
    const path = basePath(normalized.repo);
    let response;
    try { response = await apiClient.call('github', { method: 'POST', path, body: normalized.desired_state }); }
    catch { return reconcileAfterPossibleWrite(apiClient, normalized, null, changedFields, options); }
    if (!response || response.status < 200 || response.status >= 300) {
      const status = Number(response?.status || 0);
      if (status === 0 || status >= 500) return reconcileAfterPossibleWrite(apiClient, normalized, null, changedFields, options);
      return transportFailure(response, 'write.create', path, false);
    }
    const created = normalizeObservedMilestone(response.body);
    if (!created.number) return reconcileAfterPossibleWrite(apiClient, normalized, null, changedFields, options, { write: githubTransportEvidence(response, { phase: 'write.create', path, attempts: 1, mayHaveMutated: true }) });
    const verified = await readByNumber(apiClient, normalized, created.number, options, 'verify');
    if (verified.ok && subsetMatches(stateOf(verified.milestone), normalized.desired_state)) {
      return success(normalized, 'created', null, verified.milestone, changedFields, { inspect: observed.evidence, write: githubTransportEvidence(response, { phase: 'write.create', path, attempts: 1, mayHaveMutated: true }), verify: verified.evidence });
    }
    if (verified.ok) return indeterminate(normalized, null, changedFields, { observed_state: stateOf(verified.milestone) });
    return indeterminate(normalized, null, changedFields, { verification_error: verified.error });
  }

  const changedFields = mismatchedFields(beforeState, normalized.desired_state).filter((field) => field !== 'title');
  const patchBody = Object.fromEntries(changedFields.map((field) => [field, normalized.desired_state[field]]));
  const path = `${basePath(normalized.repo)}/${before.number}`;
  let response;
  try { response = await apiClient.call('github', { method: 'PATCH', path, body: patchBody }); }
  catch { return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options); }
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    if (status === 0 || status >= 500) return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options);
    return transportFailure(response, 'write.update', path, false);
  }
  const verified = await readByNumber(apiClient, normalized, before.number, options, 'verify');
  if (verified.ok && subsetMatches(stateOf(verified.milestone), normalized.desired_state)) {
    return success(normalized, 'updated', before, verified.milestone, changedFields, { inspect: observed.evidence, write: githubTransportEvidence(response, { phase: 'write.update', path, attempts: 1, mayHaveMutated: true }), verify: verified.evidence });
  }
  if (verified.ok) return indeterminate(normalized, before, changedFields, { observed_state: stateOf(verified.milestone) });
  return indeterminate(normalized, before, changedFields, { verification_error: verified.error });
}

function authFailure(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  if (/config\/get 412|declared as required but not set/i.test(message)) return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key before using this command.' };
  if (status === 401 || status === 403 || status === 422) return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, ...(status ? { upstream_status: status } : {}) };
  if (status === 404) return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
  return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(status ? { upstream_status: status } : {}) };
}

export async function ensureGithubMilestoneWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubMilestoneRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) }; }
  try {
    return await withGitHubAppApiClient(
      normalized.repo,
      (apiClient) => ensureGithubMilestone(normalized, { ...options, apiClient }),
      { permissionProfile: 'milestone' },
    );
  } catch (error) { return authFailure(error); }
}
