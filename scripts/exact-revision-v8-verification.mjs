import { createHash } from 'node:crypto';

function manifestHash(files) {
  const records = [...files.values()].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function reject(code, message) { throw Object.assign(new Error(message), { code }); }

export async function verifyExactRevisionV8(input, adapters) {
  const repository = input.repository;
  const revision = typeof input.revision === 'string' ? input.revision.toLowerCase() : '';
  const project = input.verification_project;
  if (!/^[0-9a-f]{40}$/.test(revision)) reject('INVALID_REVISION', 'revision must be a full 40-character commit SHA');
  const observed = await adapters.source.observe({ repository, revision });
  const desired = new Map(observed.files.map(file => [file.path, file]));
  const before = await adapters.runtime.inspect(project);
  const current = new Map(before.files.map(file => [file.path, file]));
  const writes = [...desired.values()].filter(file => current.get(file.path)?.sha256 !== file.sha256).map(({ path, content }) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
  const deletes = [...current.keys()].filter(path => !desired.has(path)).sort();
  await adapters.runtime.reconcile({ project, revision, expected_version: before.version, writes, deletes });
  const deployed = await adapters.runtime.deploy({ project, revision, expected_version: before.version });
  if (Number(deployed?.version) !== Number(before.version) + 1) reject('DEPLOYMENT_VERSION_MISMATCH', 'verification deployment must be the immediate next version');
  const deployment = await adapters.runtime.inspectDeployment({ project, version: deployed.version });
  const materialized = new Map(deployment.files.map(file => [file.path, file]));
  if (materialized.size !== desired.size || [...desired].some(([path, file]) => materialized.get(path)?.sha256 !== file.sha256)) {
    throw Object.assign(new Error('verification deployment source differs from requested revision'), { code: 'SOURCE_MATERIALIZATION_MISMATCH' });
  }
  const regression = await adapters.runtime.runRegressions({ project, deployment_version: deployed.version, revision });
  if (!regression || regression.ok !== true || Number(regression.failed || 0) !== 0) reject('V8_REGRESSION_FAILED', 'canonical Hatchable V8 regressions did not pass');
  return {
    schema: 'exact-revision-verification-v1', source: 'github', repository, revision,
    runtime: { project, deployment_version: deployment.version, source_manifest_sha256: manifestHash(desired) },
    regression,
  };
}
