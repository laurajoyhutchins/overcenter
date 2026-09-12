import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLinearMaintenance } from 'lib/linear-maintenance.js';

class FakeLinearApi {
  constructor() { this.calls = []; this.loseResponse = false; }
  async call(name, request) {
    assert.equal(name, 'linear');
    const query = String(request?.body?.query || '');
    this.calls.push(query);
    const match = query.match(/\{\s*(issueLabelRetire|issueLabelRestore|workflowStateArchive|workflowStateUpdate|projectArchive|projectUnarchive)/);
    assert.ok(match, `unexpected mutation: ${query}`);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost'); }
    return { status: 200, body: { data: { [match[1]]: { success: true } } } };
  }
}

test('dry run performs no mutation', async () => {
  const apiBinding = new FakeLinearApi();
  const result = await applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1', dry_run: true }, { apiBinding });
  assert.ok(result.ok && result.dry_run && result.changed === false);
  assert.equal(apiBinding.calls.length, 0);
});

test('issue label retirement uses only the fixed native mutation', async () => {
  const apiBinding = new FakeLinearApi();
  const result = await applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1' }, { apiBinding });
  assert.ok(result.ok && result.changed);
  assert.ok(apiBinding.calls.length === 1 && apiBinding.calls[0].includes('issueLabelRetire'));
});

test('project archival explicitly archives instead of trashing', async () => {
  const apiBinding = new FakeLinearApi();
  await applyLinearMaintenance({ action: 'project_archive', id: 'project-1' }, { apiBinding });
  assert.ok(apiBinding.calls[0].includes('projectArchive') && apiBinding.calls[0].includes('trash: false'));
});

test('workflow state archive is a bounded action', async () => {
  const apiBinding = new FakeLinearApi();
  await applyLinearMaintenance({ action: 'workflow_state_archive', id: 'state-1' }, { apiBinding });
  assert.ok(apiBinding.calls[0].includes('workflowStateArchive'));
});

test('workflow state rename is narrow and requires an explicit name', async () => {
  const apiBinding = new FakeLinearApi();
  const result = await applyLinearMaintenance({ action: 'workflow_state_rename', id: 'state-1', name: 'Started (unused)', description: 'Runtime ownership lives elsewhere.' }, { apiBinding });
  assert.ok(result.ok && result.name === 'Started (unused)');
  assert.ok(apiBinding.calls[0].includes('workflowStateUpdate'));
  await assert.rejects(
    () => applyLinearMaintenance({ action: 'workflow_state_rename', id: 'state-1' }, { apiBinding }),
    (error) => error?.code === 'LINEAR_MAINTENANCE_INVALID_NAME',
  );
});

test('lost mutation response is explicitly indeterminate', async () => {
  const apiBinding = new FakeLinearApi();
  apiBinding.loseResponse = true;
  await assert.rejects(
    () => applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1' }, { apiBinding }),
    (error) => error?.code === 'LINEAR_MAINTENANCE_INDETERMINATE' && error?.details?.may_have_mutated === true,
  );
});

test('arbitrary GraphQL is impossible through the action surface', async () => {
  const apiBinding = new FakeLinearApi();
  await assert.rejects(
    () => applyLinearMaintenance({ action: 'graphql', id: 'x' }, { apiBinding }),
    (error) => error?.code === 'LINEAR_MAINTENANCE_INVALID_ACTION',
  );
  assert.equal(apiBinding.calls.length, 0);
});