import { withGitHubAppApiClient } from './github-app-auth.js';
import { readProjectDefinitionFactsWithGitHubApp } from './project-definition-facts-reader.js';
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

async function read(apiClient, path, query = undefined) {
  let response;
  try {
    response = await apiClient.call('github', {
      method:'GET',
      path,
      ...(query ? { query } : {}),
      headers:API_HEADERS,
    });
  } catch (error) {
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub project graph authority read failed', { path, github_message:String(error?.message || error) });
  }
  if (Number(response?.status || 0) !== 200) {
    fail('PROJECT_GRAPH_GITHUB_READ_FAILED', 'GitHub project graph authority read returned a non-success status', {
      path,
      upstream_status:Number(response?.status || 0) || null,
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

async function resolveDefaultBranchAuthority(projectRef, repository, withApp) {
  return withApp(repository, async (apiClient) => {
    const repoPath = `/repos/${encodeRepository(repository)}`;
    const repositoryBody = await read(apiClient, repoPath);
    const defaultBranch = String(repositoryBody?.default_branch || '').trim();
    if (!defaultBranch) fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'GitHub repository has no observable default branch', { repository });

    const headBody = await read(apiClient, `${repoPath}/commits/${encodeURIComponent(defaultBranch)}`);
    const revision = String(headBody?.sha || '').trim().toLowerCase();
    if (!SHA40.test(revision)) {
      fail('PROJECT_GRAPH_GITHUB_AUTHORITY_INVALID', 'GitHub default branch did not resolve to an exact commit SHA', { repository, default_branch:defaultBranch });
    }

    const declarationBody = await read(
      apiClient,
      `${repoPath}/contents/${encodePath(PROJECT_GRAPH_DERIVATION_DECLARATION_PATH)}`,
      { ref:revision },
    );
    const declaration = parseProjectGraphDerivationDeclaration(decodeFileText(declarationBody, PROJECT_GRAPH_DERIVATION_DECLARATION_PATH));
    return Object.freeze({
      kind:'github',
      repository,
      revision,
      derivation:declaration.derivation,
      project_ref:projectRef,
    });
  }, { permissionProfile:'project_facts' });
}

export function createGitHubProjectGraphRuntime(options = {}) {
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const definitionFactsReader = options.readProjectDefinitionFactsWithGitHubApp || readProjectDefinitionFactsWithGitHubApp;
  if (typeof withApp !== 'function' || typeof definitionFactsReader !== 'function') {
    fail('PROJECT_GRAPH_GITHUB_READER_UNAVAILABLE', 'GitHub project graph authority dependencies are unavailable');
  }

  return Object.freeze({
    async resolveProjectAuthority({ project_ref } = {}) {
      const { projectRef, repository } = repositoryFromProjectRef(project_ref);
      return resolveDefaultBranchAuthority(projectRef, repository, withApp);
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
    async readProjectObservations() {
      return Object.freeze([]);
    },
  });
}
