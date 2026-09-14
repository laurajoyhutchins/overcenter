import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareIssueCommand } from './github-command-issue.mjs';

const SHA = 'a'.repeat(40);

function event(body) {
  return {
    action: 'opened',
    repository: { owner: { login: 'laurajoyhutchins' } },
    issue: {
      number: 902,
      title: '[overcenter-command]',
      user: { login: 'laurajoyhutchins' },
      body: JSON.stringify(body),
    },
  };
}

test('admits bounded owner-issued orchestration.maintain without project or run identity', () => {
  const result = prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'orchestration.maintain',
  }), SHA);

  assert.deepEqual(result.payload, {
    command: 'orchestration.maintain',
    input: {},
    invocation_context: {
      origin: 'operator',
      reasoning_boundary_id: `github-issue:902:${SHA}`,
    },
  });
});

test('keeps orchestration.maintain target-free and rejects authority smuggling', () => {
  for (const field of [
    ['project_ref', 'github:laurajoyhutchins/overcenter'],
    ['run_id', 'run:abc'],
    ['work_ref', 'work:abc'],
    ['transition_id', 'transition'],
    ['resume_ref', 'resume:abc'],
    ['execution_result', { outcome:'completed' }],
    ['amendment', {}],
  ]) {
    assert.throws(() => prepareIssueCommand(event({
      schema: 'overcenter-github-command-v1',
      expected_head: SHA,
      command: 'orchestration.maintain',
      [field[0]]: field[1],
    }), SHA));
  }
});

test('unknown semantic commands remain rejected', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema: 'overcenter-github-command-v1',
    expected_head: SHA,
    command: 'orchestration.execute-anything',
  }), SHA), /not admitted/);
});
