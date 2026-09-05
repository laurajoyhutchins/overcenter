import { pathToFileURL } from 'node:url';
import { connectHatchableRemoteMcp as defaultConnectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';
import { createProductionRuntimeAdapter as defaultCreateProductionRuntimeAdapter } from './production-materialization-http.mjs';

export const PRODUCTION_RUNTIME_OBSERVATION_SCHEMA = 'production-runtime-observation-v1';

const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function reject(code, message) {
  throw Object.assign(new Error(message), { code, may_have_mutated:false });
}

function required(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value) reject('PRODUCTION_RUNTIME_OBSERVATION_INPUT_INVALID', `${name} is required`);
  return value;
}

export function productionRuntimeObservationInputFromEnv(env = process.env) {
  const repository = required(env, 'GITHUB_REPOSITORY');
  const branch = required(env, 'PRODUCTION_BRANCH');
  const revision = required(env, 'EXACT_REVISION').toLowerCase();
  const runtimeRef = required(env, 'OVERCENTER_HATCHABLE_PRODUCTION_PROJECT');
  const token = required(env, 'HATCHABLE_TOKEN');
  if (!REPOSITORY.test(repository)) reject('PRODUCTION_RUNTIME_OBSERVATION_INPUT_INVALID', 'GITHUB_REPOSITORY must be owner/repository');
  if (!SHA40.test(revision)) reject('PRODUCTION_RUNTIME_OBSERVATION_INPUT_INVALID', 'EXACT_REVISION must be an exact 40-character Git SHA');
  return Object.freeze({ token, repository, branch, revision, runtimeRef });
}

export async function runProductionRuntimeObservationHttpCli(env = process.env, deps = {}) {
  const { token, repository, branch, revision, runtimeRef } = productionRuntimeObservationInputFromEnv(env);
  const connectHatchableRemoteMcp = deps.connectHatchableRemoteMcp || defaultConnectHatchableRemoteMcp;
  const createProductionRuntimeAdapter = deps.createProductionRuntimeAdapter || defaultCreateProductionRuntimeAdapter;
  const write = deps.write || ((text) => process.stdout.write(text));
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const runtime = createProductionRuntimeAdapter({ callTool:connection.callTool });
    const observed = await runtime.inspect(runtimeRef, { repository, branch });
    const observedRevision = String(observed?.verified_revision || '').trim().toLowerCase();
    const verificationRef = String(observed?.verification_ref || '').trim();
    const deploymentVersion = Number(observed?.version);
    if (
      observedRevision !== revision
      || !SHA40.test(observedRevision)
      || !verificationRef
      || !Number.isSafeInteger(deploymentVersion)
      || deploymentVersion < 1
    ) {
      reject('PRODUCTION_RUNTIME_OBSERVATION_MISMATCH', 'current immutable Hatchable evidence does not bind the selected production revision');
    }
    const result = Object.freeze({
      ok:true,
      schema:PRODUCTION_RUNTIME_OBSERVATION_SCHEMA,
      repository,
      branch,
      revision,
      runtime_ref:runtimeRef,
      deployment_version:deploymentVersion,
      verification_ref:verificationRef,
    });
    write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionRuntimeObservationHttpCli().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok:false, error:error?.code || 'PRODUCTION_RUNTIME_OBSERVATION_FAILED', message:String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}