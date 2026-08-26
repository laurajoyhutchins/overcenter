function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_REPOSITORY_FACTS_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function exactRevision(value, field = 'revision') {
  const revision = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', `${field} must be a full Git commit SHA`, { field, revision });
  }
  return revision;
}

function integer(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', `${field} must be a positive integer`, { field, value });
  }
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') fail('PROJECT_REPOSITORY_FACTS_INVALID', `${field} must be boolean`, { field, value });
  return value;
}

function normalizeCheck(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'check must be an object', { index });
  }
  const supported = ['conclusion', 'name', 'status'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, keyIndex) => key !== supported[keyIndex])) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'check contains unsupported fields', { index, fields:keys });
  }
  const status = text(input.status, `pull_requests[].checks[${index}].status`);
  if (!['queued', 'in_progress', 'completed'].includes(status)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'check status is unsupported', { index, status });
  }
  const conclusion = input.conclusion === null ? null : text(input.conclusion, `pull_requests[].checks[${index}].conclusion`);
  if (status !== 'completed' && conclusion !== null) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'non-completed check cannot have a conclusion', { index, status, conclusion });
  }
  return Object.freeze({ name:text(input.name, `pull_requests[].checks[${index}].name`), status, conclusion });
}

function normalizePullRequest(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull request fact must be an object', { index });
  }
  const supported = ['base_sha', 'checks', 'draft', 'head_sha', 'mergeable', 'number', 'state'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, keyIndex) => key !== supported[keyIndex])) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull request fact contains unsupported fields', { index, fields:keys });
  }
  const state = text(input.state, `pull_requests[${index}].state`);
  if (!['open', 'closed'].includes(state)) fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull request state is unsupported', { index, state });
  const mergeable = input.mergeable === null ? null : bool(input.mergeable, `pull_requests[${index}].mergeable`);
  const checks = Array.isArray(input.checks) ? input.checks.map((check, checkIndex) => normalizeCheck(check, checkIndex)) : null;
  if (!checks) fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull request checks must be an array', { index });
  checks.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    number:integer(input.number, `pull_requests[${index}].number`),
    state,
    draft:bool(input.draft, `pull_requests[${index}].draft`),
    mergeable,
    head_sha:exactRevision(input.head_sha, `pull_requests[${index}].head_sha`),
    base_sha:exactRevision(input.base_sha, `pull_requests[${index}].base_sha`),
    checks:Object.freeze(checks),
  });
}

export const PROJECT_REPOSITORY_FACTS_SCHEMA = 'project-repository-facts-v1';

export function normalizeProjectRepositoryFacts(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'project repository facts must be an object');
  }
  const supported = ['default_branch', 'pull_requests', 'repository', 'revision', 'schema'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, index) => key !== supported[index])) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'project repository facts contain unsupported fields', { fields:keys });
  }
  if (input.schema !== PROJECT_REPOSITORY_FACTS_SCHEMA) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'project repository facts schema is unsupported', { schema:input.schema ?? null });
  }
  const repository = text(input.repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'repository must be an explicit owner/name coordinate', { repository });
  }
  if (!Array.isArray(input.pull_requests)) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull_requests must be an array');
  }
  const pullRequests = input.pull_requests.map(normalizePullRequest).sort((left, right) => left.number - right.number);
  if (new Set(pullRequests.map((entry) => entry.number)).size !== pullRequests.length) {
    fail('PROJECT_REPOSITORY_FACTS_INVALID', 'pull request numbers must be unique');
  }
  return Object.freeze({
    schema:PROJECT_REPOSITORY_FACTS_SCHEMA,
    repository,
    revision:exactRevision(input.revision),
    default_branch:text(input.default_branch, 'default_branch'),
    pull_requests:Object.freeze(pullRequests),
  });
}
