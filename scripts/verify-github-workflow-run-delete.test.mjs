import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteGitHubWorkflowRunWithGitHubApp } from '../lib/github-workflow-run-delete.js';

test('exact workflow run deletion contract exists', () => {
  assert.equal(typeof deleteGitHubWorkflowRunWithGitHubApp, 'function');
});