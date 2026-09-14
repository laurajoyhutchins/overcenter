import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRuntimeArtifactSourceAdapter } from './runtime-artifact-source.mjs';

async function json(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

test('semantic runtime compilation emits generated JavaScript under dist/lib', async () => {
  const config = await json('tsconfig.semantic.runtime.json');
  assert.equal(config.compilerOptions.outDir, 'dist/lib');
});

test('portable runtime compilation emits generated JavaScript under dist/portable', async () => {
  const config = await json('tsconfig.portable-runtime.json');
  assert.equal(config.compilerOptions.outDir, 'dist/portable');
});

test('runtime artifact source projection overlays only established Hatchable runtime targets', async () => {
  const base = {
    async observe() {
      return {
        repository: 'laurajoyhutchins/overcenter',
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        files: [
          { path: 'lib/canonical-commands.js', content: 'tracked compatibility copy' },
          { path: 'public/dashboard.js', content: 'tracked public asset' },
        ],
      };
    },
  };
  const source = await createRuntimeArtifactSourceAdapter(base, {
    readRuntimeArtifactFiles: async () => [
      { path: 'dist/lib/canonical-commands.js', content: 'built artifact' },
      { path: 'dist/lib/project-graph-types.js', content: 'export {};' },
      { path: 'dist/portable/runtime/portable-runtime.js', content: 'not a Hatchable artifact' },
    ],
  }).observe({});

  assert.deepEqual(
    source.files.map(({ path, content }) => ({ path, content })),
    [
      { path: 'lib/canonical-commands.js', content: 'built artifact' },
      { path: 'public/dashboard.js', content: 'tracked public asset' },
    ],
  );
});

test('runtime artifact source projection fails closed when dist has no established Hatchable runtime targets', async () => {
  const base = { async observe() { return { files: [] }; } };
  await assert.rejects(
    createRuntimeArtifactSourceAdapter(base, {
      readRuntimeArtifactFiles: async () => [
        { path: 'dist/lib/project-graph-types.js', content: 'export {};' },
        { path: 'dist/portable/runtime/portable-runtime.js', content: 'portable only' },
      ],
    }).observe({}),
    error => error?.code === 'RUNTIME_ARTIFACT_REQUIRED',
  );
});

test('production materialization projects Hatchable runtime artifacts while exact-revision verifies the portable GCP boundary', async () => {
  const productionMaterialization = await readFile(new URL('../.github/workflows/production-materialization.yml', import.meta.url), 'utf8');
  const productionBuild = productionMaterialization.indexOf('npm run build:runtime');
  const productionProjection = productionMaterialization.indexOf('node scripts/production-materialization-dist-http.mjs');
  assert.ok(productionBuild >= 0, 'production materialization must build the Hatchable runtime artifact through npm');
  assert.ok(productionProjection >= 0, 'production materialization must project the Hatchable runtime artifact');
  assert.ok(productionBuild < productionProjection, 'production materialization must build before projection');

  const exactRevision = await readFile(new URL('../.github/workflows/exact-revision-v8.yml', import.meta.url), 'utf8');
  assert.match(exactRevision, /TARGET_REVISION/);
  assert.match(exactRevision, /git rev-parse HEAD/);
  assert.match(exactRevision, /npm run build:portable/);
  assert.match(exactRevision, /cloud-run-command-ingress-host\.test\.mjs/);
  assert.match(exactRevision, /cloud-run-target-authority\.test\.mjs/);
  assert.match(exactRevision, /github-command-issue\.test\.mjs/);
  assert.doesNotMatch(exactRevision, /HATCHABLE_TOKEN|HATCHABLE_VERIFICATION_PROJECT|exact-revision-v8-dist-verification-http|production-materialization-dist-http/);
});
