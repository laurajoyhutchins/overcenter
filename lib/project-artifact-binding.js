import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROJECT_REF = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OPERATIONS = new Set(['bind', 'rebind', 'revoke']);
const ARTIFACT_KINDS = new Set(['issue', 'pull_request']);
const RELATIONSHIPS = new Set(['full_coverage_equivalent']);
const SATISFACTION_CONDITIONS = new Set(['artifact_closed']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${field} must be an object`, { field });
  return value;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${field} contains unknown fields`, { field, unknown });
}

function normalizeArtifact(raw) {
  const artifact = record(raw, 'artifact');
  exactFields(artifact, new Set(['provider', 'repository', 'kind', 'number']), 'artifact');
  const provider = text(artifact.provider, 'artifact.provider').toLowerCase();
  if (provider !== 'github') fail('PROJECT_ARTIFACT_BINDING_INVALID', 'artifact.provider must be github', { provider });
  const repository = text(artifact.repository, 'artifact.repository');
  if (!REPOSITORY.test(repository)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'artifact.repository must be owner/repo', { repository });
  const kind = text(artifact.kind, 'artifact.kind').toLowerCase();
  if (!ARTIFACT_KINDS.has(kind)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'artifact.kind must be issue or pull_request', { kind });
  const number = artifact.number;
  if (!Number.isInteger(number) || number < 1) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'artifact.number must be a positive integer', { number });
  return Object.freeze({ provider, repository, kind, number });
}

export function normalizeProjectArtifactBindingRequest(raw) {
  const input = record(raw, 'request');
  exactFields(input, new Set([
    'operation', 'project_ref', 'transition_id', 'expected_revision', 'artifact',
    'relationship', 'satisfaction_condition', 'prior_binding_sha256',
  ]), 'request');
  const operation = input.operation == null ? 'bind' : text(input.operation, 'operation').toLowerCase();
  if (!OPERATIONS.has(operation)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'operation must be bind, rebind, or revoke', { operation });
  const projectRef = text(input.project_ref, 'project_ref');
  const match = PROJECT_REF.exec(projectRef);
  if (!match) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'project_ref must identify a GitHub repository', { project_ref:projectRef });
  const transitionId = text(input.transition_id, 'transition_id');
  const expectedRevision = text(input.expected_revision, 'expected_revision').toLowerCase();
  if (!SHA40.test(expectedRevision)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'expected_revision must be an exact Git revision', { expected_revision:expectedRevision });
  const artifact = normalizeArtifact(input.artifact);
  if (artifact.repository !== match[1]) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'artifact repository must equal project repository', { project_repository:match[1], artifact_repository:artifact.repository });
  const relationship = text(input.relationship, 'relationship');
  if (!RELATIONSHIPS.has(relationship)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'unsupported relationship', { relationship });
  const satisfactionCondition = text(input.satisfaction_condition, 'satisfaction_condition');
  if (!SATISFACTION_CONDITIONS.has(satisfactionCondition)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'unsupported satisfaction condition', { satisfaction_condition:satisfactionCondition });
  let priorBindingSha256 = null;
  if (input.prior_binding_sha256 != null) {
    priorBindingSha256 = text(input.prior_binding_sha256, 'prior_binding_sha256').toLowerCase();
    if (!SHA256.test(priorBindingSha256)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'prior_binding_sha256 must be a SHA-256 digest');
  }
  if (operation !== 'bind' && priorBindingSha256 === null) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${operation} requires prior_binding_sha256`, { field:'prior_binding_sha256' });
  const normalized = {
    ...(operation === 'bind' ? {} : { operation }),
    project_ref:projectRef,
    transition_id:transitionId,
    expected_revision:expectedRevision,
    artifact,
    relationship,
    satisfaction_condition:satisfactionCondition,
    ...(priorBindingSha256 ? { prior_binding_sha256:priorBindingSha256 } : {}),
  };
  return Object.freeze(normalized);
}

export async function projectArtifactBindingSha256(raw) {
  return sha256Text(canonicalJson(normalizeProjectArtifactBindingRequest(raw)));
}

function sameArtifact(left, right) {
  return left.provider === String(right?.provider || '').toLowerCase()
    && left.repository === right?.repository
    && left.kind === String(right?.kind || '').toLowerCase()
    && left.number === right?.number;
}

export function evaluateProjectArtifactBinding(rawBinding, rawArtifact) {
  const binding = normalizeProjectArtifactBindingRequest(rawBinding);
  if (binding.operation === 'revoke') return 'ambiguous';
  if (!sameArtifact(binding.artifact, rawArtifact)) return 'ambiguous';
  if (binding.relationship !== 'full_coverage_equivalent') return 'ambiguous';
  if (binding.satisfaction_condition === 'artifact_closed') {
    return String(rawArtifact?.state || '').toLowerCase() === 'closed' ? 'satisfied' : 'unsatisfied';
  }
  return 'ambiguous';
}

function exactAuthority(raw, request) {
  const authority = record(raw, 'project authority');
  const revision = text(authority.revision, 'project authority revision').toLowerCase();
  const repository = text(authority.repository, 'project authority repository');
  if (authority.kind !== 'github' || repository !== request.artifact.repository || revision !== request.expected_revision) {
    fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE', 'project authority does not match the exact binding request', {
      expected_revision:request.expected_revision,
      actual_revision:revision,
      expected_repository:request.artifact.repository,
      actual_repository:repository,
    });
  }
  if (!Array.isArray(authority.transition_ids) || !authority.transition_ids.includes(request.transition_id)) {
    fail('PROJECT_ARTIFACT_BINDING_SUBJECT_MISSING', 'transition is absent from current authoritative project graph', {
      transition_id:request.transition_id,
    });
  }
  return Object.freeze({
    kind:'github',
    repository,
    revision,
    derivation:text(authority.derivation, 'project authority derivation'),
  });
}

function exactArtifactObservation(raw, expected) {
  const artifact = record(raw, 'artifact observation');
  if (!sameArtifact(expected, artifact)) {
    fail('PROJECT_ARTIFACT_BINDING_ARTIFACT_MISMATCH', 'provider readback does not match the exact requested artifact identity');
  }
  const nodeId = text(artifact.node_id, 'artifact observation node_id');
  const state = text(artifact.state, 'artifact observation state').toLowerCase();
  if (!['open', 'closed'].includes(state)) fail('PROJECT_ARTIFACT_BINDING_ARTIFACT_INVALID', 'artifact observation state must be open or closed', { state });
  return Object.freeze({ ...expected, node_id:nodeId, state });
}

function priorIdentity(raw) {
  if (!raw) return null;
  const sha = text(raw.binding_sha256, 'current binding_sha256').toLowerCase();
  if (!SHA256.test(sha)) fail('PROJECT_ARTIFACT_BINDING_STORE_INVALID', 'current binding has invalid identity');
  return sha;
}

export function createProjectArtifactBindingService(dependencies = {}) {
  const { readProjectAuthority, readArtifact, appendEvent, readCurrentBinding } = dependencies;
  if (typeof readProjectAuthority !== 'function' || typeof readArtifact !== 'function'
      || typeof appendEvent !== 'function' || typeof readCurrentBinding !== 'function') {
    throw new TypeError('project artifact binding service requires authority, provider, and durable event dependencies');
  }
  return Object.freeze({
    async mutate(rawRequest) {
      const request = normalizeProjectArtifactBindingRequest(rawRequest);
      const authority = exactAuthority(await readProjectAuthority({ project_ref:request.project_ref }), request);
      const current = await readCurrentBinding({ project_ref:request.project_ref, transition_id:request.transition_id });
      const currentSha = priorIdentity(current);
      const operation = request.operation || 'bind';
      if (operation === 'bind' && currentSha) {
        fail('PROJECT_ARTIFACT_BINDING_ALREADY_EXISTS', 'existing binding requires explicit rebind or revoke', { binding_sha256:currentSha });
      }
      if (operation !== 'bind' && currentSha !== request.prior_binding_sha256) {
        fail('PROJECT_ARTIFACT_BINDING_PRIOR_MISMATCH', 'prior binding identity changed before explicit mutation', {
          expected_binding_sha256:request.prior_binding_sha256,
          actual_binding_sha256:currentSha,
        });
      }
      const artifact = operation === 'revoke'
        ? Object.freeze({ ...request.artifact, node_id:text(current?.artifact?.node_id, 'current artifact node_id'), state:text(current?.artifact?.state, 'current artifact state').toLowerCase() })
        : exactArtifactObservation(await readArtifact(request.artifact), request.artifact);
      const binding = Object.freeze({
        schema:'project-artifact-binding-v1',
        operation,
        project_ref:request.project_ref,
        transition_id:request.transition_id,
        authority,
        artifact,
        relationship:request.relationship,
        satisfaction_condition:request.satisfaction_condition,
        ...(request.prior_binding_sha256 ? { prior_binding_sha256:request.prior_binding_sha256 } : {}),
      });
      const bindingSha256 = await sha256Text(canonicalJson(binding));
      const event = Object.freeze({ ...binding, binding_sha256:bindingSha256 });
      const stored = await appendEvent(event);
      if (!stored) fail('PROJECT_ARTIFACT_BINDING_STORE_FAILED', 'durable binding event was not confirmed');
      return Object.freeze({ ok:true, binding:event });
    },
  });
}
