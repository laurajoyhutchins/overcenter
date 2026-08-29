import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDefinitionMutationAuthorityPolicy } from '../lib/project-definition-mutation-authority.js';

const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectRef = 'github:example/project';
const repository = 'example/project';

function policy({ disposition = 'ACTIVE', sourceRevision = revision } = {}) {
  return createProjectDefinitionMutationAuthorityPolicy({
    readRepositoryDisposition: async () => ({ repository, disposition }),
    readSourceRevision: async () => sourceRevision,
  });
}

test('project definition mutation authority binds semantic intent to active exact repository source authority', async () => {
  const authority = await policy().require({
    operation:'define', project_ref:projectRef, repository, expected_revision:revision,
  });
  assert.deepEqual(authority, {
    schema:'project-definition-mutation-authority-v1',
    subject:'project_definition',
    operation:'define',
    project_ref:projectRef,
    repository,
    authority_revision:revision,
  });
});

test('project definition mutation authority rejects stale exact source authority', async () => {
  await assert.rejects(
    () => policy({ sourceRevision:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }).require({
      operation:'amend', project_ref:projectRef, repository, expected_revision:revision,
    }),
    (error) => error?.code === 'PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE',
  );
});

test('project definition mutation authority rejects repositories that are no longer active', async () => {
  await assert.rejects(
    () => policy({ disposition:'ARCHIVED' }).require({
      operation:'define', project_ref:projectRef, repository, expected_revision:revision,
    }),
    (error) => error?.code === 'PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE',
  );
});