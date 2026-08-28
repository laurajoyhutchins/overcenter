import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { materializeProductionRevision } from './production-materialization.mjs';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';

function manifest(writes, withSize = true) {
  return writes.map(({ path, content }) => {
    const file = { path, hash: createHash('sha256').update(content).digest('hex') };
    if (withSize) file.size = Buffer.byteLength(content);
    return file;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

test('draft verification accepts Hatchable list_files hashes without sizes while immutable verification still requires sizes', async () => {
  let writes = [];
  const result = await materializeProductionRevision(
    { repository, revision, branch: 'main', production_project: 'prod' },
    {
      source: { observe: async () => ({ repository, revision, files: [{ path: 'api/example.js', content: 'x\n' }] }) },
      runtime: {
        inspect: async () => ({ project: 'prod', version: 5, files: [] }),
        stage: async request => { writes = request.writes; },
        inspectDraft: async () => ({ project: 'prod', version: 5, files: manifest(writes, false) }),
        deploy: async () => ({ version: 6 }),
        inspectDeployment: async () => ({ version: 6, files: manifest(writes, true) }),
        runRegressions: async () => ({ ok: true, schema: 'regression-verification-v1', passed: 1, failed: 0 }),
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.deployment_version, 6);
});
