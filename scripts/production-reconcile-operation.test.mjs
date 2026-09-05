import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProduction } from '../lib/production-reconcile-operation.js';

const DEV = 'a'.repeat(40);
const PROD = 'b'.repeat(40);

function verifiedRuntime(revision) {
  return {
    revision,
    verified: true,
    verification_ref: 'hatchable-deployment:506',
    deployment_version: 506,
  };
}

test('a disposable caller converges verified dev to production and runtime from repo intent alone', async () => {
  const calls = [];
  let productionHead = PROD;
  let runtime = { revision: PROD, verified: true, verification_ref: 'hatchable-deployment:505', deployment_version: 505 };

  const result = await reconcileProduction({ repo: 'laurajoyhutchins/overcenter' }, {
    resolveBranchRoles: async (repo) => {
      calls.push(['roles', repo]);
      return { development: 'dev', production: 'main' };
    },
    readBranchHeads: async () => {
      calls.push(['heads', productionHead]);
      return { development_revision: DEV, production_revision: productionHead };
    },
    verifyDevelopmentRevision: async (_repo, revision) => {
      calls.push(['verify-dev', revision]);
      return { revision, verified: true, verification_ref: 'github-actions-run:42' };
    },
    observeRuntime: async (_repo, revision) => {
      calls.push(['runtime', revision, runtime.revision]);
      return runtime;
    },
    promote: async (intent) => {
      calls.push(['promote', Object.keys(intent).sort(), DEV]);
      productionHead = DEV;
      return { ok: true, source_revision: DEV, production_revision: DEV, verification_ref: 'github-actions-run:42' };
    },
    observeMaterialization: async (_repo, revision) => {
      calls.push(['materialization', revision]);
      assert.equal(productionHead, DEV, 'materialization must not be considered before production readback proves the promoted SHA');
      runtime = verifiedRuntime(DEV);
      return { state: 'succeeded', revision: DEV, verification_ref: runtime.verification_ref, deployment_version: runtime.deployment_version };
    },
    verifyFinalState: async (_repo, revision) => {
      calls.push(['final', revision]);
      return { production_revision: productionHead, runtime: verifiedRuntime(DEV) };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'converged');
  assert.equal(result.development_revision, DEV);
  assert.equal(result.production_revision, DEV);
  assert.equal(result.runtime_revision, DEV);
  assert.equal(result.promotion_verification_ref, 'github-actions-run:42');
  assert.equal(result.runtime_verification_ref, 'hatchable-deployment:506');
  assert.equal(result.deployment_version, 506);
  assert.deepEqual(calls.find(([name]) => name === 'promote')[1], ['repo'], 'promotion receives repo intent only');
  const promoteIndex = calls.findIndex(([name]) => name === 'promote');
  const rereadIndex = calls.findIndex(([name], index) => name === 'heads' && index > promoteIndex);
  const materializationIndex = calls.findIndex(([name]) => name === 'materialization');
  assert.ok(promoteIndex >= 0 && rereadIndex > promoteIndex && materializationIndex > rereadIndex, 'promotion must be authoritatively reread before materialization is considered');
});