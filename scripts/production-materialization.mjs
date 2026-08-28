import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json.js';
import { canonicalizeHatchableText } from './exact-revision-v8-verification.mjs';

export const PRODUCTION_MATERIALIZATION_SCHEMA = 'production-materialization-v1';
export const SOURCE_MATERIALIZATION_RECEIPT_SCHEMA = 'source-materialization-receipt-v1';
export const SOURCE_MATERIALIZATION_RECEIPT_PATH = 'public/.overcenter/source-materialization.json';

const SHA40 = /^[0-9a-f]{40}$/;

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function byteSize(content) {
  return Buffer.byteLength(content);
}

function isSyncableSourcePath(pathInput) {
  const path = typeof pathInput === 'string' ? pathInput : '';
  if (path === SOURCE_MATERIALIZATION_RECEIPT_PATH) return false;
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false;
  if (['hatchable.toml', 'package.json', 'seed.sql'].includes(path)) return true;
  if (/^migrations\/[^/]+\.sql$/.test(path)) return true;
  return /^(api|lib|mcp|pages|public)\/.+/.test(path);
}

function normalizeRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  if (!SHA40.test(revision)) reject('INVALID_PRODUCTION_REVISION', 'production revision must be a full 40-character Git commit SHA');
  return revision;
}

function normalizeRepository(value) {
  const repository = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) reject('INVALID_PRODUCTION_REPOSITORY', 'repository must be in owner/name form');
  return repository;
}

function normalizeVersion(value, field) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) reject('INVALID_PRODUCTION_RUNTIME_VERSION', `${field} must be a positive integer`);
  return version;
}

function normalizeRuntimeFiles(filesInput) {
  if (!Array.isArray(filesInput)) reject('INVALID_PRODUCTION_RUNTIME_OBSERVATION', 'runtime files must be an array');
  return filesInput
    .filter(file => !file?.virtual && (isSyncableSourcePath(file?.path) || file?.path === SOURCE_MATERIALIZATION_RECEIPT_PATH))
    .map(file => ({
      path: String(file.path),
      hash: String(file.hash || file.sha256 || '').toLowerCase(),
      size: Number(file.size),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function desiredSourceRecords(filesInput) {
  if (!Array.isArray(filesInput)) reject('INVALID_PRODUCTION_SOURCE_OBSERVATION', 'source files must be an array');
  const seen = new Set();
  const records = [];
  for (const file of filesInput) {
    const path = String(file?.path || '');
    if (!isSyncableSourcePath(path)) continue;
    if (seen.has(path)) reject('DUPLICATE_PRODUCTION_SOURCE_PATH', `duplicate production source path: ${path}`);
    if (typeof file?.content !== 'string' || file.content.includes('\u0000')) reject('INVALID_PRODUCTION_SOURCE_CONTENT', `production source must be UTF-8 text: ${path}`);
    seen.add(path);
    const content = canonicalizeHatchableText(file.content);
    records.push({ path, content, hash: sha256(content), size: byteSize(content) });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function sourceManifestSha256(records) {
  return sha256(canonicalJson(records.map(({ path, hash, size }) => ({ path, sha256: hash, size }))));
}

function materializationReceipt({ project, repository, branch, revision, baseVersion, records }) {
  return {
    schema: SOURCE_MATERIALIZATION_RECEIPT_SCHEMA,
    authority: 'github',
    direction: 'github_to_runtime',
    hatchable_project: project,
    github_repository: repository,
    github_branch: branch,
    github_head: revision,
    base_hatchable_version: baseVersion,
    target_hatchable_version: baseVersion + 1,
    target_manifest_sha256: sourceManifestSha256(records),
    source_path_count: records.length,
  };
}

function verifyObservedMaterialization(filesInput, records, receiptContent) {
  const files = normalizeRuntimeFiles(filesInput);
  const observed = new Map(files.map(file => [file.path, file]));
  const expectedPaths = new Set(records.map(record => record.path));
  const differences = [];

  for (const record of records) {
    const file = observed.get(record.path);
    if (!file) differences.push({ path: record.path, kind: 'missing_source_path' });
    else if (file.hash !== record.hash || file.size !== record.size) differences.push({ path: record.path, kind: 'source_content_mismatch' });
  }
  for (const file of files) {
    if (isSyncableSourcePath(file.path) && !expectedPaths.has(file.path)) differences.push({ path: file.path, kind: 'unexpected_source_path' });
  }

  const receipt = observed.get(SOURCE_MATERIALIZATION_RECEIPT_PATH);
  const expectedReceiptHash = sha256(receiptContent);
  const expectedReceiptSize = byteSize(receiptContent);
  if (!receipt) differences.push({ path: SOURCE_MATERIALIZATION_RECEIPT_PATH, kind: 'receipt_missing' });
  else if (receipt.hash !== expectedReceiptHash || receipt.size !== expectedReceiptSize) differences.push({ path: SOURCE_MATERIALIZATION_RECEIPT_PATH, kind: 'receipt_content_mismatch' });

  if (differences.length) reject('PRODUCTION_MATERIALIZATION_MISMATCH', 'production runtime source does not match the staged exact revision');
  return { source_manifest_sha256: sourceManifestSha256(records) };
}

export async function materializeProductionRevision(input = {}, adapters = {}) {
  const repository = normalizeRepository(input.repository);
  const revision = normalizeRevision(input.revision);
  const branch = String(input.branch || '').trim();
  const project = String(input.production_project || '').trim();
  if (branch !== 'main') reject('INVALID_PRODUCTION_BRANCH', 'Overcenter production materialization requires branch main');
  if (!project) reject('PRODUCTION_RUNTIME_REQUIRED', 'production runtime coordinate is required');
  if (!adapters.source?.observe || !adapters.runtime?.inspect || !adapters.runtime?.stage || !adapters.runtime?.inspectDraft || !adapters.runtime?.deploy || !adapters.runtime?.inspectDeployment || !adapters.runtime?.runRegressions) {
    reject('PRODUCTION_MATERIALIZATION_ADAPTER_INVALID', 'complete source and runtime adapters are required');
  }

  const source = await adapters.source.observe({ repository, revision });
  if (source?.repository !== repository || String(source?.revision || '').toLowerCase() !== revision) reject('PRODUCTION_SOURCE_REVISION_MISMATCH', 'source observation does not match the exact production revision');
  const records = desiredSourceRecords(source.files);

  const before = await adapters.runtime.inspect(project);
  const baseVersion = normalizeVersion(before?.version, 'runtime version');
  const current = normalizeRuntimeFiles(before?.files);
  const desiredPaths = new Set(records.map(record => record.path));
  const deletes = current.filter(file => isSyncableSourcePath(file.path) && !desiredPaths.has(file.path)).map(file => file.path).sort();
  const receipt = materializationReceipt({ project, repository, branch, revision, baseVersion, records });
  const receiptContent = canonicalJson(receipt);
  const writes = records.map(({ path, content }) => ({ path, content }));
  writes.push({ path: SOURCE_MATERIALIZATION_RECEIPT_PATH, content: receiptContent });
  writes.sort((a, b) => a.path.localeCompare(b.path));

  await adapters.runtime.stage({ project, revision, expected_version: baseVersion, writes, deletes, receipt });
  const draft = await adapters.runtime.inspectDraft(project);
  if (normalizeVersion(draft?.version, 'draft version') !== baseVersion) reject('PRODUCTION_RUNTIME_VERSION_MISMATCH', 'production runtime version changed while staging');
  verifyObservedMaterialization(draft.files, records, receiptContent);

  const deployed = await adapters.runtime.deploy({ project, revision, expected_version: baseVersion });
  const deployedVersion = normalizeVersion(deployed?.version, 'deployed version');
  if (deployedVersion !== baseVersion + 1) reject('PRODUCTION_DEPLOYMENT_VERSION_MISMATCH', 'production deployment must be the immediate successor');
  const immutable = await adapters.runtime.inspectDeployment({ project, version: deployedVersion });
  if (normalizeVersion(immutable?.version, 'immutable deployment version') !== deployedVersion) reject('PRODUCTION_DEPLOYMENT_VERSION_MISMATCH', 'immutable deployment observation returned the wrong version');
  verifyObservedMaterialization(immutable.files, records, receiptContent);

  const regression = await adapters.runtime.runRegressions({ project, deployment_version: deployedVersion, revision });
  if (!regression || regression.schema !== 'regression-verification-v1') reject('PRODUCTION_REGRESSION_INVALID', 'production regressions returned an invalid schema');
  if (regression.ok !== true || Number(regression.failed || 0) !== 0) reject('PRODUCTION_REGRESSION_FAILED', 'production regressions did not pass');

  return {
    ok: true,
    schema: PRODUCTION_MATERIALIZATION_SCHEMA,
    repository,
    revision,
    branch,
    deployment_version: deployedVersion,
    source_manifest_sha256: receipt.target_manifest_sha256,
    regression,
  };
}
