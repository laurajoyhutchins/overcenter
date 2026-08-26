import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATE_FIELDS = Object.freeze([
  'description',
  'homepage',
  'topics',
  'has_issues',
  'has_projects',
  'has_wiki',
  'has_discussions',
]);
const STATE_FIELD_SET = new Set(STATE_FIELDS);
const BOOLEAN_FIELDS = new Set(['has_issues', 'has_projects', 'has_wiki', 'has_discussions']);

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

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be in owner/repo form', { repo }, 422);
  return repo;
}

function normalizeDescription(value) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'description must be a string or null', { field: 'description' }, 422);
  if (value.length > 350) fail('INVALID_REQUEST', 'description must be at most 350 characters', { field: 'description' }, 422);
  return value;
}

function normalizeHomepage(value) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('INVALID_REQUEST', 'homepage must be a string or null', { field: 'homepage' }, 422);
  const homepage = value.trim();
  if (homepage.length > 2048) fail('INVALID_REQUEST', 'homepage must be at most 2048 characters', { field: 'homepage' }, 422);
  return homepage || null;
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) fail('INVALID_REQUEST', 'topics must be an array', { field: 'topics' }, 422);
  if (value.length > 20) fail('INVALID_REQUEST', 'topics may contain at most 20 names', { field: 'topics' }, 422);
  const topics = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') fail('INVALID_REQUEST', 'topic names must be strings', { field: 'topics', index }, 422);
    const topic = value[index].trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)) {
      fail('INVALID_REQUEST', 'topic names must contain only lowercase letters, numbers, and hyphens and be at most 50 characters', { field: 'topics', index }, 422);
    }
    if (!seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
    }
  }
  return topics.sort();
}

function normalizeState(value, name, { requireOne = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${name} must be an object`, { field: name }, 422);
  }
  exactFields(value, STATE_FIELD_SET, name);
  const state = {};
  for (const field of STATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (field === 'description') state[field] = normalizeDescription(value[field]);
    else if (field === 'homepage') state[field] = normalizeHomepage(value[field]);
    else if (field === 'topics') state[field] = normalizeTopics(value[field]);
    else if (BOOLEAN_FIELDS.has(field)) {
      if (typeof value[field] !== 'boolean') fail('INVALID_REQUEST', `${field} must be a boolean`, { field }, 422);
      state[field] = value[field];
    }
  }
  if (requireOne && Object.keys(state).length === 0) {
    fail('INVALID_REQUEST', `${name} must declare at least one metadata field`, { field: name }, 422);
  }
  return state;
}

export function normalizeGithubRepositoryMetadataRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'request must be an object', null, 422);
  exactFields(input, new Set(['repo', 'desired_state', 'expected_state']), 'request');
  const normalized = {
    repo: validateRepo(input.repo),
    desired_state: normalizeState(input.desired_state, 'desired_state', { requireOne: true }),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'expected_state')) {
    normalized.expected_state = normalizeState(input.expected_state, 'expected_state', { requireOne: true });
  }
  return normalized;
}

function repoPath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function subsetMatches(observed, expected) {
  return Object.keys(expected).every((field) => sameValue(observed[field], expected[field]));
}

function mismatchedFields(observed, expected) {
  return Object.keys(expected).filter((field) => !sameValue(observed[field], expected[field])).sort();
}

function pickState(state, fields) {
  return Object.fromEntries(fields.map((field) => [field, state[field]]));
}

function transportFailure(response, phase, path, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated });
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message,
      upstream_status: status,
      required_permissions: { administration: 'write', metadata: 'read' },
      ...evidence,
    };
  }
  if (status === 404) return { ok: false, error: 'GITHUB_NOT_FOUND', message, upstream_status: status, ...evidence };
  return {
    ok: false,
    error: 'GITHUB_UPSTREAM_ERROR',
    message,
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

async function safeRead(apiClient, path, options, phase) {
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { method: 'GET', path }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub read failed.'),
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, path, false);
    failure.github_path = path;
    failure.attempts = retried.attempts;
    return failure;
  }
  return {
    ok: true,
    body: response.body || {},
    evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
  };
}

async function readRepositoryState(apiClient, normalized, options = {}, phase = 'inspect') {
  const path = repoPath(normalized.repo);
  const repository = await safeRead(apiClient, path, options, `${phase}.repository`);
  if (!repository.ok) return repository;

  const needsTopics = Object.prototype.hasOwnProperty.call(normalized.desired_state, 'topics')
    || Object.prototype.hasOwnProperty.call(normalized.expected_state || {}, 'topics');
  let topics = Array.isArray(repository.body?.topics) ? normalizeTopics(repository.body.topics) : [];
  let topicsEvidence = null;
  if (needsTopics) {
    const topicRead = await safeRead(apiClient, `${path}/topics`, options, `${phase}.topics`);
    if (!topicRead.ok) return topicRead;
    topics = normalizeTopics(Array.isArray(topicRead.body?.names) ? topicRead.body.names : []);
    topicsEvidence = topicRead.evidence;
  }

  return {
    ok: true,
    state: {
      description: repository.body?.description ?? null,
      homepage: repository.body?.homepage || null,
      topics,
      has_issues: Boolean(repository.body?.has_issues),
      has_projects: Boolean(repository.body?.has_projects),
      has_wiki: Boolean(repository.body?.has_wiki),
      has_discussions: Boolean(repository.body?.has_discussions),
    },
    evidence: { repository: repository.evidence, ...(topicsEvidence ? { topics: topicsEvidence } : {}) },
  };
}

function success(normalized, outcome, before, after, changedFields, evidence = {}) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    desired_state: normalized.desired_state,
    before,
    after,
    changed: changedFields.length > 0,
    changed_fields: changedFields,
    verified: true,
    evidence,
  };
}

function indeterminate(normalized, before, changedFields, details = {}) {
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_METADATA_INDETERMINATE',
    message: 'Repository metadata mutation may have occurred, but authoritative desired state is not verified.',
    repo: normalized.repo,
    desired_state: normalized.desired_state,
    before,
    changed_fields: changedFields,
    phase: 'verify',
    may_have_mutated: true,
    ...details,
  };
}

async function reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, evidence = {}) {
  const verified = await readRepositoryState(apiClient, normalized, options, 'verify');
  if (verified.ok && subsetMatches(verified.state, normalized.desired_state)) {
    return success(normalized, 'reconciled_after_indeterminate_write', before, verified.state, changedFields, {
      ...evidence,
      verify: verified.evidence,
    });
  }
  if (verified.ok) return indeterminate(normalized, before, changedFields, { observed_state: verified.state });
  return indeterminate(normalized, before, changedFields, { verification_error: verified.error });
}

export async function ensureGithubRepositoryMetadata(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRepositoryMetadataRequest(input);
  } catch (error) {
    return {
      ok: false,
      error: error.code || 'INVALID_REQUEST',
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    };
  }

  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };

  const observed = await readRepositoryState(apiClient, normalized, options, 'inspect');
  if (!observed.ok) return observed;
  const before = observed.state;

  if (subsetMatches(before, normalized.desired_state)) {
    return success(normalized, 'already_compliant', before, before, [], { inspect: observed.evidence });
  }

  if (normalized.expected_state && !subsetMatches(before, normalized.expected_state)) {
    const fields = Object.keys(normalized.expected_state).sort();
    return {
      ok: false,
      error: 'GITHUB_REPOSITORY_METADATA_STATE_CHANGED',
      message: 'Observed repository metadata does not match expected_state.',
      repo: normalized.repo,
      expected_state: normalized.expected_state,
      observed_state: pickState(before, fields),
      mismatched_fields: mismatchedFields(before, normalized.expected_state),
      desired_state: normalized.desired_state,
      phase: 'precondition',
      may_have_mutated: false,
    };
  }

  const changedFields = mismatchedFields(before, normalized.desired_state);
  const patchBody = {};
  for (const field of changedFields) {
    if (field !== 'topics') patchBody[field] = normalized.desired_state[field];
  }
  const path = repoPath(normalized.repo);
  let successfulWrites = 0;
  const writeEvidence = {};

  async function performWrite(kind, request) {
    let response;
    try {
      response = await apiClient.call('github', request);
    } catch {
      return { ambiguous: true };
    }
    if (!response || response.status < 200 || response.status >= 300) {
      const status = Number(response?.status || 0);
      if (status === 0 || status >= 500) return { ambiguous: true };
      return { failure: transportFailure(response, `write.${kind}`, request.path, successfulWrites > 0) };
    }
    successfulWrites += 1;
    writeEvidence[kind] = githubTransportEvidence(response, {
      phase: `write.${kind}`,
      path: request.path,
      attempts: 1,
      mayHaveMutated: true,
    });
    return { ok: true };
  }

  if (Object.keys(patchBody).length > 0) {
    const write = await performWrite('repository', { method: 'PATCH', path, body: patchBody });
    if (write.ambiguous) return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, { write: writeEvidence });
    if (write.failure) {
      if (successfulWrites > 0 || write.failure.may_have_mutated === true) {
        return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, { write: writeEvidence });
      }
      return write.failure;
    }
  }

  if (changedFields.includes('topics')) {
    const write = await performWrite('topics', { method: 'PUT', path: `${path}/topics`, body: { names: normalized.desired_state.topics } });
    if (write.ambiguous) return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, { write: writeEvidence });
    if (write.failure) {
      if (successfulWrites > 0 || write.failure.may_have_mutated === true) {
        return reconcileAfterPossibleWrite(apiClient, normalized, before, changedFields, options, { write: writeEvidence });
      }
      return write.failure;
    }
  }

  const verified = await readRepositoryState(apiClient, normalized, options, 'verify');
  if (verified.ok && subsetMatches(verified.state, normalized.desired_state)) {
    return success(normalized, 'updated', before, verified.state, changedFields, { inspect: observed.evidence, write: writeEvidence, verify: verified.evidence });
  }
  if (verified.ok) return indeterminate(normalized, before, changedFields, { observed_state: verified.state });
  return indeterminate(normalized, before, changedFields, { verification_error: verified.error });
}

function authFailure(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key before using this command.' };
  }
  if (status === 401 || status === 403 || status === 422) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, ...(status ? { upstream_status: status } : {}) };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
  }
  return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(status ? { upstream_status: status } : {}) };
}

export async function ensureGithubRepositoryMetadataWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRepositoryMetadataRequest(input);
  } catch (error) {
    return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) };
  }
  try {
    return await withGitHubAppApiClient(
      normalized.repo,
      (apiClient) => ensureGithubRepositoryMetadata(normalized, { ...options, apiClient }),
      { permissionProfile: 'repository_metadata' },
    );
  } catch (error) {
    return authFailure(error);
  }
}