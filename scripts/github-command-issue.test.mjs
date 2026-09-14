import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepareIssueCommand } from './github-command-issue.mjs';

const SHA = 'a'.repeat(40);

function event(body, overrides = {}) {
  return {
    action: 'opened',
    repository: { owner: { login: 'laurajoyhutchins' } },
    issue: {
      number: 901,
      title: '[overcenter-command]',
      user: { login: 'laurajoyhutchins' },
      body: JSON.stringify(body),
      ...overrides.issue,
    },
    ...overrides,
  };
}

test('prepares owner-issued project.inspect against the exact dev revision', () => {
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'project.inspect',
    project_ref: 'github:laurajoyhutchins/overcenter',
  }), SHA);
  assert.equal(result.schema, 'overcenter-github-command-prepared-v1');
  assert.equal(result.request_id, `github-issue:901:${SHA}`);
  assert.deepEqual(result.payload, {
    command: 'project.inspect',
    input: { project_ref: 'github:laurajoyhutchins/overcenter' },
    invocation_context: { run_id: `github-issue:901:${SHA}` },
  });
});

test('preserves bounded project.advance continuation fields', () => {
  const execution_result = { outcome: 'completed', evidence: ['receipt:1'] };
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'project.advance',
    project_ref: 'github:laurajoyhutchins/overcenter',
    transition_id: 'transport-independence',
    resume_ref: 'resume:abc',
    execution_result,
  }), SHA);
  assert.deepEqual(result.payload.input, {
    project_ref: 'github:laurajoyhutchins/overcenter',
    transition_id: 'transport-independence',
    resume_ref: 'resume:abc',
    execution_result,
  });
});

test('prepares owner-issued project.amend with exact authority supplied by the trusted ingress', () => {
  const amendment = {
    upsert_transitions: [{
      id: 'single-execution-transaction-authority',
      priority: 200,
      requires: [],
      executor: { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
    }],
    remove_transition_ids: [],
    confirmed_transition_ids: [],
  };
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'project.amend',
    project_ref: 'github:laurajoyhutchins/overcenter',
    amendment,
  }), SHA);
  assert.deepEqual(result.payload, {
    command: 'project.amend',
    input: {
      project_ref: 'github:laurajoyhutchins/overcenter',
      expected_revision: SHA,
      amendment,
    },
    invocation_context: { run_id: `github-issue:901:${SHA}` },
  });
});

test('prepares bounded owner-issued orchestration.diagnose without project context', () => {
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'orchestration.diagnose',
    run_id: 'run:833',
    work_ref: 'project-authoring:833',
  }), SHA);
  assert.deepEqual(result.payload, {
    command: 'orchestration.diagnose',
    input: {
      run_id: 'run:833',
      work_ref: 'project-authoring:833',
    },
    invocation_context: { run_id: `github-issue:901:${SHA}` },
  });
});

test('rejects malformed or cross-command orchestration.diagnose fields before dispatch', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose',
  }), SHA), /run_id/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'x'.repeat(513),
  }), SHA), /run_id/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'run:833', work_ref: 'x'.repeat(129),
  }), SHA), /work_ref/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'run:833', project_ref: 'github:laurajoyhutchins/overcenter',
  }), SHA), /does not accept project/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', run_id: 'run:833',
  }), SHA), /does not accept diagnose/);
});

test('rejects non-owner, stale-revision, unknown-field, and oversized amendment requests before dispatch', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter',
  }, { issue: { user: { login: 'someone-else' } } }), SHA), /repository owner/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: 'b'.repeat(40), command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter',
  }), SHA), /stale/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', surprise: true,
  }), SHA), /unknown fields/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.amend', project_ref: 'github:laurajoyhutchins/overcenter', amendment: { note: 'x'.repeat(13_000) },
  }), SHA), /amendment is too large/);
});

test('rejects command-specific fields outside their command boundary', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', transition_id: 'x',
  }), SHA), /does not accept continuation/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.advance', project_ref: 'github:laurajoyhutchins/overcenter', execution_result: { outcome: 'completed' },
  }), SHA), /requires resume_ref/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.amend', project_ref: 'github:laurajoyhutchins/overcenter', amendment: {}, transition_id: 'x',
  }), SHA), /project.amend does not accept continuation fields/);
});

test('trusted default-branch workflow invokes GCP directly and emits a sanitized issue receipt', async () => {
  const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command-issue.yml', import.meta.url), 'utf8');
  assert.match(workflow, /issues:\s*\n\s*types: \[opened\]/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/dev"/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
  assert.match(workflow, /github-command-issue\.mjs/);
  assert.match(workflow, /google-github-actions\/auth@/);
  assert.match(workflow, /\/api\/worker-command/);
  assert.doesNotMatch(workflow, /Hatchable|hatchable/i);
  assert.match(workflow, /del\(\.lease_token,\.token,\.authorization,\.id_token\)/);
  assert.match(workflow, /issues\/\$ISSUE_NUMBER\/comments/);
  assert.match(workflow, /state_reason.*completed/);
});

test('required exact-revision gate verifies the portable GCP boundary without Hatchable', async () => {
  const workflow = await readFile(new URL('../.github/workflows/exact-revision-v8.yml', import.meta.url), 'utf8');
  assert.match(workflow, /TARGET_REVISION/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /npm run build:portable/);
  assert.match(workflow, /cloud-run-command-ingress-host\.test\.mjs/);
  assert.match(workflow, /cloud-run-target-authority\.test\.mjs/);
  assert.match(workflow, /github-command-issue\.test\.mjs/);
  assert.doesNotMatch(workflow, /HATCHABLE_TOKEN|HATCHABLE_VERIFICATION_PROJECT|exact-revision-v8-dist-verification-http|Hatchable V8 runtime/);
});
