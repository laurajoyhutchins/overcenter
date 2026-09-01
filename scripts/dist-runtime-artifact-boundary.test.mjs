import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCheckoutSourceAdapter } from './exact-revision-v8-verification.mjs';

const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

test('checkout source projection overlays built dist runtime files onto Hatchable root paths', async () => {
  const tracked = new Map([
    ['lib/canonical-commands.js', 'tracked compatibility copy'],
    ['public/dashboard.js', 'tracked public asset'],
  ]);
  const runGit = async (args) => {
    if (args[0] === 'rev-parse') return `${REVISION}\n`;
    if (args[0] === 'ls-tree') return `${[...tracked.keys()].join('\0')}\0`;
    if (args[0] === 'cat-file') {
      const path = String(args[2]).slice(REVISION.length + 1);
      return Buffer.from(tracked.get(path) || '', 'utf8');
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const source = await createCheckoutSourceAdapter({
    runGit,
    requireRuntimeArtifact: true,
    readRuntimeArtifactFiles: async () => [
      { path: 'dist/lib/canonical-commands.js', content: 'built artifact' },
    ],
  }).observe({ repository: 'laurajoyhutchins/overcenter', revision: REVISION });

  assert.deepEqual(
    source.files.map(({ path, content }) => ({ path, content })),
    [
      { path: 'lib/canonical-commands.js', content: 'built artifact' },
      { path: 'public/dashboard.js', content: 'tracked public asset' },
    ],
  );
});

test('verification and production workflows build dist before projecting to Hatchable', async () => {
  for (const workflow of [
    '.github/workflows/exact-revision-v8.yml',
    '.github/workflows/production-materialization.yml',
  ]) {
    const source = await readFile(new URL(`../${workflow}`, import.meta.url), 'utf8');
    const build = source.indexOf('tsc -p tsconfig.semantic.runtime.json');
    const projection = Math.max(
      source.indexOf('node scripts/exact-revision-v8-verification-http.mjs'),
      source.indexOf('node scripts/production-materialization-http.mjs'),
    );
    assert.ok(build >= 0, `${workflow} must build the runtime artifact`);
    assert.ok(projection >= 0, `${workflow} must project the runtime artifact`);
    assert.ok(build < projection, `${workflow} must build before projection`);
  }
});
