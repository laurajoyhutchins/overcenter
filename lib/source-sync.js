import { canonicalJson, sha256Text } from 'lib/canonical-json.js';

export const SOURCE_SYNC_PROJECT = 'proj_I6FSm85xrY7T';
export const SOURCE_SYNC_REPO = 'laurajoyhutchins/busbar';
export const SOURCE_SYNC_BRANCH = 'main';

const SHA40 = /^[0-9a-f]{40}$/;

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function contentDigest(content) {
  const bytes = new TextEncoder().encode(content);
  return {
    size: bytes.byteLength,
    sha256: bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))),
  };
}

export function isSyncableSourcePath(pathInput) {
  const path = typeof pathInput === 'string' ? pathInput : '';
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false;
  if (['hatchable.toml', 'package.json', 'seed.sql'].includes(path)) return true;
  if (/^migrations\/[^/]+\.sql$/.test(path)) return true;
  return /^(api|lib|mcp|pages|public)\/.+/.test(path);
}

export async function gitBlobSha(contentInput) {
  const content = String(contentInput);
  const bytes = new TextEncoder().encode(content);
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.byteLength);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-1', framed)));
}

function normalizeHead(value, field) {
  const head = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(head)) fail('SOURCE_SYNC_INVALID_COORDINATE', `${field} must be a full 40-character Git commit SHA.`, { field });
  return head;
}

function normalizeVersion(value, field) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) fail('SOURCE_SYNC_INVALID_COORDINATE', `${field} must be a positive integer.`, { field });
  return version;
}

export function assertSourceCoordinates(input = {}) {
  const expectedVersion = normalizeVersion(input.expected_hatchable_version, 'expected_hatchable_version');
  const observedVersion = normalizeVersion(input.observed_hatchable_version, 'observed_hatchable_version');
  const expectedHead = normalizeHead(input.expected_github_head, 'expected_github_head');
  const observedHead = normalizeHead(input.observed_github_head, 'observed_github_head');
  if (expectedVersion !== observedVersion) fail('HATCHABLE_VERSION_MISMATCH', 'Hatchable version changed before source synchronization.', { expected_hatchable_version: expectedVersion, actual_hatchable_version: observedVersion });
  if (expectedHead !== observedHead) fail('GITHUB_HEAD_MISMATCH', 'GitHub main head changed before source synchronization.', { expected_github_head: expectedHead, actual_github_head: observedHead });
  return { hatchable_version: observedVersion, github_head: observedHead };
}

export async function materializeSourceRecords(filesInput) {
  if (!Array.isArray(filesInput)) fail('SOURCE_SYNC_INVALID_OBSERVATION', 'Source files must be an array.');
  const seen = new Set();
  const records = [];
  for (const raw of filesInput) {
    const path = String(raw?.path || '');
    if (!isSyncableSourcePath(path)) continue;
    if (seen.has(path)) fail('SOURCE_SYNC_DUPLICATE_PATH', 'Source observation contains a duplicate path.', { path });
    seen.add(path);
    if (typeof raw?.content !== 'string') fail('SOURCE_SYNC_CONTENT_REQUIRED', 'Synchronized source observations require complete UTF-8 text content.', { path });
    if (raw.content.includes('\u0000')) fail('SOURCE_SYNC_BINARY_UNSUPPORTED', 'Synchronized source must be UTF-8 text.', { path });
    const digest = await contentDigest(raw.content);
    records.push({
      path,
      content: raw.content,
      size: digest.size,
      sha256: digest.sha256,
      git_blob_sha: await gitBlobSha(raw.content),
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeGithubTree(entriesInput) {
  if (!Array.isArray(entriesInput)) fail('SOURCE_SYNC_INVALID_OBSERVATION', 'GitHub tree entries must be an array.');
  const result = new Map();
  for (const raw of entriesInput) {
    const path = String(raw?.path || '');
    if (!isSyncableSourcePath(path)) continue;
    if (raw?.type === 'tree') continue;
    if ((raw?.type || 'blob') !== 'blob') fail('SOURCE_SYNC_UNSUPPORTED_GIT_ENTRY', 'A synchronized GitHub path is not a regular blob.', { path, type: raw?.type || null });
    const sha = String(raw?.sha || '').toLowerCase();
    if (!SHA40.test(sha)) fail('SOURCE_SYNC_INVALID_GIT_BLOB', 'GitHub tree entry has an invalid blob SHA.', { path });
    if (result.has(path)) fail('SOURCE_SYNC_DUPLICATE_PATH', 'GitHub tree contains a duplicate synchronized path.', { path });
    result.set(path, { path, sha, mode: String(raw?.mode || '100644') });
  }
  return result;
}

function recordMap(records) {
  return new Map(records.map(record => [record.path, record]));
}

export function diffSourceTrees(desired, existing) {
  const paths = new Set([...desired.keys(), ...existing.keys()]);
  const changes = [];
  for (const path of [...paths].sort()) {
    if (!isSyncableSourcePath(path)) continue;
    const want = desired.get(path) || null;
    const have = existing.get(path) || null;
    if (!want && have) changes.push({ path, operation: 'delete' });
    else if (want && !have) changes.push({ path, operation: 'create', content: want.content });
    else if (want && have && want.git_blob_sha !== have.sha) changes.push({ path, operation: 'update', content: want.content });
  }
  return changes;
}

export async function sourceManifestSha256(recordsInput) {
  const records = [...recordsInput].sort((a, b) => a.path.localeCompare(b.path));
  return sha256Text(canonicalJson(records.map(record => ({ path: record.path, sha256: record.sha256, size: record.size }))));
}

export async function planPushSync(input = {}) {
  const coordinates = assertSourceCoordinates(input);
  const records = await materializeSourceRecords(input.hatchable_files);
  const github = normalizeGithubTree(input.github_tree);
  const changes = diffSourceTrees(recordMap(records), github);
  return {
    direction: 'push',
    hatchable_project: SOURCE_SYNC_PROJECT,
    github_repository: SOURCE_SYNC_REPO,
    github_branch: SOURCE_SYNC_BRANCH,
    ...coordinates,
    manifest_sha256: await sourceManifestSha256(records),
    records,
    changes,
    changed_paths: changes.map(({ path, operation }) => ({ path, operation })),
    outcome: changes.length ? 'mutation_required' : 'already_synced',
  };
}

export async function planPullSync(input = {}) {
  const coordinates = assertSourceCoordinates(input);
  const currentRecords = await materializeSourceRecords(input.hatchable_files);
  const current = recordMap(currentRecords);
  const github = normalizeGithubTree(input.github_tree);
  const paths = new Set([...current.keys(), ...github.keys()]);
  const fetch = [];
  const deletes = [];
  for (const path of [...paths].sort()) {
    const have = current.get(path) || null;
    const want = github.get(path) || null;
    if (!want && have) deletes.push(path);
    else if (want && (!have || have.git_blob_sha !== want.sha)) fetch.push({ path, expected_blob_sha: want.sha });
  }
  return {
    direction: 'pull',
    hatchable_project: SOURCE_SYNC_PROJECT,
    github_repository: SOURCE_SYNC_REPO,
    github_branch: SOURCE_SYNC_BRANCH,
    ...coordinates,
    current_records: currentRecords,
    github_tree: [...github.values()].sort((a, b) => a.path.localeCompare(b.path)),
    fetch,
    deletes,
    outcome: fetch.length || deletes.length ? 'mutation_required' : 'already_synced',
  };
}

export async function materializePullPlan(plan, fetchedFilesInput = []) {
  if (!plan || plan.direction !== 'pull') fail('SOURCE_SYNC_INVALID_PLAN', 'materializePullPlan requires a pull plan.');
  const fetchedFiles = Array.isArray(fetchedFilesInput) ? fetchedFilesInput : [];
  const fetchedByPath = new Map(fetchedFiles.map(file => [String(file?.path || ''), file]));
  const expectedFetch = new Map(plan.fetch.map(item => [item.path, item.expected_blob_sha]));
  if (fetchedByPath.size !== expectedFetch.size) fail('SOURCE_SYNC_FETCH_SET_MISMATCH', 'Fetched GitHub blobs do not match the pull plan.', { expected: [...expectedFetch.keys()].sort(), actual: [...fetchedByPath.keys()].sort() });

  const target = recordMap(plan.current_records);
  for (const path of plan.deletes) target.delete(path);
  const writes = [];
  for (const [path, expectedBlobSha] of expectedFetch) {
    const raw = fetchedByPath.get(path);
    if (!raw || typeof raw.content !== 'string') fail('SOURCE_SYNC_CONTENT_REQUIRED', 'Pull plan is missing fetched UTF-8 content.', { path });
    const actualBlobSha = await gitBlobSha(raw.content);
    if (actualBlobSha !== expectedBlobSha) fail('SOURCE_SYNC_GIT_BLOB_MISMATCH', 'Fetched GitHub content does not match the planned blob SHA.', { path, expected_blob_sha: expectedBlobSha, actual_blob_sha: actualBlobSha });
    const [record] = await materializeSourceRecords([{ path, content: raw.content }]);
    target.set(path, record);
    writes.push({ path, content: raw.content });
  }

  const targetRecords = [...target.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...plan,
    writes: writes.sort((a, b) => a.path.localeCompare(b.path)),
    target_records: targetRecords,
    target_manifest_sha256: await sourceManifestSha256(targetRecords),
  };
}

export function verifyGitProjection(recordsInput, githubTreeInput) {
  const records = recordMap(recordsInput);
  const github = normalizeGithubTree(githubTreeInput);
  const differences = [];
  const paths = new Set([...records.keys(), ...github.keys()]);
  for (const path of [...paths].sort()) {
    const record = records.get(path) || null;
    const entry = github.get(path) || null;
    if (!record) differences.push({ path, kind: 'unexpected_git_path' });
    else if (!entry) differences.push({ path, kind: 'missing_git_path' });
    else if (record.git_blob_sha !== entry.sha) differences.push({ path, kind: 'blob_mismatch', expected: record.git_blob_sha, actual: entry.sha });
  }
  return { ok: differences.length === 0, differences };
}

export async function verifyHatchableProjection(recordsInput, hatchableFilesInput) {
  const observed = await materializeSourceRecords(hatchableFilesInput);
  const expected = new Map(recordsInput.map(record => [record.path, record.sha256]));
  const actual = new Map(observed.map(record => [record.path, record.sha256]));
  const differences = [];
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  for (const path of [...paths].sort()) {
    if (!expected.has(path)) differences.push({ path, kind: 'unexpected_hatchable_path' });
    else if (!actual.has(path)) differences.push({ path, kind: 'missing_hatchable_path' });
    else if (expected.get(path) !== actual.get(path)) differences.push({ path, kind: 'content_mismatch', expected: expected.get(path), actual: actual.get(path) });
  }
  return { ok: differences.length === 0, differences };
}