import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GITHUB_RELEASE_REQUIRED_FIELDS, GITHUB_RELEASE_SEMANTIC_FIELDS } from '../lib/github-release-contract.js';

const source = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('release command has one semantic contract across MCP and worker transport', async () => {
  const [mcp, worker, docs] = await Promise.all([
    source('mcp/github_release_create.js'),
    source('lib/worker-transport.js'),
    source('public/docs/github-release.md'),
  ]);

  assert.deepEqual(GITHUB_RELEASE_REQUIRED_FIELDS, GITHUB_RELEASE_SEMANTIC_FIELDS);
  for (const field of GITHUB_RELEASE_SEMANTIC_FIELDS) assert.ok(docs.includes(field), `docs omit ${field}`);
  assert.ok(mcp.includes('GITHUB_RELEASE_INPUT_SCHEMA'));
  assert.ok(mcp.includes("name:'github_release_create'") || mcp.includes("name: 'github_release_create'"));
  assert.ok(mcp.includes('github.release.create'));
  assert.ok(worker.includes('allowed: new Set(GITHUB_RELEASE_SEMANTIC_FIELDS)'));
  assert.ok(worker.includes('required: new Set(GITHUB_RELEASE_REQUIRED_FIELDS)'));
  assert.ok(worker.includes("'github.release.create'"));
});

test('release command is narrow, command-owned, and wired end to end', async () => {
  const [domain, runtime, auth, response, journal, api] = await Promise.all([
    source('lib/github-release.js'),
    source('lib/github-release-runtime.js'),
    source('lib/github-app-auth.js'),
    source('lib/command-response.js'),
    source('lib/orchestration-journal.js'),
    source('api/github-release-create.js'),
  ]);

  assert.ok(runtime.includes('createGithubReleaseWithGitHubApp'));
  assert.ok(runtime.includes("key !== 'run_id'"), 'runtime must strip correlation-only run_id before domain normalization');
  assert.ok(runtime.includes('normalizeGithubReleaseRequest(semanticInput)'), 'runtime must normalize only semantic release fields');
  assert.ok(domain.includes('createGithubRelease'));
  assert.ok(auth.includes('release: Object.freeze({ permissions: Object.freeze({ contents: "write" })'));
  assert.ok(response.includes('github.release.create'));
  assert.ok(journal.includes('github.release.create'));
  assert.ok(api.includes('github.release.create'));
  assert.doesNotMatch(domain, /release asset|generate release notes|delete release|delete tag/i);
});
