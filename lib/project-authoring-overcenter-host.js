// Database provider is injected by the runtime composition root.
import { createProjectAuthoringWorkerBinding } from './project-authoring-host-runtime.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresRepositoryDispositionStore } from './repository-disposition.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';
import { createProjectAuthoringRecoveryService } from './project-authoring-recovery.js';
import { canonicalProjectDefinition } from './project-authoring.js';
import { createGithubIntegrationApiAdapter } from './github-integration.js';
import {
  applyGithubChangesetRoleAware,
  createGithubPullRequestRoleAware,
  reconcileGithubIntegrationRoleAware,
} from './github-branch-role-runtime.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from './overcenter-project-graph-deriver.js';

function unsupportedDerivation(input) {
  const error = new Error('project authoring derivation is not registered by the worker host');
  error.code = 'PROJECT_GRAPH_DERIVER_UNAVAILABLE';
  error.details = { derivation:input?.authority?.derivation || null };
  return error;
}

async function observeIntegratedCandidate(request, pull, options) {
  return reconcileGithubIntegrationRoleAware({
    repo:request.repository,
    pull_request:pull.pull_request,
    expected_head:request.expected_head,
    apply:false,
  }, options);
}

async function mergeProjectAuthoringCandidate(request, pull, options) {
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (typeof withGitHubAppApiClient !== 'function') throw Object.assign(new Error('GitHub auth provider is unavailable'), { code:'RUNTIME_PROVIDER_MISSING', details:{ provider:'githubAppAuth' } });
  let merge;
  try {
    merge = await withGitHubAppApiClient(request.repository, async (apiClient) => {
      const integrationApi = createGithubIntegrationApiAdapter(apiClient);
      return integrationApi.mergeDirect({
        repo:request.repository,
        pull_request:pull.pull_request,
        expected_head:request.expected_head,
        merge_method:'squash',
      });
    }, { permissionProfile:'integration_merge' });
  } catch (error) {
    const observed = await observeIntegratedCandidate(request, pull, options);
    if (observed?.ok && ['merged','already_merged'].includes(String(observed?.outcome || ''))) return observed;
    throw error;
  }

  if (merge?.ok && String(merge?.status || '').toLowerCase() === 'merged') {
    return {
      ok:true,
      outcome:'merged',
      repo:request.repository,
      pull_request:pull.pull_request,
      expected_head:request.expected_head,
      merge_commit_sha:merge.sha || null,
      integration_transport:'direct_exact_head',
      message:merge.message || null,
    };
  }

  if (merge?.may_have_mutated === true || merge?.error === 'GITHUB_INTEGRATION_INDETERMINATE') {
    const observed = await observeIntegratedCandidate(request, pull, options);
    if (observed?.ok && ['merged','already_merged'].includes(String(observed?.outcome || ''))) return observed;
  }
  return merge;
}

function projectDefinitionAt(factsInput, projectRef) {
  const facts = factsInput?.facts?.definition_facts || factsInput?.definition_facts || factsInput;
  const matches = [];
  for (const entry of Array.isArray(facts?.definitions) ? facts.definitions : []) {
    if (typeof entry?.content !== 'string') continue;
    try {
      const definition = canonicalProjectDefinition(JSON.parse(entry.content));
      if (definition.project_ref === projectRef) matches.push(definition);
    } catch {}
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

function mappedRecoveryObservation(prior, observed, authority) {
  const outcome = String(observed?.outcome || '').trim();
  if (observed?.ok && ['merged','already_merged'].includes(outcome)) {
    return Object.freeze({ outcome:'ready', integration:observed, already_merged:true });
  }
  if (String(authority?.revision || '').toLowerCase() !== String(prior.expected_revision || '').toLowerCase()) {
    return Object.freeze({ outcome:'base_moved', observed_authority_revision:authority?.revision || null });
  }
  if (!observed?.ok) {
    const code = String(observed?.error || '');
    if (code === 'GITHUB_INTEGRATION_PULL_REQUEST_CLOSED') return Object.freeze({ outcome:'closed', error:code });
    if (code === 'GITHUB_INTEGRATION_RECOMPUTE_REQUIRED' || code === 'HEAD_MISMATCH') return Object.freeze({ outcome:'head_moved', error:code });
    if (code === 'GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED' || code === 'GITHUB_INTEGRATION_POLICY_EVIDENCE_INCOMPLETE') return Object.freeze({ outcome:'policy_ambiguous', error:code });
    return Object.freeze({ outcome:'recompute_required', error:code || null });
  }
  if (observed?.expected_head && String(observed.expected_head).toLowerCase() !== String(prior.staged_revision).toLowerCase()) {
    return Object.freeze({ outcome:'head_moved', observed_head:observed.expected_head });
  }
  if (outcome === 'waiting') {
    const checks = observed?.evidence?.checks || {};
    if (checks.enumeration_complete === true && Array.isArray(checks.failing_required) && checks.failing_required.length > 0) {
      return Object.freeze({ outcome:'failed_verification', waiting_on:checks.failing_required, integration:observed });
    }
    return Object.freeze({ outcome:'waiting', waiting_on:observed.waiting_on || [], integration:observed });
  }
  if (outcome === 'ready') return Object.freeze({ outcome:'ready', integration:observed });
  if (['needs_update','updated_for_recheck','stack_rebase_required'].includes(outcome)) return Object.freeze({ outcome:'recompute_required', integration:observed });
  return Object.freeze({ outcome:'recompute_required', integration:observed });
}

function integrationFailureError(result) {
  const error = new Error(String(result?.message || 'project authoring integration failed'));
  error.code = String(result?.error || 'PROJECT_AUTHORING_INTEGRATION_FAILED');
  error.may_have_mutated = Boolean(result?.may_have_mutated);
  error.details = result && typeof result === 'object' ? result : null;
  return error;
}

export function createProjectAuthoringRecoveryForRuntime(runtime = {}, overrides = {}) {
  const operations = overrides.operations || createCompactProviderOperationPostgresStore(runtime.db);
  const withGitHubAppApiClient = runtime.withGitHubAppApiClient || runtime.githubAppAuth?.withApiClient;
  const graphRuntime = overrides.graphRuntime || createGitHubProjectGraphRuntime({ db:runtime.db, withGitHubAppApiClient });
  const providerOptions = { db:runtime.db, withGitHubAppApiClient };
  const inspectIntegration = overrides.inspectIntegration || (async (prior) => reconcileGithubIntegrationRoleAware({
    repo:String(prior.project_ref).slice('github:'.length),
    pull_request:prior.pull_request,
    expected_head:prior.staged_revision,
    apply:false,
  }, providerOptions));
  const integrateCandidate = overrides.integrateCandidate || (async (prior, observed) => {
    if (observed?.already_merged === true && observed?.integration) return observed.integration;
    const result = await mergeProjectAuthoringCandidate(
      { repository:String(prior.project_ref).slice('github:'.length), expected_head:prior.staged_revision },
      { pull_request:prior.pull_request },
      providerOptions,
    );
    if (result?.ok && ['merged','already_merged'].includes(String(result?.outcome || ''))) return result;
    if (result?.may_have_mutated === true || result?.error === 'GITHUB_INTEGRATION_INDETERMINATE') throw integrationFailureError({ ...result, may_have_mutated:true });
    if (result?.error === 'GITHUB_INTEGRATION_RECOMPUTE_REQUIRED' || result?.error === 'HEAD_MISMATCH') return Object.freeze({ ok:true, outcome:'recompute_required' });
    if (result?.error === 'GITHUB_INTEGRATION_NOT_READY') return Object.freeze({ ok:true, outcome:'waiting', waiting_on:['mergeability'] });
    throw integrationFailureError(result);
  });
  const deriveProjectGraph = overrides.deriveProjectGraph || deriveOvercenterProjectGraph;
  const service = createProjectAuthoringRecoveryService({
    operations,
    listPending:(input) => operations.listPending(input),
    async inspectCandidate(prior) {
      if (!Number.isInteger(prior?.pull_request) || prior.pull_request < 1) return Object.freeze({ outcome:'recompute_required' });
      const observed = await inspectIntegration(prior);
      const authority = await graphRuntime.resolveProjectAuthority({ project_ref:prior.project_ref });
      return mappedRecoveryObservation(prior, observed, authority);
    },
    integrateCandidate,
    async readAuthoritativeProject(prior) {
      const repository = String(prior.project_ref).slice('github:'.length);
      const authority = await graphRuntime.resolveProjectAuthority({ project_ref:prior.project_ref });
      const [stagedFacts, currentFacts] = await Promise.all([
        graphRuntime.readProjectFacts({ repository, revision:prior.staged_revision }),
        graphRuntime.readProjectFacts({ repository, revision:authority.revision }),
      ]);
      const stagedDefinition = projectDefinitionAt(stagedFacts, prior.project_ref);
      const currentDefinition = projectDefinitionAt(currentFacts, prior.project_ref);
      if (!stagedDefinition || !currentDefinition || JSON.stringify(stagedDefinition) !== JSON.stringify(currentDefinition)) {
        return Object.freeze({ confirmed:false, authority_revision:authority.revision });
      }
      await deriveProjectGraph({ project_ref:prior.project_ref, authority, facts:currentFacts.facts });
      return Object.freeze({ confirmed:true, authority_revision:String(authority.revision).toLowerCase() });
    },
  });
  return service;
}

function beginProjectAuthoringRecovery(input, runtime) {
  return createProjectAuthoringRecoveryForRuntime(runtime).begin(input);
}

async function integrateGithubChangeset(request, runtime) {
  const options = { db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient };
  const pull = await createGithubPullRequestRoleAware({
    repo:request.repository,
    base:request.base,
    head:request.head,
    expected_base:request.expected_base,
    expected_head:request.expected_head,
    title:`project: ${request.operation} ${request.project_ref}`,
    body:'Overcenter project authoring transaction. The candidate was staged and read back at the exact head before this integration request.',
    draft:false,
  }, options);
  if (!pull?.ok) return pull;

  const inspect = await observeIntegratedCandidate(request, pull, options);
  if (!inspect?.ok || ['merged','already_merged'].includes(String(inspect?.outcome || ''))) return inspect;
  if (inspect.outcome !== 'ready') return inspect;

  return mergeProjectAuthoringCandidate(request, pull, options);
}

export const projectAuthoringFor = createProjectAuthoringWorkerBinding({
  createGraphRuntime(runtime) {
    return createGitHubProjectGraphRuntime({ db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient });
  },
  async readRepositoryDisposition(repository, runtime) {
    const store = createPostgresRepositoryDispositionStore(runtime.db);
    const row = await store.get(repository);
    if (!row) return null;
    return {
      repository:String(row.repository || '').trim(),
      disposition:String(row.disposition || '').trim().toUpperCase(),
    };
  },
  applyGithubChangeset(request, writerOptions, runtime) {
    return applyGithubChangesetRoleAware(request, { ...writerOptions, db:runtime.db, withGitHubAppApiClient:runtime.withGitHubAppApiClient });
  },
  integrateGithubChangeset,
  beginProjectAuthoringRecovery,
  deriveProjectGraph(input) {
    if (input?.authority?.derivation !== OVERCENTER_PROJECT_GRAPH_DERIVATION) throw unsupportedDerivation(input);
    return deriveOvercenterProjectGraph(input);
  },
});