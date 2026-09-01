import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function literalProperty(text, property) {
  const match = text.match(new RegExp(`${property}\\s*:\\s*(['"])(.*?)\\1`, 's'));
  assert.ok(match, `missing static ${property}`);
  return match[2];
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

  const contract = await source('lib/github-pull-request-ready-contract.js');
  assert.match(contract, /semanticCommandDescriptor\(['"]github\.pull_request\.mark_ready['"]\)/);
  assert.match(contract, /descriptor\.input_schema/);

  const mcp = await source('mcp/github_pull_request_mark_ready.js');
  assert.equal(literalProperty(mcp, 'name'), descriptor.mcp_name);
  assert.equal(literalProperty(mcp, 'description'), descriptor.description);
  assert.match(mcp, /inputSchema\s*:\s*GITHUB_PULL_REQUEST_READY_INPUT_SCHEMA/);
  assert.match(mcp, /markGithubPullRequestReadyWithGitHubApp/);
});