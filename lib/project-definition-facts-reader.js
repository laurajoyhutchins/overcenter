import { PROJECT_DEFINITION_DISCOVERY_PATH, parseProjectDefinitionDiscovery } from './project-definition-discovery.js';
import { normalizeProjectDefinitionFacts, PROJECT_DEFINITION_FACTS_SCHEMA } from './project-definition-facts.js';

function fail(message, details = null) {
  const error = new Error(message);
  error.code = 'PROJECT_DEFINITION_FACTS_READ_FAILED';
  error.details = details;
  throw error;
}

function repositoryCoordinate(value) {
  const repository = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository must be an explicit owner/name coordinate', { repository });
  return repository;
}

function exactRevision(value) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('revision must be an exact Git commit SHA', { revision });
  return revision;
}

function decodeBase64(value) {
  const source = typeof value === 'string' ? value.replace(/\s+/g, '') : '';
  if (!source) fail('GitHub content response omitted base64 content');
  try {
    return Uint8Array.from(atob(source), (char)=>char.charCodeAt(0));
  } catch (error) {
    fail('GitHub content response was not valid base64', { message:String(error?.message || error) });
  }
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal:true }).decode(bytes);
  } catch (error) {
    fail('project definition content must be valid UTF-8 text', { message:String(error?.message || error) });
  }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2, '0')).join('');
}

async function read(client, path, query = {}, options = {}) {
  const response = await client.call('github', { method:'GET', path, query });
  if (options.allowNotFound === true && response?.status === 404) return null;
  if (!response || response.status !== 200) {
    fail('GitHub exact-revision read failed', { path, status:response?.status ?? null });
  }
  return response.body;
}

function exactFile(body, path) {
  if (!body || body.type !== 'file' || typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(body.sha)) {
    fail('GitHub content response did not identify one exact file', { path });
  }
  if (body.encoding !== 'base64') fail('GitHub content response must be base64 encoded', { path, encoding:body.encoding ?? null });
  const bytes = decodeBase64(body.content);
  if (Number.isInteger(body.size) && body.size !== bytes.length) fail('GitHub content size did not match decoded bytes', { path, expected:body.size, actual:bytes.length });
  return { bytes, text:utf8(bytes), blob_sha:body.sha.toLowerCase() };
}

export function createProjectDefinitionFactsReader(client) {
  if (!client || typeof client.call !== 'function') fail('GitHub client with call() is required');
  return async function readProjectDefinitionFacts(input = {}) {
    const repository = repositoryCoordinate(input.repository);
    const revision = exactRevision(input.revision);
    const [owner, repo] = repository.split('/');
    const commit = await read(client, `/repos/${owner}/${repo}/commits/${revision}`);
    if (String(commit?.sha || '').toLowerCase() !== revision) fail('GitHub commit lookup did not confirm the requested exact revision', { repository, revision, observed:commit?.sha ?? null });

    const discoveryBody = await read(
      client,
      `/repos/${owner}/${repo}/contents/${PROJECT_DEFINITION_DISCOVERY_PATH}`,
      { ref:revision },
      { allowNotFound:true },
    );
    if (discoveryBody === null) {
      return normalizeProjectDefinitionFacts({
        schema:PROJECT_DEFINITION_FACTS_SCHEMA,
        repository,
        revision,
        definitions:[],
      });
    }

    const discoveryFile = exactFile(discoveryBody, PROJECT_DEFINITION_DISCOVERY_PATH);
    const discovery = parseProjectDefinitionDiscovery(discoveryFile.text);
    const definitions = [];
    for (const path of discovery.definitions) {
      const body = await read(client, `/repos/${owner}/${repo}/contents/${path}`, { ref:revision });
      const file = exactFile(body, path);
      definitions.push({
        path,
        blob_sha:file.blob_sha,
        sha256:await sha256(file.bytes),
        media_type:path.endsWith('.json') ? 'application/json' : 'text/plain',
        content:file.text,
      });
    }
    return normalizeProjectDefinitionFacts({
      schema:PROJECT_DEFINITION_FACTS_SCHEMA,
      repository,
      revision,
      definitions,
    });
  };
}

export async function readProjectDefinitionFactsWithGitHubApp(input = {}, dependencies = {}) {
  const repository = repositoryCoordinate(input.repository);
  let withGitHubAppApiClient = dependencies.withGitHubAppApiClient;
  if (typeof withGitHubAppApiClient !== 'function') {
    ({ withGitHubAppApiClient } = await import('./github-app-auth.js'));
  }
  if (typeof withGitHubAppApiClient !== 'function') fail('GitHub App API client binding is unavailable');
  return withGitHubAppApiClient(repository, async (client)=>createProjectDefinitionFactsReader(client)(input), {
    permissionProfile:'project_facts',
  });
}