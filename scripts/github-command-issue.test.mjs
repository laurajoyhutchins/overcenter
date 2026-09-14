import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepareIssueCommand } from './github-command-issue.mjs';

const SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const REQUEST_ID = `github-issue:901:${SHA}`;
const CORRELATION = { origin:'operator', reasoning_boundary_id:REQUEST_ID };

function event(body, overrides = {}) {
  return {
    action: 'opened',
    repository: { name:'overcenter', full_name:'laurajoyhutchins/overcenter', owner: { login: 'laurajoyhutchins' } },
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

test('prepares owner-issued project.inspect against the exact dev revision without inventing a run identity', () => {
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'project.inspect',
    project_ref: 'github:laurajoyhutchins/overcenter',
  }), SHA);
  assert.equal(result.schema, 'overcenter-github-command-prepared-v1');
  assert.equal(result.request_id, REQUEST_ID);
  assert.deepEqual(result.payload, {
    command: 'project.inspect',
    input: { project_ref: 'github:laurajoyhutchins/overcenter' },
    invocation_context: CORRELATION,
  });
});

test('preserves bounded project.advance continuation fields and uses only a real continuation run identity', () => {
  const execution_result = { outcome: 'completed', evidence: ['receipt:1'] };
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'project.advance',
    project_ref: 'github:laurajoyhutchins/overcenter',
    transition_id: 'transport-independence',
    resume_ref: 'resume:abc',
    run_id: 'run:abc',
    execution_result,
  }), SHA);
  assert.deepEqual(result.payload.input, {
    project_ref: 'github:laurajoyhutchins/overcenter',
    transition_id: 'transport-independence',
    resume_ref: 'resume:abc',
    execution_result,
  });
  assert.deepEqual(result.payload.invocation_context, { ...CORRELATION, run_id:'run:abc' });
});

test('prepares owner-issued project.amend with independent target authority and correlation but no synthetic run identity', () => {
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
    expected_revision: TARGET_SHA,
    amendment,
  }), SHA);
  assert.deepEqual(result.payload, {
    command: 'project.amend',
    input: {
      project_ref: 'github:laurajoyhutchins/overcenter',
      expected_revision: TARGET_SHA,
      amendment,
    },
    invocation_context: CORRELATION,
  });
});

test('prepares bounded owner-issued orchestration.diagnose with the actual durable run identity', () => {
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
    invocation_context: { ...CORRELATION, run_id:'run:833' },
  });
});

test('prepares only lease-scoped repository mutation inputs through the issue ingress without inventing a run identity', () => {
  const input = {
    lease_ref: 'lease:abc',
    replacements: [{ path:'README.md', old:'before', new_text:'after', expected_count:1 }],
    commit_message: 'fix: bounded repair',
  };
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'github.apply_text_replacements',
    input,
  }), SHA);
  assert.deepEqual(result.payload, {
    command: 'github.apply_text_replacements',
    input,
    invocation_context: CORRELATION,
  });
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'github.apply_text_replacements',
    input: { replacements: [], commit_message:'missing lease' },
  }), SHA), /lease_ref/);
});

test('prepares same-repository exact-dev workflow dispatch through the canonical worker command', () => {
  const input = {
    repo:'laurajoyhutchins/overcenter',
    workflow:'gcp-authoritative-deploy.yml',
    ref:'dev',
    expected_head:SHA,
    inputs:{ exact_revision:SHA },
  };
  const result = prepareIssueCommand(event({
    schema:'overcenter-github-command-v1',
    expected_head:SHA,
    command:'github.workflow.dispatch',
    input,
  }), SHA);
  assert.deepEqual(result.payload, {
    command:'github.workflow.dispatch',
    input,
    invocation_context:CORRELATION,
  });
  assert.throws(() => prepareIssueCommand(event({
    schema:'overcenter-github-command-v1', expected_head:SHA,
    command:'github.workflow.dispatch',
    input:{ ...input, repo:'laurajoyhutchins/other' },
  }), SHA), /same repository/);
  assert.throws(() => prepareIssueCommand(event({
    schema:'overcenter-github-command-v1', expected_head:SHA,
    command:'github.workflow.dispatch',
    input:{ ...input, ref:'main' },
  }), SHA), /dev/);
  assert.throws(() => prepareIssueCommand(event({
    schema:'overcenter-github-command-v1', expected_head:SHA,
    command:'github.workflow.dispatch',
    input:{ ...input, expected_head:'b'.repeat(40) },
  }), SHA), /exact authority/);
});

test('lease mutation ingress rejects project and continuation authority smuggling', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA,
    command: 'github.apply_changeset', input: { lease_ref:'lease:abc', changes:[], commit_message:'x' },
    project_ref: 'github:laurajoyhutchins/overcenter',
  }), SHA), /bounded input envelope/);
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1', expected_head: SHA,
    command: 'github.apply_changeset', input: { lease_ref:'lease:abc', changes:[], commit_message:'x' },
    resume_ref: 'resume:x',
  }), SHA), /bounded input envelope/);
});

test('rejects malformed or cross-command orchestration.diagnose fields before dispatch', () => {
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose' }), SHA), /run_id/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'x'.repeat(513) }), SHA), /run_id/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'run:833', work_ref: 'x'.repeat(129) }), SHA), /work_ref/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'orchestration.diagnose', run_id: 'run:833', project_ref: 'github:laurajoyhutchins/overcenter' }), SHA), /does not accept project/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', run_id: 'run:833' }), SHA), /does not accept diagnose/);
});

test('rejects non-owner, stale-revision, unknown-field, and oversized amendment requests before dispatch', () => {
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter' }, { issue: { user: { login: 'someone-else' } } }), SHA), /repository owner/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: 'b'.repeat(40), command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter' }), SHA), /stale/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', surprise: true }), SHA), /unknown fields/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.amend', project_ref: 'github:laurajoyhutchins/overcenter', amendment: { note: 'x'.repeat(13_000) } }), SHA), /amendment is too large/);
});

test('rejects command-specific fields outside their command boundary', () => {
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.inspect', project_ref: 'github:laurajoyhutchins/overcenter', transition_id: 'x' }), SHA), /does not accept continuation/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.advance', project_ref: 'github:laurajoyhutchins/overcenter', execution_result: { outcome: 'completed' } }), SHA), /requires resume_ref/);
  assert.throws(() => prepareIssueCommand(event({ schema: 'overcenter-github-command-v1', expected_head: SHA, command: 'project.amend', project_ref: 'github:laurajoyhutchins/overcenter', amendment: {}, transition_id: 'x' }), SHA), /project.amend does not accept continuation fields/);
});

test('branch transport invokes the canonical dev semantic workflow without Issue writes or branch OIDC', async () => {
  const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command-branch.yml', import.meta.url), 'utf8');
  assert.match(workflow, /push:/);
  assert.match(workflow, /overcenter-command\/\*/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /github-command-issue\.mjs/);
  assert.match(workflow, /gcp-semantic-command\.yml\/dispatches/);
  assert.match(workflow, /--arg ref "dev"/);
  assert.match(workflow, /return_run_details:true/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /\/issues\//);
  assert.doesNotMatch(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /google-github-actions\/auth@/);
  assert.doesNotMatch(workflow, /Hatchable|hatchable/i);
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
