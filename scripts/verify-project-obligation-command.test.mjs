import assert from 'node:assert/strict';
import { normalizeProjectAddObligationRequest } from '../lib/project-obligation-command-contract.js';

const revision = 'a'.repeat(40);
const request = normalizeProjectAddObligationRequest({
  project_ref:'github:example/project',
  expected_revision:revision,
  obligation:{
    id:'persist-project-context',
    desired_outcome:'Important project judgment is durable and available to later workers.',
    requires:['project-authoring'],
    acceptance_evidence:[{ kind:'tests', requirement:'Round-trip regression passes.' }],
  },
});

assert.equal(request.project_ref, 'github:example/project');
assert.equal(request.expected_revision, revision);
assert.deepEqual(request.amendment, {
  upsert_transitions:[{
    id:'persist-project-context',
    priority:50,
    requires:['project-authoring'],
    executor:{ kind:'agent', role:'implementation' },
    execution_intent:{
      schema:'project-execution-intent-v1',
      desired_outcome:'Important project judgment is durable and available to later workers.',
      acceptance_evidence:[{ kind:'tests', requirement:'Round-trip regression passes.' }],
    },
  }],
});

assert.throws(() => normalizeProjectAddObligationRequest({
  project_ref:'github:example/project',
  expected_revision:revision,
  obligation:{
    id:'persist-project-context',
    desired_outcome:'Persist it.',
    repository_path:'.overcenter/project.json',
  },
}), (error) => error?.code === 'PROJECT_OBLIGATION_COMMAND_INVALID' && error?.details?.unknown?.includes('repository_path'));

console.log('project.add_obligation semantic normalization: PASS');