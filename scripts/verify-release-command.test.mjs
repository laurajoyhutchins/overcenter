import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('release command has one semantic contract across MCP and worker transport', async () => {
  const [mcp, worker] = await Promise.all([source('mcp/github_release_create.js'), source('lib/worker-transport.js')]);
  for (const field of ['repo','target_sha','tag_name','name','body','draft','prerelease','expected_state','idempotency_key','run_id']) {
    assert.match(mcp, new RegExp(field));
    assert.match(worker, new RegExp(field));
  }
  assert.match(mcp, /github\.release\.create/);
  assert.match(worker, /github\.release\.create/);
});

test('release command is narrow, command-owned, and wired end to end', async () => {
  const [domain, auth, response, journal, api] = await Promise.all([
    source('lib/github-release.js'), source('lib/github-app-auth.js'), source('lib/command-response.js'),
    source('lib/orchestration-journal.js'), source('api/github-release-create.js'),
  ]);
  assert.match(domain, /createGithubReleaseWithGitHubApp/);
  assert.match(auth, /release:[\s\S]*?contents:\s*["']write["']/);
  assert.match(response, /github\.release\.create/);
  assert.match(journal, /github\.release\.create/);
  assert.match(api, /github\.release\.create/);
  assert.doesNotMatch(domain, /release asset|generate release notes|delete release|delete tag/i);
});