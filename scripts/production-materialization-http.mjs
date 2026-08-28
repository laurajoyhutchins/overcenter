import { pathToFileURL } from 'node:url';
import { createCheckoutSourceAdapter } from './exact-revision-v8-verification.mjs';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import { materializeProductionRevision } from './production-materialization.mjs';

export const PRODUCTION_MATERIALIZATION_HTTP_SCHEMA = 'production-materialization-http-v1';

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function observedVersion(info, field) {
  const version = Number(info?.current_version ?? info?.version);
  if (!Number.isSafeInteger(version) || version < 1) reject('PRODUCTION_RUNTIME_INVALID_VERSION', `${field} is invalid`);
  return version;
}

export function createProductionRuntimeAdapter({ callTool } = {}) {
  if (typeof callTool !== 'function') reject('PRODUCTION_RUNTIME_ADAPTER_INVALID', 'callTool is required');
  return {
    async inspect(project) {
      const info = await callTool('get_project', { project_id: project });
      const listed = await callTool('list_files', { project_id: project });
      return { project, version: observedVersion(info, 'production runtime version'), files: listed?.files };
    },
    async stage({ project, revision, expected_version, writes, deletes }) {
      const before = await callTool('get_project', { project_id: project });
      if (observedVersion(before, 'production runtime version') !== Number(expected_version)) reject('PRODUCTION_RUNTIME_VERSION_MISMATCH', 'production runtime changed before staging');
      for (const path of deletes) {
        await callTool('delete_file', { project_id: project, path, reason: `Remove stale source before production materialization ${revision}` });
      }
      await callTool('write_files', {
        project_id: project,
        files: writes,
        reason: `Materialize exact production revision ${revision}`,
      });
    },
    async inspectDraft(project) {
      const info = await callTool('get_project', { project_id: project });
      const listed = await callTool('list_files', { project_id: project });
      return { project, version: observedVersion(info, 'production draft version'), files: listed?.files };
    },
    async deploy({ project, revision, expected_version }) {
      const before = await callTool('get_project', { project_id: project });
      if (observedVersion(before, 'production runtime version') !== Number(expected_version)) reject('PRODUCTION_RUNTIME_VERSION_MISMATCH', 'production runtime changed before deploy');
      const dryRun = await callTool('dry_run_deploy', { project_id: project });
      if (Array.isArray(dryRun?.errors) && dryRun.errors.length) reject('PRODUCTION_DRY_RUN_FAILED', 'production Hatchable dry-run reported deploy-blocking errors');
      await callTool('deploy', {
        project_id: project,
        intent: `Materialize promoted Overcenter revision ${revision}`,
        summary: `Materialized the exact promoted GitHub revision into the production runtime, then prepared immutable source and regression verification.`,
      });
      const after = await callTool('get_project', { project_id: project });
      const version = observedVersion(after, 'production deployed version');
      if (version !== Number(expected_version) + 1) reject('PRODUCTION_DEPLOYMENT_VERSION_MISMATCH', 'production deployment was not the immediate successor');
      return { version };
    },
    async inspectDeployment({ project, version }) {
      const deployment = await callTool('get_deployment', { project_id: project, version });
      return {
        version: Number(deployment?.version),
        files: deployment?.file_manifest ?? deployment?.files,
      };
    },
    async runRegressions({ project }) {
      const response = await callTool('run_function', {
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
      runtime: createProductionRuntimeAdapter({ callTool: connection.callTool }),
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
