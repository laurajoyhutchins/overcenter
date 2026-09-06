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
