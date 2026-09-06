import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

test('exact GitHub issue and pull-request retirement commands are narrow advanced worker capabilities', () => {
  const issue = semanticCommandDescriptor('github.issue.close');
  assert.equal(issue.surface, 'advanced');
  assert.deepEqual(issue.exposure, { worker:true, mcp:false });
  assert.deepEqual(issue.required_fields, ['repo', 'issue']);
  assert.deepEqual(issue.semantic_fields, ['repo', 'issue', 'run_id']);

  const pullRequest = semanticCommandDescriptor('github.pull_request.close');
  assert.equal(pullRequest.surface, 'advanced');
  assert.deepEqual(pullRequest.exposure, { worker:true, mcp:false });
  assert.deepEqual(pullRequest.required_fields, ['repo', 'pull_request', 'expected_head']);
  assert.deepEqual(pullRequest.semantic_fields, ['repo', 'pull_request', 'expected_head', 'run_id']);
});