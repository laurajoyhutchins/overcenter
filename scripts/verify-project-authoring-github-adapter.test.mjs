import test from 'node:test';
import assert from 'node:assert/strict';

test('project authoring exposes a GitHub-backed semantic adapter', async () => {
  const runtime = await import('../lib/project-authoring-github-runtime.js').catch(() => null);
  assert.ok(runtime, 'GitHub-backed project authoring adapter must exist');
  assert.equal(typeof runtime.createProjectAuthoringGithubAdapter, 'function');
});