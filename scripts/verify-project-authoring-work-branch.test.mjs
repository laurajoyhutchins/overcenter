import test from 'node:test';
import assert from 'node:assert/strict';
import { isConformingWorkBranch } from '../lib/branch-policy-v1.js';
import { projectAuthoringWorkBranch } from '../lib/project-authoring-work-branch.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

test('project authoring derives a stable branch accepted by branch-policy-v1', () => {
  const key = `project-define-v1:${digestA}`;
  const branch = projectAuthoringWorkBranch({ operation:'define', idempotency_key:key });
  assert.equal(branch, `chore/project-authoring-define-${digestA.slice(0, 24)}`);
  assert.equal(projectAuthoringWorkBranch({ operation:'define', idempotency_key:key }), branch);
  assert.equal(isConformingWorkBranch(branch), true);
});

test('distinct semantic requests do not share an authoring branch', () => {
  const defineBranch = projectAuthoringWorkBranch({ operation:'define', idempotency_key:`project-define-v1:${digestA}` });
  const amendBranch = projectAuthoringWorkBranch({ operation:'amend', idempotency_key:`project-amend-v1:${digestB}` });
  assert.notEqual(defineBranch, amendBranch);
  assert.equal(isConformingWorkBranch(defineBranch), true);
  assert.equal(isConformingWorkBranch(amendBranch), true);
});

test('authoring branch identity fails closed on malformed or cross-operation replay keys', () => {
  assert.throws(() => projectAuthoringWorkBranch({ operation:'define', idempotency_key:`project-amend-v1:${digestA}` }), /does not match operation/);
  assert.throws(() => projectAuthoringWorkBranch({ operation:'amend', idempotency_key:'caller-branch' }), /semantic idempotency key/);
  assert.throws(() => projectAuthoringWorkBranch({ operation:'other', idempotency_key:`project-define-v1:${digestA}` }), /operation/);
});