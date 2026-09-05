import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA40 = /^[0-9a-f]{40}$/i;
const PROJECT = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const ACTIONS = new Set(['bind', 'revoke', 'supersede', 'rebind']);
const RELATIONSHIPS = new Set(['full-coverage-equivalent']);
const CONDITIONS = new Set(['issue-closed', 'pull-request-merged']);
const PROVIDERS = new Set(['issue', 'pull_request']);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, may_have_mutated: false });
}
function text(value, field, max = 512) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', `${field} is required`, { field });
  return result;
}
function exactRevision(value, field = 'expected_revision') {
  const revision = text(value, field, 40).toLowerCase();
  if (!SHA40.test(revision)) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', `${field} must be an exact Git revision`, { field });
  return revision;
}

export async function normalizeProjectArtifactBindingRequest(input = {}) {
  const match = text(input.project_ref, 'project_ref', 300).match(PROJECT);
  if (!match) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'project_ref must identify one GitHub repository');
  const transitionId = text(input.transition_id, 'transition_id', 256);
  const expectedRevision = exactRevision(input.expected_revision);
  const action = text(input.action, 'action', 32);
  const relationship = text(input.relationship, 'relationship', 64);
  const satisfactionCondition = text(input.satisfaction_condition, 'satisfaction_condition', 64);
  const providerKind = text(input.provider?.kind, 'provider.kind', 32);
  const providerId = Number(input.provider?.id);
  if (!ACTIONS.has(action)) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'action is invalid');
  if (!RELATIONSHIPS.has(relationship)) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'relationship is invalid');
  if (!CONDITIONS.has(satisfactionCondition)) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'satisfaction_condition is invalid');
  if (!PROVIDERS.has(providerKind) || !Number.isInteger(providerId) || providerId < 1) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'provider identity is invalid');
  if (providerKind === 'issue' && satisfactionCondition !== 'issue-closed') throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'issue binding requires issue-closed satisfaction');
  if (providerKind === 'pull_request' && satisfactionCondition !== 'pull-request-merged') throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'pull request binding requires pull-request-merged satisfaction');
  const priorBindingId = input.prior_binding_id == null ? null : text(input.prior_binding_id, 'prior_binding_id', 128);
  if (action !== 'bind' && !priorBindingId) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'prior_binding_id is required for revoke, supersede, and rebind');
  if (action === 'bind' && priorBindingId) throw failure('PROJECT_ARTIFACT_BINDING_INVALID', 'prior_binding_id is not accepted for bind');
  const semantic = { schema:'project-artifact-binding-request-v1', project_ref:input.project_ref, repository:match[1], expected_revision:expectedRevision, transition_id:transitionId, provider:{ kind:providerKind, id:providerId }, relationship, satisfaction_condition:satisfactionCondition, action, prior_binding_id:priorBindingId };
  const digest = await sha256Text(canonicalJson(semantic));
  return Object.freeze({ ...semantic, binding_id:`pab_${digest}` });
}

export function evaluateProjectArtifactBinding(binding, provider) {
  if (!binding) return Object.freeze({ classification:'ambiguous', reason:'no-explicit-binding' });
  if (!provider || binding.provider?.kind !== provider.kind || Number(binding.provider?.id) !== Number(provider.id)) return Object.freeze({ classification:'ambiguous', reason:'provider-identity-mismatch' });
  if (binding.action === 'revoke' || binding.action === 'supersede') return Object.freeze({ classification:binding.action === 'revoke' ? 'revoked' : 'superseded' });
  const satisfied = binding.satisfaction_condition === 'issue-closed' ? String(provider.state || '').toLowerCase() === 'closed' : Boolean(provider.merged);
  return Object.freeze({ classification:satisfied ? 'satisfied' : 'active', provider_state:String(provider.state || '').toLowerCase() || null });
}

export function createProjectArtifactBindingService(options = {}) {
  if (typeof options.inspectProject !== 'function') throw new TypeError('inspectProject is required');
  if (typeof options.readProvider !== 'function') throw new TypeError('readProvider is required');
  if (!options.store || typeof options.store.record !== 'function') throw new TypeError('store.record is required');
  return Object.freeze({ async bind(input) {
    const request = await normalizeProjectArtifactBindingRequest(input);
    const project = await options.inspectProject({ project_ref:request.project_ref });
    const currentRevision = String(project?.authority?.revision || '').toLowerCase();
    if (currentRevision !== request.expected_revision) throw failure('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE', 'project authority changed before artifact binding', { expected_revision:request.expected_revision, actual_revision:currentRevision });
    const provider = await options.readProvider({ repository:request.repository, ...request.provider });
    if (!provider || provider.kind !== request.provider.kind || Number(provider.id) !== request.provider.id) throw failure('PROJECT_ARTIFACT_BINDING_PROVIDER_MISMATCH', 'provider identity changed or could not be proven');
    const binding = Object.freeze({ ...request, classification:evaluateProjectArtifactBinding(request, provider).classification, provider_observation:provider });
    const persisted = await options.store.record({ binding_id:request.binding_id, request, binding });
    if (persisted?.outcome === 'conflict') throw failure('PROJECT_ARTIFACT_BINDING_IDEMPOTENCY_CONFLICT', 'binding retry identity conflicts with durable evidence');
    return Object.freeze({ schema:'project-artifact-binding-result-v1', outcome:persisted?.outcome || 'recorded', binding });
  } });
}