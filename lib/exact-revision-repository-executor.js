const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) fail('REPOSITORY_EXECUTOR_REQUEST_INVALID', `${name} is required`, { field: name });
  return text;
}

function exactSha(value, name) {
  const sha = required(value, name).toLowerCase();
  if (!SHA40.test(sha)) fail('REPOSITORY_EXECUTOR_REQUEST_INVALID', `${name} must be an exact Git SHA`, { field: name });
  return sha;
}

function fingerprint(value) {
  const sha = required(value, 'executor_fingerprint').toLowerCase();
  if (!SHA256.test(sha)) fail('REPOSITORY_EXECUTOR_REQUEST_INVALID', 'executor_fingerprint must be a SHA-256 digest');
  return sha;
}

export function createRepositoryExecutionRequest(packet, executor) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('REPOSITORY_EXECUTOR_REQUEST_INVALID', 'execution packet is required');
  if (!executor || typeof executor !== 'object' || Array.isArray(executor)) fail('REPOSITORY_EXECUTOR_REQUEST_INVALID', 'executor descriptor is required');
  const networkPolicy = String(executor.network_policy || '').trim();
  if (!['disabled', 'restricted', 'unrestricted'].includes(networkPolicy)) fail('REPOSITORY_EXECUTOR_CAPABILITY_INVALID', 'network_policy is invalid');
  const authorizedMutations = Array.isArray(packet.authorized_mutations) ? packet.authorized_mutations.map(String) : [];
  return Object.freeze({
    schema: 'repository-executor-request-v1',
    project_ref: required(packet.project_ref, 'project_ref'),
    repository: required(packet.repository, 'repository'),
    authority_revision: exactSha(packet?.authority?.revision, 'authority_revision'),
    transition_id: required(packet.transition_id, 'transition_id'),
    lease_ref: required(packet.lease_ref, 'lease_ref'),
    resume_ref: required(packet.resume_ref, 'resume_ref'),
    run_id: required(packet.run_id, 'run_id'),
    transition_definition_fingerprint: fingerprint(packet.transition_definition_fingerprint),
    acceptance_evidence: Object.freeze([...(packet?.execution_intent?.acceptance_evidence || [])]),
    mutation_budget: Object.freeze(authorizedMutations),
    capabilities: Object.freeze({ network_policy: networkPolicy, repository_mutation: false }),
    executor_identity: required(executor.executor_identity, 'executor_identity'),
    executor_fingerprint: fingerprint(executor.executor_fingerprint),
  });
}

export function validateRepositoryExecutionResult(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('REPOSITORY_EXECUTOR_RESULT_INVALID', 'executor result must be an object');
  for (const field of ['authority_revision', 'transition_id', 'lease_ref', 'executor_identity', 'executor_fingerprint']) {
    if (String(result[field] || '') !== String(request[field] || '')) fail('REPOSITORY_EXECUTOR_RESULT_IDENTITY_MISMATCH', `executor result ${field} does not match request`, { field });
  }
  if (!['completed', 'blocked', 'failed'].includes(result.status)) fail('REPOSITORY_EXECUTOR_RESULT_INVALID', 'executor result status is invalid');
  if (!Array.isArray(result.evidence)) fail('REPOSITORY_EXECUTOR_RESULT_INVALID', 'executor result evidence must be an array');
  return Object.freeze({ ...result, evidence: Object.freeze([...result.evidence]) });
}

export function bindRepositoryExecutionResult(request, boundedResult) {
  const result = {
    schema: 'repository-executor-result-v1',
    authority_revision: request.authority_revision,
    transition_id: request.transition_id,
    lease_ref: request.lease_ref,
    executor_identity: request.executor_identity,
    executor_fingerprint: request.executor_fingerprint,
    status: boundedResult.status,
    summary: boundedResult.summary,
    evidence: boundedResult.evidence,
  };
  return validateRepositoryExecutionResult(result, request);
}