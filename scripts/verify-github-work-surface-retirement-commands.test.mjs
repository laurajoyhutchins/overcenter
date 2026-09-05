import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

test('GitHub work-surface retirement is exposed only as narrow typed provider-effect commands', () => {
  const pr = semanticCommandDescriptor('github.pull_request.close');
  assert.deepEqual(pr.semantic_fields, ['repo', 'pull_request', 'expected_head', 'artifact_ref', 'run_id']);
  assert.deepEqual(pr.required_fields, ['repo', 'pull_request', 'expected_head', 'artifact_ref']);
  assert.deepEqual(pr.exposure, { worker:true, mcp:false });

  const issue = semanticCommandDescriptor('github.issue.close');
  assert.deepEqual(issue.semantic_fields, ['repo', 'issue', 'artifact_ref', 'run_id']);
  assert.deepEqual(issue.required_fields, ['repo', 'issue', 'artifact_ref']);
  assert.deepEqual(issue.exposure, { worker:true, mcp:false });
});