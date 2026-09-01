import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtimeSources = [
  'mutation-certainty',
  'project-authoring-command-contract',
  'project-authoring',
  'project-authoring-runtime',
  'project-authoring-github-runtime',
];

test('project authoring runtime is owned by TypeScript source through project.amend', () => {
  const config = JSON.parse(fs.readFileSync('tsconfig.semantic.runtime.json', 'utf8'));
  const included = new Set(config.include ?? []);
  const workflow = fs.readFileSync('.github/workflows/semantic-kernel-types.yml', 'utf8');

  for (const name of runtimeSources) {
    const source = `src/semantic/${name}.ts`;
    assert.equal(fs.existsSync(source), true, `${source} must be the authoritative runtime source`);
    assert.equal(included.has(source), true, `${source} must be emitted by tsconfig.semantic.runtime.json`);
    assert.match(
      workflow,
      new RegExp(`diff -u lib/${name}\\.js dist/lib/${name}\\.js`),
      `lib/${name}.js must be verified byte-for-byte against TypeScript output`,
    );
  }
});
