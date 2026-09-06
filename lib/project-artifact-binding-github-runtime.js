import { canonicalJson, sha256Text } from './canonical-json.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { withGitHubAppApiClient } from './github-app-auth.js';
import { createProjectArtifactBindingService } from './project-artifact-binding.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
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
  const bindingRefFor = async (core) => `sha256:${await sha256Text(canonicalJson(core))}`;
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
  return createProjectArtifactBindingService({ readProjectGraph, readProviderArtifact, bindingRefFor, appendBindingObservation });
}