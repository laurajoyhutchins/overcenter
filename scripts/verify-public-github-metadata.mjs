import { pathToFileURL } from 'node:url';
import { detectSecretPatterns } from './public-release-rules.mjs';

const INSTALLATION_METADATA_RULES = Object.freeze([
  ['hatchable_project_id', /\bproj_[A-Za-z0-9]{12}\b/],
  ['github_app_client_id', /\bIv23[A-Za-z0-9]{16,}\b/],
  ['github_app_registration_id', /\bGitHub App ID\s+\d+\b/i],
  ['repository_numeric_id', /\brepository ID\s+\d+\b/i],
  ['linear_work_id', /\bLJH-\d+\b/],
]);

const OWNER_REPOSITORY_PATTERN = /\blaurajoyhutchins\/([A-Za-z0-9_.-]+)\b/g;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export function detectMetadataTextViolations(textInput) {
  const text = String(textInput ?? '');
  return [
    ...INSTALLATION_METADATA_RULES
      .filter(([, pattern]) => pattern.test(text))
      .map(([rule]) => ({ rule })),
    ...detectSecretPatterns(text).map(({ rule }) => ({ rule })),
  ];
}

export function extractOwnerRepositoryCoordinates(textInput) {
  const text = String(textInput ?? '');
  const coordinates = new Set();
  for (const match of text.matchAll(OWNER_REPOSITORY_PATTERN)) {
    coordinates.add(`laurajoyhutchins/${match[1]}`);
  }
  return [...coordinates].sort();
}

function parseParentNumber(urlInput) {
  const match = /\/(?:issues|pulls)\/(\d+)$/.exec(String(urlInput || ''));
  return match ? Number(match[1]) : null;
}

function appendPage(path, page) {
  return `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`;
}

function requestHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'Overcenter-Public-Metadata-Verification/1.0',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubResponse(path, fetchImpl = fetch) {
  return fetchImpl(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    headers: requestHeaders(),
  });
}

async function githubJson(path, fetchImpl = fetch) {
  const response = await githubResponse(path, fetchImpl);
  if (!response.ok) {
    throw new Error(`GitHub metadata request failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function listAll(path, fetchImpl = fetch) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubJson(appendPage(path, page), fetchImpl);
    if (!Array.isArray(batch)) throw new Error('GitHub metadata collection response was not an array');
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new Error(`GitHub metadata collection exceeded ${MAX_PAGES} pages`);
}

function record(surface, resourceId, body, parentNumber = null) {
  return {
    surface,
    resource_id: resourceId ?? null,
    parent_number: parentNumber,
    body: String(body ?? ''),
  };
}

export async function collectMetadataRecords(repository, fetchImpl = fetch) {
  const prefix = `/repos/${repository}`;
  const [issues, issueComments, reviewComments, commitComments, releases] = await Promise.all([
    listAll(`${prefix}/issues?state=all`, fetchImpl),
    listAll(`${prefix}/issues/comments`, fetchImpl),
    listAll(`${prefix}/pulls/comments`, fetchImpl),
    listAll(`${prefix}/comments`, fetchImpl),
    listAll(`${prefix}/releases`, fetchImpl),
  ]);

  return [
    ...issues.map(item => record(
      item.pull_request ? 'pull_request' : 'issue',
      item.number,
      item.body,
      item.number,
    )),
    ...issueComments.map(item => record(
      'issue_comment',
      item.id,
      item.body,
      parseParentNumber(item.issue_url),
    )),
    ...reviewComments.map(item => record(
      'pull_request_review_comment',
      item.id,
      item.body,
      parseParentNumber(item.pull_request_url),
    )),
    ...commitComments.map(item => record(
      'commit_comment',
      item.id,
      item.body,
      null,
    )),
    ...releases.map(item => record(
      'release',
      item.id,
      [item.name, item.body].filter(Boolean).join('\n'),
      null,
    )),
  ];
}

function sanitizedFinding(source, rule) {
  return {
    surface: source.surface,
    resource_id: source.resource_id,
    ...(source.parent_number == null ? {} : { parent_number: source.parent_number }),
    rule,
  };
}

async function repositoryIsPublic(coordinate, currentRepository, fetchImpl = fetch) {
  if (coordinate === currentRepository || coordinate === 'laurajoyhutchins/busbar') return true;
  const [owner, repo] = coordinate.split('/');
  const response = await githubResponse(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, fetchImpl);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub repository visibility request failed with HTTP ${response.status}`);
  const body = await response.json();
  return body?.private === false && body?.visibility !== 'private';
}

export async function verifyPublicGithubMetadata({
  repository = process.env.PUBLIC_METADATA_REPOSITORY || process.env.GITHUB_REPOSITORY,
  fetchImpl = fetch,
} = {}) {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('PUBLIC_METADATA_REPOSITORY or GITHUB_REPOSITORY must be owner/repo');
  }

  const records = await collectMetadataRecords(repository, fetchImpl);
  const findings = [];
  const visibilityCache = new Map();

  for (const source of records) {
    for (const { rule } of detectMetadataTextViolations(source.body)) {
      findings.push(sanitizedFinding(source, rule));
    }

    for (const coordinate of extractOwnerRepositoryCoordinates(source.body)) {
      let isPublic = visibilityCache.get(coordinate);
      if (isPublic === undefined) {
        isPublic = await repositoryIsPublic(coordinate, repository, fetchImpl);
        visibilityCache.set(coordinate, isPublic);
      }
      if (!isPublic) findings.push(sanitizedFinding(source, 'non_public_repository_coordinate'));
    }
  }

  return {
    ok: findings.length === 0,
    repository,
    records_scanned: records.length,
    findings,
  };
}

async function main() {
  let result;
  try {
    result = await verifyPublicGithubMetadata();
  } catch (error) {
    result = {
      ok: false,
      findings: [{ rule: 'metadata_verification_execution_failed', message: String(error?.message || error) }],
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) await main();
