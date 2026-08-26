import { canonicalJson, sha256Text } from 'lib/canonical-json.js';

export const SOURCE_SYNC_AUTHORITY = 'github';
export const SOURCE_MATERIALIZATION_RECEIPT_PATH = 'public/.overcenter/source-materialization.json';
export const SOURCE_MATERIALIZATION_RECEIPT_SCHEMA = 'source-materialization-receipt-v1';


const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  if (path === SOURCE_MATERIALIZATION_RECEIPT_PATH) return false;
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

function normalizeRequiredText(value, field, max = 256) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) fail('SOURCE_SYNC_INVALID_COORDINATE', `${field} must be a non-empty string of at most ${max} characters.`, { field });
  return text;
}

function normalizeRepository(value, field) {
  const repo = normalizeRequiredText(value, field, 256);
  if (!REPO.test(repo)) fail('SOURCE_SYNC_INVALID_COORDINATE', `${field} must be in owner/name form.`, { field });
  return repo;
}

function normalizeBranch(value, field) {
  const branch = normalizeRequiredText(value, field, 255);
  if (/\s|\\|\.\.|@\{|\/\//.test(branch) || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.lock')) {
    fail('SOURCE_SYNC_INVALID_COORDINATE', `${field} is not a valid bounded Git branch name.`, { field });
  }
  return branch;
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
  const hatchableProject = normalizeRequiredText(input.hatchable_project, 'hatchable_project', 128);
  const githubRepository = normalizeRepository(input.github_repository, 'github_repository');
  const githubBranch = normalizeBranch(input.github_branch, 'github_branch');
  const expectedVersion = normalizeVersion(input.expected_hatchable_version, 'expected_hatchable_version');
  const observedVersion = normalizeVersion(input.observed_hatchable_version, 'observed_hatchable_version');
  const expectedHead = normalizeHead(input.expected_github_head, 'expected_github_head');
  const observedHead = normalizeHead(input.observed_github_head, 'observed_github_head');
  if (expectedVersion !== observedVersion) fail('HATCHABLE_VERSION_MISMATCH', 'Hatchable runtime version changed before source materialization.', { expected_hatchable_version: expectedVersion, actual_hatchable_version: observedVersion });
  if (expectedHead !== observedHead) fail('GITHUB_HEAD_MISMATCH', 'GitHub head changed before source materialization.', { expected_github_head: expectedHead, actual_github_head: observedHead });
  return {
    hatchable_project: hatchableProject,
    github_repository: githubRepository,
    github_branch: githubBranch,
    hatchable_version: observedVersion,
    github_head: observedHead,
  };
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

function describeRuntimeDrift(current, github) {
  const paths = new Set([...current.keys(), ...github.keys()]);
  const differences = [];
  for (const path of [...paths].sort()) {
    const runtime = current.get(path) || null;
    const authoritative = github.get(path) || null;
    if (!authoritative && runtime) {
      differences.push({ path, kind: 'stale_runtime_path', action: 'delete' });
    } else if (authoritative && !runtime) {
      differences.push({ path, kind: 'missing_runtime_path', action: 'fetch', expected_blob_sha: authoritative.sha });
    } else if (authoritative && runtime && runtime.git_blob_sha !== authoritative.sha) {
      differences.push({
        path,
        kind: 'runtime_content_mismatch',
        action: 'fetch',
        expected_blob_sha: authoritative.sha,
        actual_blob_sha: runtime.git_blob_sha,
      });
    }
  }
  return differences;
}

export async function sourceManifestSha256(recordsInput) {
  const records = [...recordsInput].sort((a, b) => a.path.localeCompare(b.path));
  return sha256Text(canonicalJson(records.map(record => ({ path: record.path, sha256: record.sha256, size: record.size }))));
}

export async function planPullSync(input = {}) {
  const coordinates = assertSourceCoordinates(input);
  const currentRecords = await materializeSourceRecords(input.hatchable_files);
  const current = recordMap(currentRecords);
  const github = normalizeGithubTree(input.github_tree);
  const drift = describeRuntimeDrift(current, github);
  const fetch = drift
    .filter(item => item.action === 'fetch')
    .map(({ path, expected_blob_sha }) => ({ path, expected_blob_sha }));
  const deletes = drift
    .filter(item => item.action === 'delete')
    .map(item => item.path);

  return {
    authority: SOURCE_SYNC_AUTHORITY,
    direction: 'github_to_runtime',
    ...coordinates,
    current_records: currentRecords,
    github_tree: [...github.values()].sort((a, b) => a.path.localeCompare(b.path)),
    runtime_drift: drift,
    fetch,
    deletes,
    outcome: drift.length ? 'materialization_required' : 'already_materialized',
  };
}

export async function materializePullPlan(plan, fetchedFilesInput = []) {
  if (!plan || plan.authority !== SOURCE_SYNC_AUTHORITY || plan.direction !== 'github_to_runtime') {
    fail('SOURCE_SYNC_INVALID_PLAN', 'materializePullPlan requires a GitHub-authoritative materialization plan.');
  }
  const fetchedFiles = Array.isArray(fetchedFilesInput) ? fetchedFilesInput : [];
  const fetchedByPath = new Map(fetchedFiles.map(file => [String(file?.path || ''), file]));
  const expectedFetch = new Map(plan.fetch.map(item => [item.path, item.expected_blob_sha]));
  if (fetchedByPath.size !== expectedFetch.size) fail('SOURCE_SYNC_FETCH_SET_MISMATCH', 'Fetched GitHub blobs do not match the materialization plan.', { expected: [...expectedFetch.keys()].sort(), actual: [...fetchedByPath.keys()].sort() });

  const target = recordMap(plan.current_records);
  for (const path of plan.deletes) target.delete(path);
  const writes = [];
  for (const [path, expectedBlobSha] of expectedFetch) {
    const raw = fetchedByPath.get(path);
    if (!raw || typeof raw.content !== 'string') fail('SOURCE_SYNC_CONTENT_REQUIRED', 'Materialization plan is missing fetched UTF-8 content.', { path });
    const actualBlobSha = await gitBlobSha(raw.content);
    if (actualBlobSha !== expectedBlobSha) fail('SOURCE_SYNC_GIT_BLOB_MISMATCH', 'Fetched GitHub content does not match the planned blob SHA.', { path, expected_blob_sha: expectedBlobSha, actual_blob_sha: actualBlobSha });
    const [record] = await materializeSourceRecords([{ path, content: raw.content }]);
    target.set(path, record);
    writes.push({ path, content: raw.content });
  }

  const targetRecords = [...target.values()].sort((a, b) => a.path.localeCompare(b.path));
  const materialized = {
    ...plan,
    writes: writes.sort((a, b) => a.path.localeCompare(b.path)),
    target_records: targetRecords,
    target_manifest_sha256: await sourceManifestSha256(targetRecords),
  };
  const receipt = createSourceMaterializationReceipt(materialized);
  return {
    ...materialized,
    source_materialization_receipt: receipt,
    generated_writes: [{ path: SOURCE_MATERIALIZATION_RECEIPT_PATH, content: sourceMaterializationReceiptContent(receipt) }],
  };
}

function normalizeSha256(value, field) {
  const hash = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) fail('SOURCE_SYNC_INVALID_RECEIPT', field + ' must be a 64-character SHA-256.', { field });
  return hash;
}

function normalizeSourcePathCount(value, field) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) fail('SOURCE_SYNC_INVALID_RECEIPT', field + ' must be a non-negative integer.', { field });
  return count;
}

function normalizeSourceMaterializationReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SOURCE_SYNC_INVALID_RECEIPT', 'Source materialization receipt must be an object.');
  const allowed = new Set(['schema', 'authority', 'direction', 'hatchable_project', 'github_repository', 'github_branch', 'github_head', 'base_hatchable_version', 'target_hatchable_version', 'target_manifest_sha256', 'source_path_count']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key)).sort();
  if (unknown.length) fail('SOURCE_SYNC_INVALID_RECEIPT', 'Source materialization receipt contains unknown fields.', { unknown });
  if (input.schema !== SOURCE_MATERIALIZATION_RECEIPT_SCHEMA) fail('SOURCE_SYNC_INVALID_RECEIPT', 'Source materialization receipt schema is invalid.', { schema: input.schema || null });
  if (input.authority !== SOURCE_SYNC_AUTHORITY || input.direction !== 'github_to_runtime') fail('SOURCE_SYNC_INVALID_RECEIPT', 'Source materialization receipt authority is invalid.');
  const baseVersion = normalizeVersion(input.base_hatchable_version, 'base_hatchable_version');
  const targetVersion = normalizeVersion(input.target_hatchable_version, 'target_hatchable_version');
  if (targetVersion !== baseVersion + 1) fail('SOURCE_SYNC_INVALID_RECEIPT', 'Source materialization receipt must target the immediate next Hatchable deployment.', { base_hatchable_version: baseVersion, target_hatchable_version: targetVersion });
  return {
    schema: SOURCE_MATERIALIZATION_RECEIPT_SCHEMA,
    authority: SOURCE_SYNC_AUTHORITY,
    direction: 'github_to_runtime',
    hatchable_project: normalizeRequiredText(input.hatchable_project, 'hatchable_project', 128),
    github_repository: normalizeRepository(input.github_repository, 'github_repository'),
    github_branch: normalizeBranch(input.github_branch, 'github_branch'),
    github_head: normalizeHead(input.github_head, 'github_head'),
    base_hatchable_version: baseVersion,
    target_hatchable_version: targetVersion,
    target_manifest_sha256: normalizeSha256(input.target_manifest_sha256, 'target_manifest_sha256'),
    source_path_count: normalizeSourcePathCount(input.source_path_count, 'source_path_count'),
  };
}

export function createSourceMaterializationReceipt(materializedPlan = {}) {
  if (!materializedPlan || materializedPlan.authority !== SOURCE_SYNC_AUTHORITY || materializedPlan.direction !== 'github_to_runtime') {
    fail('SOURCE_SYNC_INVALID_PLAN', 'Source materialization receipt requires a GitHub-authoritative materialized plan.');
  }
  if (!Array.isArray(materializedPlan.target_records) || !/^[0-9a-f]{64}$/.test(String(materializedPlan.target_manifest_sha256 || ''))) {
    fail('SOURCE_SYNC_INVALID_PLAN', 'Source materialization receipt requires a complete target source manifest.');
  }
  const baseVersion = normalizeVersion(materializedPlan.hatchable_version, 'hatchable_version');
  return normalizeSourceMaterializationReceipt({
    schema: SOURCE_MATERIALIZATION_RECEIPT_SCHEMA,
    authority: SOURCE_SYNC_AUTHORITY,
    direction: 'github_to_runtime',
    hatchable_project: materializedPlan.hatchable_project,
    github_repository: materializedPlan.github_repository,
    github_branch: materializedPlan.github_branch,
    github_head: materializedPlan.github_head,
    base_hatchable_version: baseVersion,
    target_hatchable_version: baseVersion + 1,
    target_manifest_sha256: materializedPlan.target_manifest_sha256,
    source_path_count: materializedPlan.target_records.length,
  });
}

export function sourceMaterializationReceiptContent(receiptInput) {
  return canonicalJson(normalizeSourceMaterializationReceipt(receiptInput)) + '\n';
}

function normalizeDeploymentManifest(entriesInput) {
  if (!Array.isArray(entriesInput)) fail('SOURCE_SYNC_INVALID_DEPLOYMENT', 'Hatchable deployment manifest must be an array.');
  const seen = new Set();
  const entries = [];
  for (const raw of entriesInput) {
    const path = String(raw?.path || '');
    if (path !== SOURCE_MATERIALIZATION_RECEIPT_PATH && !isSyncableSourcePath(path)) continue;
    if (seen.has(path)) fail('SOURCE_SYNC_INVALID_DEPLOYMENT', 'Hatchable deployment manifest contains a duplicate synchronized path.', { path });
    seen.add(path);
    const hash = typeof raw?.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
    const size = Number(raw?.size);
    if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) fail('SOURCE_SYNC_INVALID_DEPLOYMENT', 'Hatchable deployment manifest contains invalid file identity.', { path });
    entries.push({ path, hash, size });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifySourceMaterializationDeployment(input = {}) {
  const receipt = normalizeSourceMaterializationReceipt(input.receipt);
  const observedHead = normalizeHead(input.observed_github_head, 'observed_github_head');
  const observedVersion = normalizeVersion(input.observed_hatchable_version, 'observed_hatchable_version');
  const manifest = normalizeDeploymentManifest(input.deployment_manifest);
  const differences = [];
  if (observedHead !== receipt.github_head) differences.push({ kind: 'github_head_mismatch', expected: receipt.github_head, actual: observedHead });
  if (observedVersion !== receipt.target_hatchable_version) differences.push({ kind: 'hatchable_version_mismatch', expected: receipt.target_hatchable_version, actual: observedVersion });
  const receiptContent = sourceMaterializationReceiptContent(receipt);
  const receiptDigest = await contentDigest(receiptContent);
  const receiptEntry = manifest.find(item => item.path === SOURCE_MATERIALIZATION_RECEIPT_PATH) || null;
  if (!receiptEntry) differences.push({ kind: 'receipt_missing', path: SOURCE_MATERIALIZATION_RECEIPT_PATH });
  else if (receiptEntry.hash !== receiptDigest.sha256 || receiptEntry.size !== receiptDigest.size) differences.push({ kind: 'receipt_content_mismatch', path: SOURCE_MATERIALIZATION_RECEIPT_PATH, expected_hash: receiptDigest.sha256, actual_hash: receiptEntry.hash, expected_size: receiptDigest.size, actual_size: receiptEntry.size });
  const sourceRecords = manifest.filter(item => isSyncableSourcePath(item.path)).map(item => ({ path: item.path, sha256: item.hash, size: item.size }));
  const observedManifestSha256 = await sourceManifestSha256(sourceRecords);
  if (observedManifestSha256 !== receipt.target_manifest_sha256) differences.push({ kind: 'source_manifest_mismatch', expected: receipt.target_manifest_sha256, actual: observedManifestSha256 });
  if (sourceRecords.length !== receipt.source_path_count) differences.push({ kind: 'source_path_count_mismatch', expected: receipt.source_path_count, actual: sourceRecords.length });
  return {
    ok: differences.length === 0,
    authority: SOURCE_SYNC_AUTHORITY,
    direction: 'github_to_runtime',
    hatchable_project: receipt.hatchable_project,
    github_repository: receipt.github_repository,
    github_branch: receipt.github_branch,
    github_head: observedHead,
    hatchable_version: observedVersion,
    target_manifest_sha256: receipt.target_manifest_sha256,
    observed_manifest_sha256: observedManifestSha256,
    receipt_path: SOURCE_MATERIALIZATION_RECEIPT_PATH,
    differences,
  };
}

export async function verifyHatchableProjection(recordsInput, hatchableFilesInput) {
  const observed = await materializeSourceRecords(hatchableFilesInput);
  const expected = new Map(recordsInput.map(record => [record.path, record.sha256]));
  const actual = new Map(observed.map(record => [record.path, record.sha256]));
  const differences = [];
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  for (const path of [...paths].sort()) {
    if (!expected.has(path)) differences.push({ path, kind: 'unexpected_runtime_path' });
    else if (!actual.has(path)) differences.push({ path, kind: 'missing_runtime_path' });
    else if (expected.get(path) !== actual.get(path)) differences.push({ path, kind: 'content_mismatch', expected: expected.get(path), actual: actual.get(path) });
  }
  return { ok: differences.length === 0, differences };
}
