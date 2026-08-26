import { createHash } from 'node:crypto';
import { withGitHubAppApiClient } from './github-app-auth.js';
import {
  PROJECT_DEFINITION_DISCOVERY_PATH,
  parseProjectDefinitionDiscovery,
} from './project-definition-discovery.js';
import { normalizeProjectDefinitionFacts } from './project-definition-facts.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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

function requireCoordinate(repositoryInput, revisionInput) {
  const repository = String(repositoryInput || '').trim();
  const revision = String(revisionInput || '').trim().toLowerCase();
  if (!REPO.test(repository) || !SHA40.test(revision)) {
    fail('PROJECT_DEFINITION_FACTS_READ_INVALID', 'repository and exact revision are required', { repository, revision });
  }
  return { repository, revision };
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
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub project definition read failed', {
      path,
      github_message:String(error?.message || error),
    });
  }
  if (Number(response?.status || 0) !== 200) {
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub project definition read returned a non-success status', {
      path,
      upstream_status:Number(response?.status || 0) || null,
    });
  }
  return response.body;
}

function decodeFile(body, path) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.type !== 'file') {
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub did not return an exact repository file', { path });
  }
  const blobSha = String(body.sha || '').trim().toLowerCase();
  if (!SHA40.test(blobSha)) {
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub returned incomplete blob identity', { path });
  }
  if (body.truncated === true || String(body.encoding || '').toLowerCase() !== 'base64' || typeof body.content !== 'string') {
    fail('PROJECT_DEFINITION_FACTS_INCOMPLETE', 'GitHub returned incomplete repository definition content', { path });
  }
  let bytes;
  try {
    bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
  } catch (error) {
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub returned invalid base64 repository content', { path });
  }
  if (Number.isInteger(body.size) && body.size !== bytes.length) {
    fail('PROJECT_DEFINITION_FACTS_INCOMPLETE', 'GitHub repository definition size does not match returned content', {
      path,
      expected_size:body.size,
      observed_size:bytes.length,
    });
  }
  const content = bytes.toString('utf8');
  if (Buffer.from(content, 'utf8').compare(bytes) !== 0) {
    fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'Project definition content must be UTF-8 text', { path });
  }
  return {
    path,
    blob_sha:blobSha,
    sha256:createHash('sha256').update(bytes).digest('hex'),
    media_type:'text/plain',
    content,
  };
}

export function createProjectDefinitionFactsReader(apiClient) {
  if (!apiClient || typeof apiClient.call !== 'function') throw new Error('A GitHub API transport is required.');

  return async function readProjectDefinitionFacts(input = {}) {
    const { repository, revision } = requireCoordinate(input.repository, input.revision);
    const repoPath = `/repos/${encodeRepository(repository)}`;
    const revisionBody = await read(apiClient, `${repoPath}/commits/${revision}`);
    if (String(revisionBody?.sha || '').toLowerCase() !== revision) {
      fail('PROJECT_DEFINITION_FACTS_READ_FAILED', 'GitHub could not attribute the requested exact revision', { repository, revision });
    }

    const discoveryBody = await read(
      apiClient,
      `${repoPath}/contents/${encodePath(PROJECT_DEFINITION_DISCOVERY_PATH)}`,
      { ref:revision },
    );
    const discoveryFile = decodeFile(discoveryBody, PROJECT_DEFINITION_DISCOVERY_PATH);
    const discovery = parseProjectDefinitionDiscovery(discoveryFile.content);

    const definitions = [];
    for (const definitionPath of discovery.definitions) {
      const body = await read(apiClient, `${repoPath}/contents/${encodePath(definitionPath)}`, { ref:revision });
      definitions.push(decodeFile(body, definitionPath));
    }

    return normalizeProjectDefinitionFacts({
      schema:'project-definition-facts-v1',
      repository,
      revision,
      definitions,
    });
  };
}

export async function readProjectDefinitionFactsWithGitHubApp(input = {}, options = {}) {
  const { repository, revision } = requireCoordinate(input.repository, input.revision);
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  if (typeof withApp !== 'function') {
    fail('PROJECT_DEFINITION_FACTS_READER_UNAVAILABLE', 'GitHub App project facts transport is unavailable', { repository });
  }
  return withApp(
    repository,
    async (apiClient) => createProjectDefinitionFactsReader(apiClient)({ repository, revision }),
    { permissionProfile:'project_facts' },
  );
}
