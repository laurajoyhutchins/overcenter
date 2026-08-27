import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(error, message, details = {}) {
  return { ok: false, error, message, ...details };
}

function exactFields(value, allowed, name = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${name} must be an object`), { code: 'INVALID_REQUEST' });
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw Object.assign(new Error(`${name} contains unsupported fields`), { code: 'INVALID_REQUEST', details: { field: name, unknown } });
}

function normalizeRepo(value, field) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) throw Object.assign(new Error(`${field} must be owner/repo`), { code: 'INVALID_REPOSITORY', details: { field } });
  return repo;
}

function normalizeTemplateState(value, name) {
  exactFields(value, new Set(['is_template']), name);
  if (typeof value.is_template !== 'boolean') throw Object.assign(new Error(`${name}.is_template must be boolean`), { code: 'INVALID_REQUEST', details: { field: `${name}.is_template` } });
  return { is_template: value.is_template };
}

export function normalizeGithubRepositoryTemplateEnsureRequest(input) {
  exactFields(input, new Set(['repo', 'desired_state', 'expected_state']));
  const normalized = {
    repo: normalizeRepo(input.repo, 'repo'),
    desired_state: normalizeTemplateState(input.desired_state, 'desired_state'),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'expected_state')) normalized.expected_state = normalizeTemplateState(input.expected_state, 'expected_state');
  return normalized;
}

export function normalizeGithubRepositoryFromTemplateCreateRequest(input) {
  exactFields(input, new Set(['template_repo', 'destination_repo', 'description', 'private', 'idempotency_key']));
  const templateRepo = normalizeRepo(input.template_repo, 'template_repo');
  const destinationRepo = normalizeRepo(input.destination_repo, 'destination_repo');
  if (templateRepo.toLowerCase() === destinationRepo.toLowerCase()) {
    throw Object.assign(new Error('destination_repo must differ from template_repo'), { code: 'INVALID_REQUEST', details: { field: 'destination_repo' } });
  }
  if (typeof input.private !== 'boolean') throw Object.assign(new Error('private must be an explicit boolean'), { code: 'INVALID_REQUEST', details: { field: 'private' } });
  let description = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string' || input.description.length > 350) throw Object.assign(new Error('description must be a string of at most 350 characters'), { code: 'INVALID_REQUEST', details: { field: 'description' } });
    description = input.description;
  }
  let idempotencyKey = null;
  if (input.idempotency_key !== undefined && input.idempotency_key !== null) {
    idempotencyKey = String(input.idempotency_key).trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error('idempotency_key must be 1 to 200 characters'), { code: 'INVALID_REQUEST', details: { field: 'idempotency_key' } });
  }
  return { template_repo: templateRepo, destination_repo: destinationRepo, description, private: input.private, idempotency_key: idempotencyKey };
}

function repoPath(repo) {
  return `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

function transportFailure(response, phase, path, { mayHaveMutated = false, requiredPermissions = null } = {}) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated });
  if (status === 401 || status === 403) return fail('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status: status, ...(requiredPermissions ? { required_permissions: requiredPermissions } : {}), ...evidence });
  if (status === 404) return fail('GITHUB_NOT_FOUND', message, { upstream_status: status, ...evidence });
  if (status === 422) return fail('GITHUB_REPOSITORY_TEMPLATE_CREATE_REJECTED', message, { upstream_status: status, ...evidence });
  return fail('GITHUB_UPSTREAM_ERROR', message, { ...(status ? { upstream_status: status } : {}), ...evidence });
}

async function safeRead(apiClient, path, options, phase, { allowMissing = false, requiredPermissions = null } = {}) {
  try {
    const retried = await boundedSafeRead(
      () => apiClient.call('github', { method: 'GET', path }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
    const response = retried.response;
    const status = Number(response?.status || 0);
    if (allowMissing && status === 404) return { ok: true, missing: true, attempts: retried.attempts };
    if (!response || status < 200 || status >= 300) {
      const failure = transportFailure(response, phase, path, { mayHaveMutated: false, requiredPermissions });
      failure.attempts = retried.attempts;
      return failure;
    }
    return {
      ok: true,
      missing: false,
      body: response.body || {},
      evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
    };
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR', String(error?.message || 'GitHub read failed.'), {
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    });
  }
}

function templateState(body) {
  return { is_template: body?.is_template === true };
}

function templateEnsureSuccess(normalized, outcome, before, after, evidence) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    desired_state: normalized.desired_state,
    before,
    after,
    changed: before.is_template !== after.is_template,
    changed_fields: before.is_template === after.is_template ? [] : ['is_template'],
    verified: true,
    evidence,
  };
}

async function reconcileTemplateEnsure(apiClient, normalized, before, options, evidence = {}) {
  const observed = await safeRead(apiClient, repoPath(normalized.repo), options, 'verify', {
    requiredPermissions: { administration: 'write', metadata: 'read' },
  });
  if (observed.ok && templateState(observed.body).is_template === normalized.desired_state.is_template) {
    return templateEnsureSuccess(normalized, 'reconciled_after_indeterminate_write', before, templateState(observed.body), { ...evidence, verify: observed.evidence });
  }
  return fail('GITHUB_REPOSITORY_TEMPLATE_INDETERMINATE', 'Repository template mutation may have occurred, but authoritative desired state is not verified.', {
    repo: normalized.repo,
    desired_state: normalized.desired_state,
    before,
    phase: 'verify',
    may_have_mutated: true,
    ...(observed.ok ? { observed_state: templateState(observed.body) } : { verification_error: observed.error }),
  });
}

export async function ensureGithubRepositoryTemplate(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubRepositoryTemplateEnsureRequest(input); }
  catch (error) { return fail(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {}); }
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.call !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub REST transport is required.');

  const observed = await safeRead(apiClient, repoPath(normalized.repo), options, 'inspect', {
    requiredPermissions: { administration: 'write', metadata: 'read' },
  });
  if (!observed.ok) return observed;
  const before = templateState(observed.body);
  if (before.is_template === normalized.desired_state.is_template) {
    return templateEnsureSuccess(normalized, 'already_compliant', before, before, { inspect: observed.evidence });
  }
  if (normalized.expected_state && before.is_template !== normalized.expected_state.is_template) {
    return fail('GITHUB_REPOSITORY_TEMPLATE_STATE_CHANGED', 'Observed repository template state does not match expected_state.', {
      repo: normalized.repo,
      expected_state: normalized.expected_state,
      observed_state: before,
      desired_state: normalized.desired_state,
      phase: 'precondition',
      may_have_mutated: false,
    });
  }

  const path = repoPath(normalized.repo);
  let response;
  try {
    response = await apiClient.call('github', { method: 'PATCH', path, body: { is_template: normalized.desired_state.is_template } });
  } catch (error) {
    return reconcileTemplateEnsure(apiClient, normalized, before, options, {
      write: { phase: 'write', transport_error: String(error?.message || error), may_have_mutated: true },
    });
  }
  const status = Number(response?.status || 0);
  if (!response || status < 200 || status >= 300) {
    if (status === 0 || status >= 500) {
      return reconcileTemplateEnsure(apiClient, normalized, before, options, {
        write: transportFailure(response, 'write', path, { mayHaveMutated: true, requiredPermissions: { administration: 'write', metadata: 'read' } }),
      });
    }
    return transportFailure(response, 'write', path, { mayHaveMutated: false, requiredPermissions: { administration: 'write', metadata: 'read' } });
  }

  const verified = await safeRead(apiClient, path, options, 'verify', {
    requiredPermissions: { administration: 'write', metadata: 'read' },
  });
  if (verified.ok && templateState(verified.body).is_template === normalized.desired_state.is_template) {
    return templateEnsureSuccess(normalized, 'updated', before, templateState(verified.body), {
      inspect: observed.evidence,
      write: githubTransportEvidence(response, { phase: 'write', path, attempts: 1, mayHaveMutated: true }),
      verify: verified.evidence,
    });
  }
  return fail('GITHUB_REPOSITORY_TEMPLATE_INDETERMINATE', 'GitHub acknowledged the template-state mutation, but authoritative verification did not prove the desired state.', {
    repo: normalized.repo,
    desired_state: normalized.desired_state,
    before,
    phase: 'verify',
    may_have_mutated: true,
    ...(verified.ok ? { observed_state: templateState(verified.body) } : { verification_error: verified.error }),
  });
}

function destinationSnapshot(body) {
  const templateFullName = body?.template_repository?.full_name ? String(body.template_repository.full_name) : null;
  return {
    repository_id: Number(body?.id || 0) || null,
    full_name: body?.full_name ? String(body.full_name) : null,
    private: body?.private === true,
    description: body?.description == null || body.description === '' ? null : String(body.description),
    template_repository: templateFullName,
    html_url: body?.html_url ? String(body.html_url) : null,
  };
}

function destinationMatches(snapshot, normalized) {
  return snapshot.full_name?.toLowerCase() === normalized.destination_repo.toLowerCase()
    && snapshot.template_repository?.toLowerCase() === normalized.template_repo.toLowerCase()
    && snapshot.private === normalized.private
    && (snapshot.description ?? null) === (normalized.description ?? null);
}

function createSuccess(normalized, outcome, destination, extra = {}) {
  return {
    ok: true,
    outcome,
    template_repo: normalized.template_repo,
    destination_repo: normalized.destination_repo,
    repository_id: destination.repository_id,
    private: destination.private,
    description: destination.description,
    template_repository: destination.template_repository,
    html_url: destination.html_url,
    include_all_branches: false,
    created: outcome === 'created' || outcome === 'reconciled_after_indeterminate_create',
    verified: true,
    ...extra,
  };
}

async function observeDestination(apiClient, normalized, options, phase) {
  const read = await safeRead(apiClient, repoPath(normalized.destination_repo), options, phase, {
    allowMissing: true,
    requiredPermissions: { administration: 'write', contents: 'read' },
  });
  if (!read.ok || read.missing) return read;
  return { ...read, snapshot: destinationSnapshot(read.body) };
}

async function reconcileCreate(apiClient, normalized, options, mutationEvidence, outcome = 'reconciled_after_indeterminate_create') {
  const observed = await observeDestination(apiClient, normalized, options, 'reconcile_after_indeterminate');
  if (observed.ok && !observed.missing && destinationMatches(observed.snapshot, normalized)) {
    return createSuccess(normalized, outcome, observed.snapshot, {
      mutation_attempted: true,
      reconciled_after_indeterminate: true,
      mutation_evidence: mutationEvidence,
      evidence: { verify: observed.evidence },
    });
  }
  if (observed.ok && !observed.missing) {
    return fail('GITHUB_REPOSITORY_TEMPLATE_CREATE_CONFLICT', 'Destination repository exists but does not match the declared template creation request.', {
      template_repo: normalized.template_repo,
      destination_repo: normalized.destination_repo,
      observed_destination: observed.snapshot,
      phase: 'reconcile_after_indeterminate',
      may_have_mutated: true,
      mutation_evidence: mutationEvidence,
    });
  }
  return fail('GITHUB_REPOSITORY_TEMPLATE_CREATE_INDETERMINATE', 'Repository creation may have occurred, but authoritative reconciliation could not prove the intended destination.', {
    template_repo: normalized.template_repo,
    destination_repo: normalized.destination_repo,
    phase: 'reconcile_after_indeterminate',
    may_have_mutated: true,
    mutation_evidence: mutationEvidence,
    ...(observed.ok ? {} : { verification_error: observed.error }),
  });
}

export async function createGithubRepositoryFromTemplate(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubRepositoryFromTemplateCreateRequest(input); }
  catch (error) { return fail(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {}); }
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.call !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub REST transport is required.');

  const template = await safeRead(apiClient, repoPath(normalized.template_repo), options, 'preflight_template', {
    requiredPermissions: { administration: 'write', contents: 'read' },
  });
  if (!template.ok) return template;
  if (template.body?.is_template !== true) {
    return fail('GITHUB_REPOSITORY_NOT_TEMPLATE', 'Source repository is not marked as a GitHub template.', {
      template_repo: normalized.template_repo,
      observed_is_template: template.body?.is_template === true,
      phase: 'precondition',
      may_have_mutated: false,
    });
  }

  const existing = await observeDestination(apiClient, normalized, options, 'preflight_destination');
  if (!existing.ok) return existing;
  if (!existing.missing) {
    if (destinationMatches(existing.snapshot, normalized)) {
      return createSuccess(normalized, 'already_exists', existing.snapshot, {
        mutation_attempted: false,
        evidence: { template: template.evidence, destination: existing.evidence },
      });
    }
    return fail('GITHUB_REPOSITORY_TEMPLATE_CREATE_CONFLICT', 'Destination repository already exists and does not match the declared template creation request.', {
      template_repo: normalized.template_repo,
      destination_repo: normalized.destination_repo,
      observed_destination: existing.snapshot,
      phase: 'precondition',
      may_have_mutated: false,
    });
  }

  const [templateOwner, templateName] = normalized.template_repo.split('/');
  const [destinationOwner, destinationName] = normalized.destination_repo.split('/');
  const path = `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(templateName)}/generate`;
  let response;
  try {
    response = await apiClient.call('github', {
      method: 'POST',
      path,
      body: {
        owner: destinationOwner,
        name: destinationName,
        description: normalized.description ?? '',
        include_all_branches: false,
        private: normalized.private,
      },
    });
  } catch (error) {
    return reconcileCreate(apiClient, normalized, options, {
      phase: 'create',
      transport_error: String(error?.message || error),
      may_have_mutated: true,
    });
  }

  const status = Number(response?.status || 0);
  if (!response || status < 200 || status >= 300) {
    if (status === 422 || status === 0 || status >= 500) {
      const reconciled = await reconcileCreate(
        apiClient,
        normalized,
        options,
        transportFailure(response, 'create', path, { mayHaveMutated: true, requiredPermissions: { administration: 'write', contents: 'read' } }),
        status === 422 ? 'already_exists' : 'reconciled_after_indeterminate_create',
      );
      if (reconciled.ok || reconciled.error === 'GITHUB_REPOSITORY_TEMPLATE_CREATE_CONFLICT' || reconciled.error === 'GITHUB_REPOSITORY_TEMPLATE_CREATE_INDETERMINATE') return reconciled;
    }
    return transportFailure(response, 'create', path, { mayHaveMutated: false, requiredPermissions: { administration: 'write', contents: 'read' } });
  }

  const verified = await observeDestination(apiClient, normalized, options, 'post_create_verify');
  if (verified.ok && !verified.missing && destinationMatches(verified.snapshot, normalized)) {
    return createSuccess(normalized, 'created', verified.snapshot, {
      mutation_attempted: true,
      reconciled_after_indeterminate: false,
      evidence: {
        template: template.evidence,
        create: githubTransportEvidence(response, { phase: 'create', path, attempts: 1, mayHaveMutated: true }),
        verify: verified.evidence,
      },
    });
  }
  return fail('GITHUB_REPOSITORY_TEMPLATE_CREATE_INDETERMINATE', 'GitHub acknowledged repository creation, but authoritative verification did not prove the exact template-derived destination.', {
    template_repo: normalized.template_repo,
    destination_repo: normalized.destination_repo,
    phase: 'post_create_verify',
    may_have_mutated: true,
    ...(verified.ok && !verified.missing ? { observed_destination: verified.snapshot } : {}),
    ...(!verified.ok ? { verification_error: verified.error } : {}),
  });
}

function authFailure(error, requiredPermissions) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return fail('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key before using repository template commands.');
  }
  if (status === 401 || status === 403 || status === 422) return fail('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status: status, required_permissions: requiredPermissions });
  if (status === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for the template repository.', { upstream_status: 404 });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR', message, { ...(status ? { upstream_status: status } : {}) });
}

export async function ensureGithubRepositoryTemplateWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubRepositoryTemplateEnsureRequest(input); }
  catch (error) { return fail(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {}); }
  try {
    return await withGitHubAppApiClient(
      normalized.repo,
      (apiClient) => ensureGithubRepositoryTemplate(normalized, { ...options, apiClient }),
      { permissionProfile: 'repository_template' },
    );
  } catch (error) {
    return authFailure(error, { administration: 'write', metadata: 'read' });
  }
}

export async function createGithubRepositoryFromTemplateWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubRepositoryFromTemplateCreateRequest(input); }
  catch (error) { return fail(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {}); }
  try {
    return await withGitHubAppApiClient(
      normalized.template_repo,
      (apiClient) => createGithubRepositoryFromTemplate(normalized, { ...options, apiClient }),
      { permissionProfile: 'repository_from_template' },
    );
  } catch (error) {
    return authFailure(error, { administration: 'write', contents: 'read' });
  }
}
