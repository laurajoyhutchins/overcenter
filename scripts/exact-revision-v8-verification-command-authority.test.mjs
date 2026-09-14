import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareIssueCommand } from './github-command-issue.mjs';

const CONTROL_REVISION = 'a'.repeat(40);
const TARGET_REVISION = 'b'.repeat(40);

function event(body) {
  return {
    action: 'opened',
    repository: {
      name: 'overcenter',
      full_name: 'laurajoyhutchins/overcenter',
      owner: { login: 'laurajoyhutchins' },
    },
    issue: {
      number: 902,
      title: '[overcenter-command]',
      user: { login: 'laurajoyhutchins' },
      body: JSON.stringify(body),
    },
  };
}

test('project.amend keeps target authority revision independent from control revision', () => {
  const amendment = {
    upsert_transitions: [],
    remove_transition_ids: [],
    confirmed_transition_ids: [],
  };
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: CONTROL_REVISION,
    command: 'project.amend',
    project_ref: 'github:laurajoyhutchins/chirograph',
    expected_revision: TARGET_REVISION,
    amendment,
  }), CONTROL_REVISION);

  assert.equal(result.expected_head, CONTROL_REVISION);
  assert.equal(result.payload.input.expected_revision, TARGET_REVISION);
  assert.notEqual(result.payload.input.expected_revision, result.expected_head);
});

test('project.amend fails closed without an exact target authority revision', () => {
  const amendment = {
    upsert_transitions: [],
    remove_transition_ids: [],
    confirmed_transition_ids: [],
  };
  const base = {
    schema: 'overcenter-github-command-v1',
    expected_head: CONTROL_REVISION,
    command: 'project.amend',
    project_ref: 'github:laurajoyhutchins/chirograph',
    amendment,
  };

  assert.throws(
    () => prepareIssueCommand(event(base), CONTROL_REVISION),
    /expected_revision/,
  );
  assert.throws(
    () => prepareIssueCommand(event({ ...base, expected_revision: 'not-a-sha' }), CONTROL_REVISION),
    /expected_revision/,
  );
});
