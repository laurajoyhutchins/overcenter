import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  productionRuntimeSourceManifest,
  SOURCE_MATERIALIZATION_RECEIPT_PATH,
} from '../lib/production-materialization-operation.js';
import { createCheckoutSourceAdapter } from './exact-revision-v8-verification.mjs';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import { materializeProductionRevision } from './production-materialization.mjs';

export const PRODUCTION_MATERIALIZATION_HTTP_SCHEMA = 'production-materialization-http-v1';
export const PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS = 1100;

const SHA40 = /^[0-9a-f]{40}$/;
const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function observedVersion(info, field) {
  const version = Number(info?.current_version ?? info?.version);
  if (!Number.isSafeInteger(version) || version < 1) reject('PRODUCTION_RUNTIME_INVALID_VERSION', `${field} is invalid`);
  return version;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function immutableFiles(deployment) {
  return deployment?.file_manifest ?? deployment?.files;
}

async function verifiedProjectionEvidence(callTool, project, version, context = {}) {
  const repository = String(context.repository || '').trim();
  const branch = String(context.branch || '').trim();
  if (!repository || !branch) return null;

  let receiptRead;
  let deployment;
  try {
    receiptRead = await callTool('read_file', {
      project_id:project,
      path:SOURCE_MATERIALIZATION_RECEIPT_PATH,
    });
    deployment = await callTool('get_deployment', { project_id:project, version });
  } catch {
    return null;
  }

  const receiptContent = typeof receiptRead?.content === 'string' ? receiptRead.content : '';
  if (!receiptContent) return null;

  let receipt;
  try { receipt = JSON.parse(receiptContent); }
  catch { return null; }

  const receiptRevision = String(receipt?.github_head || '').trim().toLowerCase();
  if (
    receipt?.schema !== 'source-materialization-receipt-v1'
    || receipt?.authority !== 'github'
    || receipt?.direction !== 'github_to_runtime'
    || receipt?.hatchable_project !== project
    || receipt?.github_repository !== repository
    || receipt?.github_branch !== branch
    || !SHA40.test(receiptRevision)
    || Number(receipt?.target_hatchable_version) !== version
  ) return null;

  if (observedVersion(deployment, 'immutable production deployment version') !== version) return null;
  const files = immutableFiles(deployment);
  if (!Array.isArray(files)) return null;
  const receiptEntry = files.find(file => file?.path === SOURCE_MATERIALIZATION_RECEIPT_PATH);
  if (
    !receiptEntry
    || String(receiptEntry.hash || receiptEntry.sha256 || '').trim().toLowerCase() !== sha256(receiptContent)
    || Number(receiptEntry.size) !== Buffer.byteLength(receiptContent)
  ) return null;

  let sourceManifest;
  try { sourceManifest = await productionRuntimeSourceManifest(files); }
  catch { return null; }
  if (
    sourceManifest.sha256 !== String(receipt?.target_manifest_sha256 || '').trim().toLowerCase()
    || sourceManifest.path_count !== Number(receipt?.source_path_count)
  ) return null;

  return Object.freeze({
    verified_revision:receiptRevision,
    verification_ref:`immutable-runtime:${project}:${version}:${sourceManifest.sha256}`,
  });
}

export function createProductionRuntimeAdapter({
  callTool,
  minimumCallIntervalMs = 0,
  wait = defaultWait,
} = {}) {
  if (typeof callTool !== 'function') reject('PRODUCTION_RUNTIME_ADAPTER_INVALID', 'callTool is required');
  if (typeof wait !== 'function') reject('PRODUCTION_RUNTIME_ADAPTER_INVALID', 'wait must be a function');
  const callIntervalMs = Number(minimumCallIntervalMs);
  if (!Number.isFinite(callIntervalMs) || callIntervalMs < 0) {
    reject('PRODUCTION_RUNTIME_ADAPTER_INVALID', 'minimumCallIntervalMs must be a non-negative finite number');
  }
  let hasCalled = false;
  const pacedCallTool = async (name, args) => {
    if (hasCalled && callIntervalMs > 0) await wait(callIntervalMs);
    hasCalled = true;
    return callTool(name, args);
  };

  return {
    async inspect(project, context = {}) {
      const info = await pacedCallTool('get_project', { project_id: project });
      const listed = await pacedCallTool('list_files', { project_id: project });
      const version = observedVersion(info, 'production runtime version');
      const evidence = await verifiedProjectionEvidence(pacedCallTool, project, version, context);
      return {
        project,
        version,
        files:listed?.files,
        ...(evidence || {}),
      };
    },
    async stage({ project, revision, expected_version, writes, deletes }) {
      const before = await pacedCallTool('get_project', { project_id: project });
      if (observedVersion(before, 'production runtime version') !== Number(expected_version)) reject('PRODUCTION_RUNTIME_VERSION_MISMATCH', 'production runtime changed before staging');
      for (const path of deletes) {
        await pacedCallTool('delete_file', { project_id: project, path, reason: `Remove stale source before production materialization ${revision}` });
      }
      await pacedCallTool('write_files', {
        project_id: project,
        files: writes,
        reason: `Materialize exact production revision ${revision}`,
      });
    },
    async inspectDraft(project) {
      const info = await pacedCallTool('get_project', { project_id: project });
      const listed = await pacedCallTool('list_files', { project_id: project });
      return { project, version: observedVersion(info, 'production draft version'), files: listed?.files };
    },
    async deploy({ project, revision, expected_version }) {
      const before = await pacedCallTool('get_project', { project_id: project });
      if (observedVersion(before, 'production runtime version') !== Number(expected_version)) reject('PRODUCTION_RUNTIME_VERSION_MISMATCH', 'production runtime changed before deploy');
      const dryRun = await pacedCallTool('dry_run_deploy', { project_id: project });
      if (Array.isArray(dryRun?.errors) && dryRun.errors.length) reject('PRODUCTION_DRY_RUN_FAILED', 'production Hatchable dry-run reported deploy-blocking errors');
      await pacedCallTool('deploy', {
        project_id: project,
        intent: `Materialize promoted Overcenter revision ${revision}`,
        summary: `Materialized the exact promoted GitHub revision into the production runtime, then prepared immutable source and regression verification.`,
      });
      const after = await pacedCallTool('get_project', { project_id: project });
      const version = observedVersion(after, 'production deployed version');
      if (version !== Number(expected_version) + 1) reject('PRODUCTION_DEPLOYMENT_VERSION_MISMATCH', 'production deployment was not the immediate successor');
      return { version };
    },
    async inspectDeployment({ project, version }) {
      const deployment = await pacedCallTool('get_deployment', { project_id: project, version });
      return {
        version: Number(deployment?.version),
        files: immutableFiles(deployment),
      };
    },
    async runRegressions({ project }) {
      const response = await pacedCallTool('run_function', {
        project_id: project,
        path: '/api/verification/regressions',
        method: 'POST',
        body: {},
      });
      const body = response?.body ?? response?.result?.body ?? response;
      if (Number(response?.status ?? 200) !== 200) reject('PRODUCTION_REGRESSION_INVALID', 'production regression endpoint returned a non-success status');
      return body;
    },
  };
}

export function productionMaterializationInputFromEnv(env = process.env) {
  const token = String(env.HATCHABLE_TOKEN || '').trim();
  if (!token) reject('HATCHABLE_TOKEN_REQUIRED', 'HATCHABLE_TOKEN is required for production materialization');
  return {
    token,
    input: {
      repository: String(env.GITHUB_REPOSITORY || '').trim(),
      revision: String(env.EXACT_REVISION || env.GITHUB_SHA || '').trim().toLowerCase(),
      branch: String(env.PRODUCTION_BRANCH || env.GITHUB_REF_NAME || '').trim(),
      production_project: String(env.OVERCENTER_HATCHABLE_PRODUCTION_PROJECT || '').trim(),
    },
  };
}

export async function runProductionMaterializationHttpCli(env = process.env) {
  const { token, input } = productionMaterializationInputFromEnv(env);
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const result = await materializeProductionRevision(input, {
      source: createCheckoutSourceAdapter(),
      runtime: createProductionRuntimeAdapter({
        callTool: connection.callTool,
        minimumCallIntervalMs: PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS,
      }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionMaterializationHttpCli().then(result => {
    if (result.ok !== true) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code || 'PRODUCTION_MATERIALIZATION_FAILED', message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
