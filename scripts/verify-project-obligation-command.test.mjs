import assert from 'node:assert/strict';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';
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
    executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
    execution_intent:{
      schema:'project-execution-intent-v1',
      desired_outcome:'Important project judgment is durable and available to later workers.',
      acceptance_evidence:[{ kind:'tests', requirement:'Round-trip regression passes.' }],
    },
  }],
});

assert.ok(CANONICAL_COMMANDS.includes('project.add_obligation'));
const descriptor = semanticCommandDescriptor('project.add_obligation');
assert.equal(descriptor.command, 'project.add_obligation');
assert.equal(descriptor.exposure.mcp, true);
assert.equal(descriptor.exposure.worker, false);

assert.throws(() => normalizeProjectAddObligationRequest({
  project_ref:'github:example/project',
  expected_revision:revision,
  obligation:{
    id:'persist-project-context',
    desired_outcome:'Persist it.',
    acceptance_evidence:[{ kind:'tests', requirement:'Regression passes.' }],
    repository_path:'.overcenter/project.json',
  },
}), (error) => error?.code === 'PROJECT_OBLIGATION_COMMAND_INVALID' && error?.details?.unknown?.includes('repository_path'));

assert.throws(() => normalizeProjectAddObligationRequest({
  project_ref:'github:example/project',
  expected_revision:revision,
  obligation:{ id:'persist-project-context', desired_outcome:'Persist it.' },
}), (error) => error?.code === 'PROJECT_OBLIGATION_COMMAND_INVALID');

console.log('project.add_obligation semantic normalization: PASS');