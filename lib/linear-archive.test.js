import assert from 'node:assert/strict';
import test from 'node:test';

import { archiveLinearIssue } from 'lib/linear-archive.js';

class FakeLinearApi {
  constructor({ terminal = true } = {}) {
    this.issue = {
      id: 'issue-1', identifier: 'LJH-1', title: 'Fixture', archivedAt: null,
      state: { name: terminal ? 'Done' : 'Todo', type: terminal ? 'completed' : 'unstarted' },
    };
    this.archiveCalls = 0;
    this.loseMutationResponse = false;
  }

  async call(name, request) {
    assert.equal(name, 'linear', 'unexpected API binding');
    const query = String(request?.body?.query || '');
    if (query.includes('query LinearArchiveCandidate')) {
      return { status: 200, body: { data: { issue: JSON.parse(JSON.stringify(this.issue)) } } };
    }
    if (query.includes('mutation ArchiveLinearIssue')) {
      this.archiveCalls += 1;
      this.issue.archivedAt = '2026-08-17T21:00:00.000Z';
      if (this.loseMutationResponse) {
        this.loseMutationResponse = false;
        throw new Error('response lost after archive');
      }
      return { status: 200, body: { data: { issueArchive: { success: true } } };
    }
    throw new Error('unexpected Linear operation');
  }
}

test('non-terminal issue is refused before mutation', async () => {
  const apiBinding = new FakeLinearApi({ terminal: false });
  await assert.rejects(
    archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding }),
    (error) => error?.code === 'LINEAR_ARCHIVE_NOT_TERMINAL',
  );
  assert.equal(apiBinding.archiveCalls, 0, 'non-terminal refusal still mutated Linear');
});

test('dry run stays read-only', async () => {
  const apiBinding = new FakeLinearApi();
  const result = await archiveLinearIssue({ issue: 'LJH-1', dryRun: true }, { apiBinding });
  assert.equal(result.ok, true, 'dry run did not succeed');
  assert.equal(result.dryRun, true, 'dry run did not report dryRun');
  assert.equal(apiBinding.archiveCalls, 0, 'dry run mutated Linear');
});

test('already archived is idempotent success', async () => {
  const apiBinding = new FakeLinearApi();
  apiBinding.issue.archivedAt = '2026-08-17T20:00:00.000Z';
  const result = await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding });
  assert.equal(result.ok, true, 'already archived state did not succeed');
  assert.equal(result.alreadyArchived, true, 'already archived state was not recognized');
  assert.equal(result.changed, false, 'already archived state reported a change');
  assert.equal(apiBinding.archiveCalls, 0, 'already archived path called mutation');
});

test('archive applies, response is lost, and retry observes archived state', async () => {
  const apiBinding = new FakeLinearApi();
  apiBinding.loseMutationResponse = true;
  let error;
  try {
    await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, 'LINEAR_ARCHIVE_INDETERMINATE', 'first response was not indeterminate');
  assert.equal(error?.details?.may_have_mutated, true, 'indeterminate archive omitted may_have_mutated');
  const retry = await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding });
  assert.equal(retry.ok, true, 'retry did not succeed');
  assert.equal(retry.alreadyArchived, true, 'retry did not converge on archived state');
  assert.equal(retry.changed, false, 'retry reported a duplicate change');
  assert.equal(apiBinding.archiveCalls, 1, 'retry performed duplicate archive mutation');
});
