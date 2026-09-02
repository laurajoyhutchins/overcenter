import { db } from 'hatchable';
import { withGitHubAppApiClient } from './github-app-auth.js';
import { readProjectDefinitionFactsWithGitHubApp } from './project-definition-facts-reader.js';
import { resolveRepositoryBranchRoles } from './repository-branch-roles.js';
import { OVERCENTER_PROJECT_GRAPH_DERIVATION } from './overcenter-project-graph-deriver.js';
import {
  PROJECT_GRAPH_DERIVATION_DECLARATION_PATH,
  parseProjectGraphDerivationDeclaration,
} from './project-graph-derivation-discovery.js';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const API_HEADERS = Object.freeze({
  Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2026-03-10',
  'User-Agent':'Overcenter/1.0',
});

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function repositoryFromProjectRef(projectRefInput) {
  const projectRef = String(projectRefInput || '').trim();
  if (!projectRef.startsWith('github:')) {
    fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'production project graph authority requires github:owner/repo project_ref', { project_ref:projectRef || null });
  }
  const repository = projectRef.slice('github:'.length);
  if (!REPOSITORY.test(repository)) {
    fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'production project graph authority requires an exact GitHub repository coordinate', { project_ref:projectRef });
  }
  return { projectRef, repository };
}

function encodeRepository(repository) {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isGitHubAppSetupError(error) {
  if (error?.code === 'GITHUB_APP_SETUP_REQUIRED') return true;
  const message = String(error?.message || error || '');
  return /config\/get 412|declared as required but not set/i.test(message);
}

async function read(apiClient, path, query = undefined, options = {}) {
  let response;
  try {
    response = await apiClient.call('github', {
      method:'GET',
      path,
      ...(query ? { query } : {}),
      headers:API_HEADERS,
    });
  } catch (error) {
    if (error?.code === 'GITHUB_APP_SETUP_REQUIRED') throw error;
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub project graph authority read failed', { path, github_message:String(error?.message || error) });
  }
  const status = Number(response?.status || 0);
  if (options.allowNotFound === true && status === 404) return null;
  if (status !== 200) {
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub project graph authority read returned a non-success status', {
      path,
      upstream_status:status || null,
    });
  }
  return response.body;
}

function decodeFileText(body, path) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.type !== 'file') {
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub did not return an exact project graph authority file', { path });
  }
  if (body.truncated === true || String(body.encoding || '').toLowerCase() !== 'base64' || typeof body.content !== 'string') {
    fail('PROJECT_GRAPH_GITHUB_READ_INCOMPLETE', 'GitHub returned incomplete project graph authority content', { path });
  }
  let bytes;
  try {
    const binary = atob(body.content.replace(/\s+/g, ''));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub returned invalid base64 project graph authority content', { path });
  }
  if (Number.isInteger(body.size) && body.size !== bytes.length) {
    fail('PROJECT_GRAPH_GITHUB_READ_INCOMPLETE', 'GitHub project graph authority size does not match returned content', {
      path,
      expected_size:body.size,
      observed_size:bytes.length,
    });
  }
  try { return new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'Project graph authority content must be UTF-8 text', { path }); }
}

async function resolveRepositoryAuthority(projectRef, repository, withApp, managedBranch = null, options = {}) {
  try {
    return await withApp(repository, async (apiClient) => {
      const repoPath = `/repos/${encodeRepository(repository)}`;
      const repositoryBody = await read(apiClient, repoPath);
      const defaultBranch = String(repositoryBody?.default_branch || '').trim();
      if (!defaultBranch) fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'GitHub repository has no observable default branch', { repository });
      const branch = String(managedBranch || defaultBranch).trim();

      const headBody = await read(apiClient, `${repoPath}/commits/${encodeURIComponent(branch)}`);
      const revision = String(headBody?.sha || '').trim().toLowerCase();
      if (!SHA40.test(revision)) {
        fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'GitHub project authority branch did not resolve to an exact commit SHA', { repository, branch });
      }

      const declarationBody = await read(
        apiClient,
        `${repoPath}/contents/${encodePath(PROJECT_GRAPH_DERIVATION_DECLARATION_PATH)}`,
        { ref:revision },
        { allowNotFound:options.allowMissingDeclaration === true },
      );
      if (declarationBody === null) {
        return Object.freeze({
          kind:'github',
          repository,
          branch,
          revision,
          derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION,
          project_ref:projectRef,
          project_graph_declared:false,
        });
      }
      const declaration = parseProjectGraphDerivationDeclaration(decodeFileText(declarationBody, PROJECT_GRAPH_DERIVATION_DECLARATION_PATH));
      return Object.freeze({
        kind:'github',
        repository,
        branch,
        revision,
        derivation:declaration.derivation,
        project_ref:projectRef,
        ...(options.reportDeclarationState === true ? { project_graph_declared:true } : {}),
      });
    }, { permissionProfile:'project_facts' });
  } catch (error) {
    if (isGitHubAppSetupError(error)) {
      fail('GITHUB_APP_SETUP_REQUIRED', 'GitHub App setup is required for project graph authority', { repository });
    }
    throw error;
  }
}

function observationFromSettlement(row) {
  const receipt = object(row?.settle_receipt);
  const subject = object(receipt?.project_transition);
  if (!receipt || receipt.schema !== 'project-transition-lease-settlement-v1'
      || receipt.subject !== 'project_transition' || receipt.disposition !== 'completed' || !subject) {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'completed project transition settlement receipt is malformed');
  }
  return Object.freeze({
    schema:'project-transition-observation-v1',
    kind:'project_transition_confirmation',
    project_ref:String(subject.project_ref || ''),
    transition_id:String(subject.transition_id || ''),
    transition_definition_fingerprint:String(subject.transition_definition_fingerprint || ''),
    disposition:'completed',
    authority:Object.freeze({
      kind:'github',
      repository:String(subject.repository || ''),
      revision:String(subject.authority_revision || '').toLowerCase(),
      derivation:String(subject.authority_derivation || ''),
    }),
    provenance:Object.freeze({
      kind:'project_transition_settlement',
      lease_ref:String(row?.lease_ref || receipt.lease_ref || ''),
      run_id:String(row?.run_id || ''),
      settled_at:String(row?.settled_at || receipt.settled_at || ''),
    }),
  });
}

export function createGitHubProjectGraphRuntime(options = {}) {
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const definitionFactsReader = options.readProjectDefinitionFactsWithGitHubApp || readProjectDefinitionFactsWithGitHubApp;
  const dbBinding = options.db || db;
  const branchRoleResolver = options.resolveRepositoryBranchRoles
    || ((repository) => resolveRepositoryBranchRoles(repository, { db:dbBinding }));
  if (typeof withApp !== 'function' || typeof definitionFactsReader !== 'function' || typeof branchRoleResolver !== 'function' || !dbBinding || typeof dbBinding.query !== 'function') {
    fail('PROJECT_GRAPH_GITHUB_READER_UNAVAILABLE', 'GitHub project graph authority dependencies are unavailable');
  }

  return Object.freeze({
    async resolveProjectAuthority({ project_ref } = {}) {
      const { projectRef, repository } = repositoryFromProjectRef(project_ref);
      const roles = await branchRoleResolver(repository);
      const managedBranch = roles?.development_branch ? String(roles.development_branch).trim() : null;
      return resolveRepositoryAuthority(projectRef, repository, withApp, managedBranch);
    },
    async resolveProjectAuthoringAuthority({ project_ref } = {}) {
      const { projectRef, repository } = repositoryFromProjectRef(project_ref);
      const roles = await branchRoleResolver(repository);
      const managedBranch = roles?.development_branch ? String(roles.development_branch).trim() : null;
      return resolveRepositoryAuthority(projectRef, repository, withApp, managedBranch, {
        allowMissingDeclaration:true,
        reportDeclarationState:true,
      });
    },
    async readProjectFacts({ repository:repositoryInput, revision:revisionInput } = {}) {
      const repository = String(repositoryInput || '').trim();
      const revision = String(revisionInput || '').trim().toLowerCase();
      if (!REPOSITORY.test(repository) || !SHA40.test(revision)) {
        fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'exact repository and revision are required for project facts', { repository, revision });
      }
      const definitionFacts = await definitionFactsReader(
        { repository, revision },
        { withGitHubAppApiClient:withApp },
      );
      return Object.freeze({
        schema:'project-authority-facts-v1',
        repository,
        revision,
        facts:Object.freeze({ definition_facts:definitionFacts }),
      });
    },
    async readProjectObservations({ project_ref, repository:repositoryInput, revision:revisionInput, derivation:derivationInput } = {}) {
      const { projectRef, repository } = repositoryFromProjectRef(project_ref);
      const observedRepository = String(repositoryInput || '').trim();
      const revision = String(revisionInput || '').trim().toLowerCase();
      const derivation = String(derivationInput || '').trim();
      if (repository !== observedRepository || !SHA40.test(revision) || !derivation) {
        fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'exact project observation authority is required', {
          project_ref:projectRef,
          repository:observedRepository || null,
          revision:revision || null,
          derivation:derivation || null,
        });
      }
      const result = await dbBinding.query(
        `SELECT lease_id::text AS lease_ref, run_id, settled_at, settle_receipt
           FROM work_leases
          WHERE status='settled'
            AND claim_receipt->>'subject'='project_transition'
            AND settle_receipt->>'subject'='project_transition'
            AND settle_receipt->>'disposition'='completed'
            AND settle_receipt->'project_transition'->>'project_ref'=$1
          ORDER BY settled_at ASC, lease_id ASC`,
        [projectRef],
      );
      return Object.freeze((result?.rows || []).map(observationFromSettlement));
    },
  });
}
