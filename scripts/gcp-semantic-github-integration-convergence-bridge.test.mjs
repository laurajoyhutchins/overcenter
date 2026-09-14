import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';
import { validateSemanticWorkerCommand } from '../lib/worker-transport.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const worker = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

test('github.integration.reconcile is a bounded internal semantic worker command', () => {
  const descriptor = semanticCommandDescriptor('github.integration.reconcile');
  assert.deepEqual(descriptor.semantic_fields, ['repo', 'pull_request', 'expected_head', 'run_id']);
  assert.deepEqual(descriptor.required_fields, ['repo', 'pull_request', 'expected_head']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:false });

  const request = { repo:'owner/repo', pull_request:7, expected_head:HEAD, run_id:'run-1' };
  assert.deepEqual(validateSemanticWorkerCommand('github.integration.reconcile', request), request);
  assert.throws(
    () => validateSemanticWorkerCommand('github.integration.reconcile', { ...request, merge_request_uuid:'caller-owned' }),
    /unsupported fields/,
  );
  assert.throws(
    () => validateSemanticWorkerCommand('github.integration.reconcile', { ...request, accepted_head:HEAD }),
    /unsupported fields/,
  );
});

test('worker transport delegates integration intent to durable convergence rather than the one-shot engine', () => {
  assert.match(worker, /createGithubIntegrationConvergenceForRuntime/);
  assert.match(worker, /githubIntegrationConvergenceFor/);
  assert.match(worker, /'github\.integration\.reconcile'/);
  assert.match(worker, /\.converge\(request\)/);
  assert.doesNotMatch(worker, /'github\.integration\.reconcile'[\s\S]{0,500}merge_request_uuid/);
});

test('bounded GCP broker admits only initial GitHub integration convergence intent', () => {
  assert.match(broker, /GITHUB_INTEGRATION_COMMANDS = new Set\(\[[^\]]*'github\.integration\.reconcile'/);
  assert.match(broker, /GITHUB_INTEGRATION_RECONCILE_INPUT_FIELDS = new Set\(\['repo', 'pull_request', 'expected_head', 'run_id'\]\)/);
  assert.match(broker, /normalizeGitHubIntegrationInput\(command, value\)/);
  assert.match(broker, /github\.integration\.reconcile/);
  assert.match(broker, /pull_request/);
  assert.match(broker, /expected_head/);
  assert.doesNotMatch(broker, /GITHUB_INTEGRATION_RECONCILE_INPUT_FIELDS[^\n]*merge_request_uuid/);
  assert.doesNotMatch(broker, /GITHUB_INTEGRATION_RECONCILE_INPUT_FIELDS[^\n]*accepted_head/);
});

test('GCP workflow validates exact integration intent and forwards it to authoritative worker command', () => {
  assert.match(workflow, /- github\.integration\.reconcile/);
  assert.match(workflow, /github\.integration\.reconcile\)/);
  assert.match(workflow, /\.pull_request \| type == "number"/);
  assert.match(workflow, /\.expected_head \| type == "string" and test\("\^\[0-9a-f\]\{40\}\$"\)/);
  assert.match(workflow, /keys - \["expected_head","pull_request","repo","run_id"\]/);
  assert.match(workflow, /github\.integration\.reconcile[^\n]*input="\$command_input_json"/);
  assert.doesNotMatch(workflow, /merge_request_uuid/);
  assert.doesNotMatch(workflow, /accepted_head/);
});
