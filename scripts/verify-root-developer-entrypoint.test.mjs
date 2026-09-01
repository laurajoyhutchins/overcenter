import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, rootUrl), 'utf8');
}

async function json(path) {
  return JSON.parse(await text(path));
}

test('repository exposes a mundane npm developer front door', async () => {
  const packageJson = await json('package.json');
  const packageLock = await json('package-lock.json');

  assert.equal(packageJson.name, 'overcenter');
  assert.equal(packageJson.private, true);
  assert.match(packageJson.engines?.node ?? '', /22/);

  for (const script of ['test', 'build', 'dev', 'verify']) {
    assert.equal(typeof packageJson.scripts?.[script], 'string', `missing npm script: ${script}`);
    assert.ok(packageJson.scripts[script].trim(), `empty npm script: ${script}`);
  }

  assert.equal(packageJson.devDependencies?.typescript, '5.9.2');
  assert.equal(packageJson.dependencies?.pg, '8.13.1');
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.lockfileVersion, 3);
});

test('canonical npm commands resolve to tracked repository entrypoints', async () => {
  const packageJson = await json('package.json');
  const expected = {
    test: 'node scripts/test.mjs',
    build: 'node scripts/build.mjs',
    dev: 'node scripts/dev.mjs',
    verify: 'node scripts/verify.mjs',
  };
  for (const [name, command] of Object.entries(expected)) {
    assert.equal(packageJson.scripts?.[name], command);
    const scriptPath = command.split(' ').at(-1);
    await access(new URL(scriptPath, rootUrl));
  }
});

test('README presents the mundane quick start before architecture', async () => {
  const readme = await text('README.md');
  const quickStart = readme.indexOf('## Quick start');
  const architecture = readme.indexOf('## How it works');
  assert.ok(quickStart >= 0, 'README must have a Quick start section');
  assert.ok(architecture < 0 || quickStart < architecture, 'Quick start must precede architecture');
  for (const command of ['npm install', 'npm test', 'npm run dev']) {
    assert.ok(readme.includes(command), `README quick start must include ${command}`);
  }
});

test('CI consumes the root package contract instead of ad hoc dependency recipes', async () => {
  const semantic = await text('.github/workflows/semantic-kernel-types.yml');
  const exact = await text('.github/workflows/exact-revision-v8.yml');
  const production = await text('.github/workflows/production-materialization.yml');
  for (const [name, workflow] of [['semantic', semantic], ['exact', exact], ['production', production]]) {
    assert.ok(workflow.includes('npm ci'), `${name} workflow must install the canonical lockfile`);
    assert.doesNotMatch(workflow, /npx --yes --package typescript@/);
    assert.doesNotMatch(workflow, /npm install --no-save/);
  }
  assert.ok(semantic.includes('npm run typecheck'));
  assert.ok(semantic.includes('npm run build'));
  assert.ok(semantic.includes('npm run test:integration'));
  assert.ok(exact.includes('npm run build:runtime'));
  assert.ok(production.includes('npm run build:runtime'));
});

test('npm run dev composes the portable Node and Postgres runtime without Hatchable', async () => {
  const dev = await text('scripts/dev.mjs');
  const compose = await text('compose.yaml');
  assert.match(dev, /createNodePostgresRuntime/);
  assert.match(dev, /docker[',\" ]+compose/);
  assert.doesNotMatch(dev, /from ['\"]hatchable['\"]|@hatchable\//);
  assert.match(compose, /postgres:16/);
});