import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('github pull request mark-ready is one descriptor-backed advanced worker command', async () => {
  const descriptor = semanticCommandDescriptor('github.pull_request.mark_ready');
  assert.equal(descriptor.command, 'github.pull_request.mark_ready');
  assert.equal(descriptor.mcp_name, 'github_pull_request_mark_ready');
  assert.equal(descriptor.surface, 'advanced');
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
  assert.deepEqual(descriptor.semantic_fields, ['repo', 'pull_request', 'expected_head', 'run_id']);
  assert.deepEqual(descriptor.required_fields, ['repo', 'pull_request', 'expected_head']);

  const worker = await source('lib/worker-transport.js');
  assert.match(worker, /semanticCommandDescriptor\(['"]github\.pull_request\.mark_ready['"]\)/);
  assert.match(worker, /markGithubPullRequestReadyWithGitHubApp/);

  const mcp = await source('mcp/github_pull_request_mark_ready.js');
  assert.match(mcp, /semanticCommandDescriptor\(['"]github\.pull_request\.mark_ready['"]\)/);
  assert.match(mcp, /markGithubPullRequestReadyWithGitHubApp/);
});