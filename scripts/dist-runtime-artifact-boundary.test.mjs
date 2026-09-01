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

test('verification and production workflows build dist before projecting to Hatchable', async () => {
  const expectations = [
    ['.github/workflows/exact-revision-v8.yml', 'node scripts/exact-revision-v8-dist-verification-http.mjs'],
    ['.github/workflows/production-materialization.yml', 'node scripts/production-materialization-dist-http.mjs'],
  ];
  for (const [workflow, command] of expectations) {
    const source = await readFile(new URL(`../${workflow}`, import.meta.url), 'utf8');
    const build = source.indexOf('tsc -p tsconfig.semantic.runtime.json');
    const projection = source.indexOf(command);
    assert.ok(build >= 0, `${workflow} must build the runtime artifact`);
    assert.ok(projection >= 0, `${workflow} must project the runtime artifact`);
    assert.ok(build < projection, `${workflow} must build before projection`);
  }
});
