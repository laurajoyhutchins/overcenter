import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('github pull request mark-ready remains an advanced worker capability but is not ordinary MCP discovery', async () => {
  const descriptor = semanticCommandDescriptor('github.pull_request.mark_ready');
  assert.equal(descriptor.command, 'github.pull_request.mark_ready');
  assert.equal(descriptor.mcp_name, 'github_pull_request_mark_ready');
  assert.equal(descriptor.surface, 'advanced');
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:false });
  assert.deepEqual(descriptor.semantic_fields, ['repo', 'pull_request', 'expected_head', 'run_id']);
  assert.deepEqual(descriptor.required_fields, ['repo', 'pull_request', 'expected_head']);

  const worker = await source('lib/worker-transport.js');
  assert.match(worker, /semanticCommandDescriptor\(['"]github\.pull_request\.mark_ready['"]\)/);
  assert.match(worker, /markGithubPullRequestReadyWithGitHubApp/);

  const contract = await source('lib/github-pull-request-ready-contract.js');
  assert.match(contract, /semanticCommandDescriptor\(['"]github\.pull_request\.mark_ready['"]\)/);
  assert.match(contract, /descriptor\.input_schema/);

  const api = await source('api/github-pull-request-mark-ready.js');
  assert.match(api, /github\.pull_request\.mark_ready/);
  assert.match(api, /markGithubPullRequestReadyWithGitHubApp/);
  await assert.rejects(source('mcp/github_pull_request_mark_ready.js'), /ENOENT/);
});