import test from 'node:test';
import assert from 'node:assert/strict';
import { runGithubReleaseTests } from '../lib/github-release.test.js';

test('semantic GitHub release behavior regression', async () => {
  const result = await runGithubReleaseTests();
  const failures = result.tests.filter((item) => !item.ok);
  assert.equal(result.ok, true, JSON.stringify(failures, null, 2));
});
