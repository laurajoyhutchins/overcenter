const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NETWORK_POLICIES = new Set(['none', 'restricted']);

function reject(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertExecutionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('REPOSITORY_EXECUTOR_REQUEST_INVALID', 'repository execution request is required');
  if (!nonEmpty(input.source?.repository) || !SHA40.test(String(input.source?.revision || '').toLowerCase())) {
    reject('REPOSITORY_EXECUTOR_SOURCE_REVISION_INVALID', 'repository execution requires an exact Git revision');
  }
  if (!nonEmpty(input.authority?.transition_id) || !nonEmpty(input.authority?.lease_ref) || !SHA256.test(String(input.authority?.transition_definition_fingerprint || '').toLowerCase())) {
    reject('REPOSITORY_EXECUTOR_AUTHORITY_INVALID', 'repository execution requires transition and lease authority bound to its definition fingerprint');
  }
  const identity = input.executor?.identity;
  if (!nonEmpty(identity?.provider) || !nonEmpty(identity?.implementation) || !SHA256.test(String(identity?.fingerprint || '').toLowerCase())) {
    reject('REPOSITORY_EXECUTOR_IDENTITY_INVALID', 'repository execution requires an exact executor identity and fingerprint');
  }
  const capabilities = input.executor?.capabilities;
  if (!NETWORK_POLICIES.has(capabilities?.network)) reject('REPOSITORY_EXECUTOR_CAPABILITY_INVALID', 'executor network policy is missing or unsupported');
  if (capabilities?.repository_write !== false) reject('REPOSITORY_EXECUTOR_REPOSITORY_WRITE_FORBIDDEN', 'untrusted executor phase may not hold repository mutation authority');
  const limits = input.limits;
  if (!Number.isInteger(limits?.max_output_bytes) || limits.max_output_bytes < 1 || !Number.isInteger(limits?.max_evidence_items) || limits.max_evidence_items < 1) {
    reject('REPOSITORY_EXECUTOR_LIMITS_INVALID', 'bounded output limits are required');
  }
  return Object.freeze({
    source: Object.freeze({ repository: input.source.repository, revision: input.source.revision.toLowerCase() }),
    authority: Object.freeze({ ...input.authority, transition_definition_fingerprint: input.authority.transition_definition_fingerprint.toLowerCase() }),
    executor: Object.freeze({
      identity: Object.freeze({ ...identity, fingerprint: identity.fingerprint.toLowerCase() }),
      capabilities: Object.freeze({ ...capabilities }),
    }),
    limits: Object.freeze({ ...limits }),
  });
}

export function assertExecutionResult(result, limits) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) reject('REPOSITORY_EXECUTOR_RESULT_INVALID', 'repository executor result must be an object');
  if (!['completed', 'blocked'].includes(result.status) || !nonEmpty(result.summary) || !Array.isArray(result.evidence)) {
    reject('REPOSITORY_EXECUTOR_RESULT_INVALID', 'repository executor result has an invalid shape');
  }
  if (result.evidence.length > limits.max_evidence_items) reject('REPOSITORY_EXECUTOR_OUTPUT_TOO_LARGE', 'repository executor evidence exceeds the configured bound');
  const encoded = new TextEncoder().encode(JSON.stringify(result));
  if (encoded.length > limits.max_output_bytes) reject('REPOSITORY_EXECUTOR_OUTPUT_TOO_LARGE', 'repository executor output exceeds the configured byte bound');
  for (const [index, entry] of result.evidence.entries()) {
    if (!nonEmpty(entry?.kind) || !nonEmpty(entry?.detail)) reject('REPOSITORY_EXECUTOR_RESULT_INVALID', `repository executor evidence[${index}] is invalid`);
  }
  return result;
}

export async function executeExactRevisionRepositoryWork(rawRequest, provider) {
  const request = assertExecutionRequest(rawRequest);
  if (!same(provider?.identity, request.executor.identity)) reject('REPOSITORY_EXECUTOR_IDENTITY_MISMATCH', 'executor provider identity does not match the authority-bound request');
  if (!same(provider?.capabilities, request.executor.capabilities)) reject('REPOSITORY_EXECUTOR_CAPABILITY_MISMATCH', 'executor provider capabilities do not match the authority-bound request');
  if (typeof provider?.execute !== 'function') reject('REPOSITORY_EXECUTOR_PROVIDER_INVALID', 'executor provider execute function is required');
  const result = await provider.execute(request);
  return assertExecutionResult(result, request.limits);
}
