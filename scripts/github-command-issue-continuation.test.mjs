import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareIssueCommand } from './github-command-issue.mjs';

const SHA = 'a'.repeat(40);
function event(body) {
  return {
    action:'opened',
    repository:{ owner:{ login:'laurajoyhutchins' } },
    issue:{ number:925, title:'[overcenter-command]', user:{ login:'laurajoyhutchins' }, body:JSON.stringify(body) },
  };
}

test('project.advance continuation preserves its original durable run identity', () => {
  const result = prepareIssueCommand(event({
    schema:'overcenter-github-command-v1', expected_head:SHA, command:'project.advance',
    project_ref:'github:laurajoyhutchins/overcenter', transition_id:'expose-transition-proof-state',
    resume_ref:'project-advance-abc', run_id:`github-issue:924:${SHA}`,
    execution_result:{ disposition:'requeue', requeue_class:'wait_for_observable_change', reason:'runtime materialization pending' },
  }), SHA);
  assert.equal(result.request_id, `github-issue:925:${SHA}`);
  assert.equal(result.payload.invocation_context.run_id, `github-issue:924:${SHA}`);
  assert.equal(result.payload.input.resume_ref, 'project-advance-abc');
});

test('fresh project.advance cannot choose an arbitrary durable run identity', () => {
  assert.throws(() => prepareIssueCommand(event({
    schema:'overcenter-github-command-v1', expected_head:SHA, command:'project.advance',
    project_ref:'github:laurajoyhutchins/overcenter', run_id:'run:smuggled',
  }), SHA), /only for a continuation/);
});
