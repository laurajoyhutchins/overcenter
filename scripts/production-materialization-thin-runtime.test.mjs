import assert from 'node:assert/strict';
import test from 'node:test';

import { materializeProduction } from '../lib/production-materialization-operation.js';

const REVISION = '40e902e1eec442fb76d4a23e7c2469f4a5207f15';
const REPOSITORY = 'laurajoyhutchins/overcenter';

const THIN_RUNTIME_PATHS = Object.freeze([
  'api/gcp-semantic-command-dispatch.js',
  'hatchable.toml',
  'lib/github-app-auth.js',
  'lib/github-transport.js',
  'lib/github-workflow-dispatch.js',
]);

const LEGACY_RUNTIME_PATHS = Object.freeze([
  'api/worker-command.js',
  'lib/project-graph.js',
  'lib/source-sync.js',
  'mcp/project.advance.js',
  'migrations/001_portfolio_observations.sql',
  'pages/index.js',
  'public/docs/legacy.md',
]);

test('production materialization projects only the thin Hatchable transport runtime', async () => {
  const sourceFiles = [...THIN_RUNTIME_PATHS, ...LEGACY_RUNTIME_PATHS].map((path) => ({
    path,
    content: `// ${path}\n`,
  }));
  let stagedPlan = null;

  const result = await materializeProduction({ repo: REPOSITORY }, {
    resolveProductionSource: async () => ({ repository: REPOSITORY, branch: 'main', revision: REVISION }),
    observeSource: async () => ({ repository: REPOSITORY, branch: 'main', revision: REVISION, files: sourceFiles }),
    observeRuntime: async () => ({
      runtime_ref: 'hatchable:overcenter',
      version: 616,
      files: LEGACY_RUNTIME_PATHS.map((path) => ({ path, hash: '0'.repeat(64), size: 1 })),
    }),
    stageRuntime: async (plan) => { stagedPlan = plan; },
    inspectRuntimeDraft: async () => ({
      version: 616,
      files: stagedPlan.desired_files.map(({ path, hash }) => ({ path, hash })),
    }),
    deployRuntime: async (plan) => ({ runtime_ref: plan.runtime_ref, version: plan.target_version }),
    inspectImmutableDeployment: async (deployment) => ({
      ...deployment,
      files: stagedPlan.desired_files.map(({ path, hash, size }) => ({ path, hash, size })),
    }),
    verifyProduction: async () => ({ ok: true, verification_ref: 'thin-runtime-proof' }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(stagedPlan.desired_files.map(({ path }) => path), [...THIN_RUNTIME_PATHS].sort());
  assert.deepEqual(stagedPlan.deletes, [...LEGACY_RUNTIME_PATHS].sort());
  assert.equal(stagedPlan.source_path_count, THIN_RUNTIME_PATHS.length);
});