import { archiveLinearIssue } from 'lib/linear-archive.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }

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
    assert(name === 'linear', 'unexpected API binding');
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
      return { status: 200, body: { data: { issueArchive: { success: true } } } };
    }
    throw new Error('unexpected Linear operation');
  }
}

export async function runLinearArchiveTests() {
  const results = [];

  results.push(await run('non-terminal issue is refused before mutation', async () => {
    const apiBinding = new FakeLinearApi({ terminal: false });
    let error;
    try { await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding }); } catch (caught) { error = caught; }
    assert(error?.code === 'LINEAR_ARCHIVE_NOT_TERMINAL', 'non-terminal issue was not refused');
    assert(apiBinding.archiveCalls === 0, 'non-terminal refusal still mutated Linear');
  }));

  results.push(await run('dry run stays read-only', async () => {
    const apiBinding = new FakeLinearApi();
    const result = await archiveLinearIssue({ issue: 'LJH-1', dryRun: true }, { apiBinding });
    assert(result.ok === true && result.dryRun === true, 'dry run did not succeed');
    assert(apiBinding.archiveCalls === 0, 'dry run mutated Linear');
  }));

  results.push(await run('already archived is idempotent success', async () => {
    const apiBinding = new FakeLinearApi();
    apiBinding.issue.archivedAt = '2026-08-17T20:00:00.000Z';
    const result = await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding });
    assert(result.ok === true && result.alreadyArchived === true && result.changed === false, 'already archived state was not idempotent');
    assert(apiBinding.archiveCalls === 0, 'already archived path called mutation');
  }));

  results.push(await run('archive applies, response is lost, and retry observes archived state', async () => {
    const apiBinding = new FakeLinearApi();
    apiBinding.loseMutationResponse = true;
    let error;
    try { await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding }); } catch (caught) { error = caught; }
    assert(error?.code === 'LINEAR_ARCHIVE_INDETERMINATE', `first response was not indeterminate: ${error?.code}`);
    assert(error?.details?.may_have_mutated === true, 'indeterminate archive omitted may_have_mutated');
    const retry = await archiveLinearIssue({ issue: 'LJH-1' }, { apiBinding });
    assert(retry.ok === true && retry.alreadyArchived === true && retry.changed === false, 'retry did not converge on archived state');
    assert(apiBinding.archiveCalls === 1, 'retry performed duplicate archive mutation');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}