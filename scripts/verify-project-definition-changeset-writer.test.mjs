import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDefinitionChangesetWriter } from '../lib/project-definition-changeset-writer.js';

const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const authority = Object.freeze({
  schema:'project-definition-mutation-authority-v1',
  subject:'project_definition',
  operation:'define',
  project_ref:'github:example/project',
  repository:'example/project',
  authority_revision:revision,
});

test('project definition changeset writer injects semantic source authority into the existing GitHub writer', async () => {
  const delegated = [];
  const write = createProjectDefinitionChangesetWriter({
    applyChangeset:async (request, options) => {
      delegated.push({ request, authority:await options.executionAuthority.require({ repository:request.repo }) });
      return { ok:true, new_head:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    },
  });
  const result = await write({
    repo:'example/project', base_sha:revision, branch:'work/project-define', expected_head:revision,
    changes:[{ path:'.overcenter/definitions/project.json', operation:'create', content:'{}\n' }],
    commit_message:'project: define github:example/project', idempotency_key:'define-key', mutation_authority:authority,
  });
  assert.equal(result.ok, true);
  assert.equal(delegated.length, 1);
  assert.equal('mutation_authority' in delegated[0].request, false);
  assert.deepEqual(delegated[0].authority, authority);
});

test('project definition changeset writer fails closed when source authority does not match repository or base revision', async () => {
  const write = createProjectDefinitionChangesetWriter({ applyChangeset:async () => assert.fail('delegate must not run') });
  await assert.rejects(() => write({ repo:'other/project', base_sha:revision, mutation_authority:authority }), (error) => error?.code === 'PROJECT_DEFINITION_CHANGESET_AUTHORITY_MISMATCH');
  await assert.rejects(() => write({ repo:'example/project', base_sha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', mutation_authority:authority }), (error) => error?.code === 'PROJECT_DEFINITION_CHANGESET_AUTHORITY_MISMATCH');
});