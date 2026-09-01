import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json.js';
import {
  materializeProduction,
  SOURCE_MATERIALIZATION_RECEIPT_PATH,
} from '../lib/production-materialization-operation.js';
import { canonicalizeHatchableText } from './exact-revision-v8-verification.mjs';

export const PRODUCTION_MATERIALIZATION_SCHEMA = 'production-materialization-v1';
export const SOURCE_MATERIALIZATION_RECEIPT_SCHEMA = 'source-materialization-receipt-v1';
export { SOURCE_MATERIALIZATION_RECEIPT_PATH };

const SHA40 = /^[0-9a-f]{40}$/;

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
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
    .filter(file => !file?.virtual)
    .map(file => ({
      path: String(file?.path || ''),
      hash: String(file?.hash || file?.sha256 || '').toLowerCase(),
      size: file?.size === undefined || file?.size === null ? null : Number(file.size),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function receiptForPlan(plan, project) {
  return Object.freeze({
    schema: SOURCE_MATERIALIZATION_RECEIPT_SCHEMA,
    authority: 'github',
    direction: 'github_to_runtime',
    hatchable_project: project,
    github_repository: plan.repository,
    github_branch: plan.branch,
    github_head: plan.revision,
    base_hatchable_version: plan.base_version,
    target_hatchable_version: plan.target_version,
    target_manifest_sha256: plan.source_manifest_sha256,
    source_path_count: plan.source_path_count,
  });
}

function receiptMatches(files, content) {
  const entry = normalizeRuntimeFiles(files).find(file => file.path === SOURCE_MATERIALIZATION_RECEIPT_PATH);
  if (!entry) return false;
  return entry.hash === sha256(content) && entry.size === Buffer.byteLength(content);
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

  let receiptContent = null;
  let immutableFiles = null;
  let regression = null;

  const result = await materializeProduction({ repo:repository }, {
    resolveProductionSource: async repo => ({ repository:repo, branch, revision }),
    observeSource: async coordinate => {
      const source = await adapters.source.observe({ repository:coordinate.repository, revision:coordinate.revision });
      if (source?.repository !== repository || String(source?.revision || '').trim().toLowerCase() !== revision) {
        reject('PRODUCTION_SOURCE_REVISION_MISMATCH', 'source observation does not match the exact production revision');
      }
      return { ...coordinate, files:source.files };
    },
    normalizeSourceContent: file => canonicalizeHatchableText(file.content),
    observeRuntime: async () => {
      const before = await adapters.runtime.inspect(project);
      return {
        runtime_ref:project,
        version:normalizeVersion(before?.version, 'runtime version'),
        files:normalizeRuntimeFiles(before?.files),
        verified_revision:before?.verified_revision ?? null,
        verification_ref:before?.verification_ref ?? null,
      };
    },
    stageRuntime: async plan => {
      const receipt = receiptForPlan(plan, project);
      receiptContent = canonicalJson(receipt);
      const writes = [...plan.writes, { path:SOURCE_MATERIALIZATION_RECEIPT_PATH, content:receiptContent }]
        .sort((left, right) => left.path.localeCompare(right.path));
      await adapters.runtime.stage({
        project,
        revision:plan.revision,
        expected_version:plan.base_version,
        writes,
        deletes:plan.deletes,
        receipt,
      });
    },
    inspectRuntimeDraft: async () => {
      const draft = await adapters.runtime.inspectDraft(project);
      return { runtime_ref:project, version:normalizeVersion(draft?.version, 'draft version'), files:normalizeRuntimeFiles(draft?.files) };
    },
    deployRuntime: async plan => {
      const deployed = await adapters.runtime.deploy({ project, revision:plan.revision, expected_version:plan.base_version });
      return { runtime_ref:project, version:normalizeVersion(deployed?.version, 'deployed version') };
    },
    inspectImmutableDeployment: async deployment => {
      const immutable = await adapters.runtime.inspectDeployment({ project, version:deployment.version });
      immutableFiles = immutable?.files;
      return { runtime_ref:project, version:normalizeVersion(immutable?.version, 'immutable deployment version'), files:normalizeRuntimeFiles(immutable?.files) };
    },
    verifyProduction: async request => {
      if (typeof receiptContent !== 'string' || !receiptMatches(immutableFiles, receiptContent)) {
        return { ok:false, verification_ref:'' };
      }
      regression = await adapters.runtime.runRegressions({ project, deployment_version:request.version, revision:request.revision });
      const ok = regression?.schema === 'regression-verification-v1' && regression?.ok === true && Number(regression?.failed || 0) === 0;
      return {
        ok,
        verification_ref:ok ? `runtime-deployment:${request.runtime_ref}:${request.version}:${request.source_manifest_sha256}` : '',
      };
    },
  });

  return Object.freeze({
    ok:true,
    schema:PRODUCTION_MATERIALIZATION_SCHEMA,
    outcome:result.outcome,
    repository:result.repository,
    revision:result.revision,
    branch:result.branch,
    deployment_version:result.deployment_version,
    source_manifest_sha256:result.source_manifest_sha256,
    verification_ref:result.verification_ref,
    regression,
  });
}
