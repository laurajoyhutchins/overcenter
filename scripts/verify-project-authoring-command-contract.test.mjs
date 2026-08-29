import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProjectDefineRequest,
  normalizeProjectAmendRequest,
} from '../lib/project-authoring-command-contract.js';

const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectRef = 'github:example/project';
const definition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

test('project.define exposes semantic intent without repository layout or transport bookkeeping', () => {
  const normalized = normalizeProjectDefineRequest({
    project_ref:projectRef,
    expected_revision:revision,
    definition,
  });
  assert.deepEqual(normalized, { project_ref:projectRef, expected_revision:revision, definition });
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha']) {
    assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:revision, definition, [forbidden]:'caller-owned' }), /unsupported field/);
  }
});

test('project.amend exposes bounded semantic edits plus execution authority reference only', () => {
  const amendment = {
    upsert_transitions:[
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  };
  const normalized = normalizeProjectAmendRequest({
    project_ref:projectRef,
    expected_revision:revision,
    amendment,
    lease_ref:'lease-ref',
    run_id:'run-id',
  });
  assert.deepEqual(normalized, { project_ref:projectRef, expected_revision:revision, amendment, lease_ref:'lease-ref', run_id:'run-id' });
  for (const forbidden of ['branch','path','idempotency_key','commit_message','base_sha']) {
    assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:revision, amendment, lease_ref:'lease-ref', [forbidden]:'caller-owned' }), /unsupported field/);
  }
});

test('project authoring command requests fail closed on inexact source authority', () => {
  assert.throws(() => normalizeProjectDefineRequest({ project_ref:projectRef, expected_revision:'dev', definition }), /40-character Git revision/);
  assert.throws(() => normalizeProjectAmendRequest({ project_ref:projectRef, expected_revision:'dev', amendment:{}, lease_ref:'lease-ref' }), /40-character Git revision/);
});