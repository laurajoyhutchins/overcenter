import { canonicalJson, sha256Text } from './canonical-json.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { withGitHubAppApiClient } from './github-app-auth.js';

const PROJECT_REF = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
const SHA40 = /^[0-9a-f]{40}$/;
const KINDS = new Set(['issue','pull_request']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function text(value, field, max = 512) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) fail('PROJECT_ARTIFACT_BINDING_INVALID', `${field} is required`, { field });
  return result;
}
function normalize(input = {}) {
  const projectRef = text(input.project_ref, 'project_ref', 300);
  const match = projectRef.match(PROJECT_REF);
  if (!match) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'project_ref must identify one GitHub repository');
  const expectedRevision = text(input.expected_revision, 'expected_revision', 40).toLowerCase();
  if (!SHA40.test(expectedRevision)) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'expected_revision must be a full Git SHA');
  const transitionId = text(input.transition_id, 'transition_id', 256);
  const kind = text(input.provider?.kind, 'provider.kind', 32);
  const number = Number(input.provider?.number);
  if (!KINDS.has(kind) || !Number.isInteger(number) || number < 1) fail('PROJECT_ARTIFACT_BINDING_INVALID', 'provider must name an issue or pull request by positive numeric identity');
  const relationship = text(input.relationship, 'relationship', 64);
  if (relationship !== 'full_coverage_equivalence') fail('PROJECT_ARTIFACT_BINDING_INVALID', 'relationship must explicitly assert full_coverage_equivalence');
  const satisfaction = text(input.satisfaction_condition, 'satisfaction_condition', 32);
  if ((kind === 'issue' && satisfaction !== 'closed') || (kind === 'pull_request' && satisfaction !== 'merged')) {
    fail('PROJECT_ARTIFACT_BINDING_INVALID', 'satisfaction_condition must be closed for issues and merged for pull requests');
  }
  return Object.freeze({ project_ref:projectRef, repository:match[1], expected_revision:expectedRevision, transition_id:transitionId, provider:Object.freeze({ kind, number }), relationship, satisfaction_condition:satisfaction });
}

export function classifyProjectArtifactBinding(binding, provider) {
  if (!binding) return Object.freeze({ classification:'ambiguous', reason:'explicit-binding-required' });
  if (!provider || provider.repository !== binding.repository || provider.kind !== binding.provider.kind || Number(provider.number) !== binding.provider.number) {
    return Object.freeze({ classification:'ambiguous', reason:'provider-identity-mismatch' });
  }
  const satisfied = binding.satisfaction_condition === 'closed'
    ? String(provider.state || '').toLowerCase() === 'closed'
    : Boolean(provider.merged);
  return Object.freeze({ classification:satisfied ? 'satisfied' : 'active', evidence:Object.freeze({ binding_ref:binding.binding_ref, provider:Object.freeze({ repository:provider.repository, kind:provider.kind, number:Number(provider.number) }) }) });
}

export function createProjectArtifactBindingService(options = {}) {
  const readProjectGraph = options.readProjectGraph;
  const readProviderArtifact = options.readProviderArtifact;
  const appendBindingObservation = options.appendBindingObservation;
  if (typeof readProjectGraph !== 'function' || typeof readProviderArtifact !== 'function' || typeof appendBindingObservation !== 'function') fail('PROJECT_ARTIFACT_BINDING_RUNTIME_INVALID', 'binding runtime dependencies are unavailable');
  return Object.freeze({
    async bind(input) {
      const request = normalize(input);
      const graph = await readProjectGraph({ project_ref:request.project_ref });
      const authority = graph?.authority?.definition;
      if (authority?.repository !== request.repository || String(authority?.revision || '').toLowerCase() !== request.expected_revision) {
        fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE', 'project artifact binding authority changed before mutation', { expected_revision:request.expected_revision, actual_revision:authority?.revision || null });
      }
      if (!Array.isArray(graph.nodes) || !graph.nodes.some((node) => String(node?.id || '') === request.transition_id)) {
        fail('PROJECT_ARTIFACT_BINDING_SUBJECT_NOT_FOUND', 'transition is absent from the exact authoritative project graph', { transition_id:request.transition_id });
      }
      const provider = await readProviderArtifact({ repository:request.repository, ...request.provider });
      if (!provider || provider.repository !== request.repository || provider.kind !== request.provider.kind || Number(provider.number) !== request.provider.number) {
        fail('PROJECT_ARTIFACT_BINDING_PROVIDER_MISMATCH', 'provider readback does not match the explicitly selected artifact identity');
      }
      const core = { schema:'project-artifact-binding-v1', project_ref:request.project_ref, repository:request.repository, authority_revision:request.expected_revision, transition_id:request.transition_id, provider:request.provider, relationship:request.relationship, satisfaction_condition:request.satisfaction_condition };
      const bindingRef = `sha256:${await sha256Text(canonicalJson(core))}`;
      const binding = Object.freeze({ ...core, binding_ref:bindingRef });
      const persisted = await appendBindingObservation(binding);
      return Object.freeze({ ok:true, binding, provider:Object.freeze({ ...provider }), observation_ref:persisted?.observation_ref || null, classification:classifyProjectArtifactBinding(binding, provider) });
    },
  });
}

const ARTIFACT_QUERY = `query ProjectArtifactBinding($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number state url} ... on PullRequest{number state merged url}}}}`;

export function projectArtifactBindingFor(options = {}) {
  const db = options.db;
  if (!db || typeof db.query !== 'function') fail('PROJECT_ARTIFACT_BINDING_RUNTIME_INVALID', 'database binding is required');
  const readProjectGraph = createAuthoritativeProjectGraphReader(createGitHubProjectGraphRuntime({ db }));
  const readProviderArtifact = async ({ repository, kind, number }) => {
    const [owner, name] = repository.split('/');
    return withGitHubAppApiClient(repository, async (apiClient) => {
      const response = await apiClient.graphql(ARTIFACT_QUERY, { owner, name, number });
      const artifact = response?.body?.data?.repository?.issueOrPullRequest;
      const observedKind = artifact?.__typename === 'Issue' ? 'issue' : artifact?.__typename === 'PullRequest' ? 'pull_request' : null;
      if (!artifact || observedKind !== kind) fail('PROJECT_ARTIFACT_BINDING_PROVIDER_NOT_FOUND', 'selected provider artifact does not exist with the requested kind', { repository, kind, number });
      return Object.freeze({ repository, kind:observedKind, number:Number(artifact.number), state:String(artifact.state || '').toLowerCase(), merged:Boolean(artifact.merged), url:artifact.url ? String(artifact.url) : null });
    });
  };
  const appendBindingObservation = async (binding) => {
    const payloadCanonical = canonicalJson(binding);
    const payloadSha = await sha256Text(payloadCanonical);
    const idempotencyKey = `project-artifact-binding-v1:${binding.binding_ref}`;
    await db.query(`INSERT INTO portfolio_observations (idempotency_key,source_system,entity_type,entity_key,fact_type,observed_at,source_revision,payload,payload_canonical,payload_sha256,ingestion_source) VALUES ($1,'overcenter','project.artifact.binding',$2,'bound',now(),$3,$4::jsonb,$5,$6,'project.artifact.bind') ON CONFLICT (idempotency_key) DO NOTHING`, [idempotencyKey, `${binding.project_ref}#${binding.transition_id}`, binding.authority_revision, payloadCanonical, payloadCanonical, payloadSha]);
    const { rows } = await db.query('SELECT observation_id,payload_sha256 FROM portfolio_observations WHERE idempotency_key=$1 LIMIT 1', [idempotencyKey]);
    const row = rows?.[0];
    if (!row || String(row.payload_sha256) !== payloadSha) fail('PROJECT_ARTIFACT_BINDING_IDEMPOTENCY_CONFLICT', 'durable binding identity conflicts with existing evidence');
    return { observation_ref:`portfolio_observation:${row.observation_id}` };
  };
  return createProjectArtifactBindingService({ readProjectGraph, readProviderArtifact, appendBindingObservation });
}