import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/gcp-authoritative-deploy.yml', import.meta.url), 'utf8');
const bootstrapWorkflow = await readFile(new URL('../.github/workflows/gcp-authoritative-deploy-branch.yml', import.meta.url), 'utf8');
const runtimeProof = await readFile(new URL('./gcp/prove-authoritative-runtime-http.sh', import.meta.url), 'utf8');

test('authoritative deployment fences the exact dev revision without requiring main lockstep', () => {
  assert.match(workflow, /refs\/heads\/dev/);
  assert.match(workflow, /ls-remote origin refs\/heads\/dev/);
  assert.doesNotMatch(workflow, /refs\/heads\/main/);
  assert.doesNotMatch(workflow, /promoted to both dev and main/);
});

test('authoritative deployment remains explicit workflow dispatch with an exact revision input', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /ref: \$\{\{ inputs\.exact_revision \}\}/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.doesNotMatch(workflow, /inputs\.exact_revision \|\| github\.sha/);
});

test('authoritative runtime acceptance binds every semantic worker call to a unique receipt identity and exact deployed revision', () => {
  assert.match(runtimeProof, /request_id="gcp-runtime-proof:\$\{GITHUB_RUN_ID:-local\}:\$\(basename "\$output" \.json\)"/);
  assert.match(runtimeProof, /x-overcenter-request-id: \$request_id/);
  assert.match(runtimeProof, /x-overcenter-expected-head: \$EXACT_REVISION/);
  assert.match(runtimeProof, /\$AUDIENCE\/api\/worker-command/);
  assert.doesNotMatch(runtimeProof, /post \/api\/worker-command/);
});

test('deployment bootstrap ingress is one-commit one-file exact-dev transport and does not depend on the runtime being replaced', () => {
  assert.match(bootstrapWorkflow, /overcenter-deploy\/\*/);
  assert.match(bootstrapWorkflow, /github\.actor == github\.repository_owner/);
  assert.match(bootstrapWorkflow, /COMMAND_FILE: \.overcenter-deploy\.json/);
  assert.match(bootstrapWorkflow, /git rev-parse HEAD\^/);
  assert.match(bootstrapWorkflow, /git rev-list --count "\$dev_head\.\.HEAD"/);
  assert.match(bootstrapWorkflow, /test "\$changed" = "\$COMMAND_FILE"/);
  assert.match(bootstrapWorkflow, /overcenter-gcp-deploy-command-v1/);
  assert.match(bootstrapWorkflow, /gcp-authoritative-deploy\.yml\/dispatches/);
  assert.match(bootstrapWorkflow, /exact_revision:\$exact_revision/);
  assert.match(bootstrapWorkflow, /\.head_sha == \$expected_head/);
  assert.match(bootstrapWorkflow, /Retire deploy branch/);
  assert.doesNotMatch(bootstrapWorkflow, /api\/worker-command/);
  assert.doesNotMatch(bootstrapWorkflow, /Hatchable|hatchable/);
});
