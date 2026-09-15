import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reconcileManifest as reconcileManifestOperation } from '../lib/manifest-reconciliation-operation.js';
import {
  productionRuntimeSourceManifest,
  SOURCE_MATERIALIZATION_RECEIPT_PATH,
} from '../lib/production-materialization-operation.js';
import { createCheckoutSourceAdapter } from './exact-revision-v8-verification.mjs';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import { materializeProductionRevision } from './production-materialization.mjs';

export const PRODUCTION_MATERIALIZATION_HTTP_SCHEMA = 'production-materialization-http-v2';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function reject(code, message) {
  throw Object.assign(new Error(message), { code, may_have_mutated:false });
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
function evidenceKey(project, version, manifest) {
  return `${project}\u0000${version}\u0000${manifest}`;
}

async function projectionEvidence(callTool, cache, request) {
  const { project, version, source_manifest_sha256:manifest } = request;
  const key = evidenceKey(project, version, manifest);
  if (cache.has(key)) return cache.get(key);

  const repository = String(request.repository || '').trim();
  const branch = String(request.branch || '').trim();
  const revision = String(request.revision || '').trim().toLowerCase();
  if (!repository || !branch || !SHA40.test(revision) || !SHA256.test(String(manifest || ''))) return null;

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
    receipt?.schema !== 'source-materialization-receipt-v2'
    || receipt?.authority !== 'github'
    || receipt?.direction !== 'github_to_runtime'
    || receipt?.hatchable_project !== project
    || receipt?.github_repository !== repository
    || receipt?.github_branch !== branch
    || receiptRevision !== revision
    || Number(receipt?.target_hatchable_version) !== version
    || String(receipt?.target_manifest_sha256 || '').trim().toLowerCase() !== manifest
    || !SHA256.test(String(receipt?.reconciliation_sha256 || '').trim().toLowerCase())
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
    sourceManifest.sha256 !== manifest
    || sourceManifest.path_count !== Number(receipt?.source_path_count)
  ) return null;

  const evidence = Object.freeze({
    verified_revision:receiptRevision,
    verification_ref:`immutable-runtime:${project}:${version}:${manifest}`,
    reconciliation_sha256:String(receipt.reconciliation_sha256).trim().toLowerCase(),
  });
  cache.set(key, evidence);
  return evidence;
}

export function createProductionRuntimeAdapter({ callTool } = {}) {
  if (typeof callTool !== 'function') reject('PRODUCTION_RUNTIME_ADAPTER_INVALID', 'callTool is required');
  const evidenceCache = new Map();

  return {
    async inspect(project) {
      const info = await callTool('get_project', { project_id:project });
      const listed = await callTool('list_files', { project_id:project });
      return {
        project,
        version:observedVersion(info, 'production runtime version'),
        files:listed?.files,
      };
    },
    async resolveEvidence(request) {
      return projectionEvidence(callTool, evidenceCache, request);
    },
    async reconcileManifest(request) {
      const result = await reconcileManifestOperation(request, {
        inspectVersion:async project => observedVersion(
          await callTool('get_project', { project_id:project }),
          'production runtime version',
        ),
        deleteFile:async (project, path) => callTool('delete_file', {
          project_id:project,
          path,
          reason:`Reconcile stale source for manifest ${request.manifest_sha256}`,
        }),
        writeFiles:async (project, writes) => callTool('write_files', {
          project_id:project,
          files:writes,
          reason:`Reconcile exact production manifest ${request.manifest_sha256}`,
        }),
        inspectDraft:async project => ({
          version:request.expected_version,
          files:(await callTool('list_files', { project_id:project }))?.files,
        }),
        dryRun:async project => callTool('dry_run_deploy', { project_id:project }),
        deploy:async project => callTool('deploy', {
          project_id:project,
          intent:`Materialize promoted Overcenter revision ${request.revision}`,
          summary:'Reconciled the exact promoted GitHub manifest behind one exact-version-fenced semantic operation.',
        }),
        inspectImmutable:async (project, version) => {
          const deployment = await callTool('get_deployment', { project_id:project, version });
          return {
            version:observedVersion(deployment, 'immutable deployment version'),
            files:immutableFiles(deployment),
          };
        },
      });
      evidenceCache.set(
        evidenceKey(request.project, result.deployment_version, request.manifest_sha256),
        Object.freeze({
          verified_revision:String(request.revision || '').trim().toLowerCase(),
          verification_ref:`immutable-runtime:${request.project}:${result.deployment_version}:${request.manifest_sha256}`,
          reconciliation_sha256:request.reconciliation_sha256,
        }),
      );
      return result;
    },
    async runRegressions({ project, repository }) {
      const repo = String(repository || '').trim();
      if (!REPOSITORY.test(repo)) reject('PRODUCTION_TRANSPORT_VERIFICATION_INVALID', 'repository must be in owner/name form');
      const response = await callTool('run_function', {
        project_id:project,
        path:'/api/gcp-semantic-command-dispatch',
        method:'POST',
        body:{
          command:'project.inspect',
          project_ref:`github:${repo}`,
          expected_head:'not-a-sha',
        },
      });
      const body = response?.body ?? response?.result?.body ?? response;
      const status = Number(response?.status ?? response?.result?.status ?? 200);
      if (
        status !== 422
        || body?.ok !== false
        || body?.error !== 'GCP_SEMANTIC_DISPATCH_INVALID'
        || body?.may_have_mutated !== false
        || !String(body?.message || '').includes('expected_head')
      ) {
        reject('PRODUCTION_TRANSPORT_VERIFICATION_FAILED', 'thin Hatchable to GCP transport boundary did not fail closed on an invalid exact head');
      }
      return Object.freeze({
        ok:true,
        schema:'regression-verification-v1',
        passed:1,
        failed:0,
        boundary:'hatchable_to_gcp',
        validation:'exact_head_fail_closed',
      });
    },
  };
}

export function productionMaterializationInputFromEnv(env = process.env) {
  const token = String(env.HATCHABLE_TOKEN || '').trim();
  if (!token) reject('HATCHABLE_TOKEN_REQUIRED', 'HATCHABLE_TOKEN is required for production materialization');
  return {
    token,
    input:{
      repository:String(env.GITHUB_REPOSITORY || '').trim(),
      revision:String(env.EXACT_REVISION || env.GITHUB_SHA || '').trim().toLowerCase(),
      branch:String(env.PRODUCTION_BRANCH || env.GITHUB_REF_NAME || '').trim(),
      production_project:String(env.OVERCENTER_HATCHABLE_PRODUCTION_PROJECT || '').trim(),
    },
  };
}

export async function runProductionMaterializationHttpCli(env = process.env) {
  const { token, input } = productionMaterializationInputFromEnv(env);
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const result = await materializeProductionRevision(input, {
      source:createCheckoutSourceAdapter(),
      runtime:createProductionRuntimeAdapter({ callTool:connection.callTool }),
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
    process.stderr.write(`${JSON.stringify({ ok:false, error:error?.code || 'PRODUCTION_MATERIALIZATION_FAILED', message:String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
