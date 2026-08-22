import { applyLinearMaintenance } from 'lib/linear-maintenance.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }

class FakeLinearApi {
  constructor() { this.calls = []; this.loseResponse = false; }
  async call(name, request) {
    assert(name === 'linear', 'unexpected API binding');
    const query = String(request?.body?.query || '');
    this.calls.push(query);
    const match = query.match(/\{\s*(issueLabelRetire|issueLabelRestore|workflowStateArchive|workflowStateUpdate|projectArchive|projectUnarchive)/);
    assert(match, `unexpected mutation: ${query}`);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost'); }
    return { status: 200, body: { data: { [match[1]]: { success: true } } } };
  }
}

export async function runLinearMaintenanceTests() {
  const results = [];
  results.push(await run('dry run performs no mutation', async () => {
    const apiBinding = new FakeLinearApi();
    const result = await applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1', dry_run: true }, { apiBinding });
    assert(result.ok && result.dry_run && result.changed === false, 'dry run result incorrect');
    assert(apiBinding.calls.length === 0, 'dry run called Linear');
  }));
  results.push(await run('issue label retirement uses only the fixed native mutation', async () => {
    const apiBinding = new FakeLinearApi();
    const result = await applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1' }, { apiBinding });
    assert(result.ok && result.changed, 'retirement did not succeed');
    assert(apiBinding.calls.length === 1 && apiBinding.calls[0].includes('issueLabelRetire'), 'wrong label mutation');
  }));
  results.push(await run('project archival explicitly archives instead of trashing', async () => {
    const apiBinding = new FakeLinearApi();
    await applyLinearMaintenance({ action: 'project_archive', id: 'project-1' }, { apiBinding });
    assert(apiBinding.calls[0].includes('projectArchive') && apiBinding.calls[0].includes('trash: false'), 'project archive did not preserve archive semantics');
  }));
  results.push(await run('workflow state archive is a bounded action', async () => {
    const apiBinding = new FakeLinearApi();
    await applyLinearMaintenance({ action: 'workflow_state_archive', id: 'state-1' }, { apiBinding });
    assert(apiBinding.calls[0].includes('workflowStateArchive'), 'wrong workflow state mutation');
  }));
  results.push(await run('workflow state rename is narrow and requires an explicit name', async () => {
    const apiBinding = new FakeLinearApi();
    const result = await applyLinearMaintenance({ action: 'workflow_state_rename', id: 'state-1', name: 'Started (unused)', description: 'Runtime ownership lives elsewhere.' }, { apiBinding });
    assert(result.ok && result.name === 'Started (unused)', 'workflow state rename did not preserve requested name');
    assert(apiBinding.calls[0].includes('workflowStateUpdate'), 'wrong workflow state rename mutation');
    let error; try { await applyLinearMaintenance({ action: 'workflow_state_rename', id: 'state-1' }, { apiBinding }); } catch (caught) { error = caught; }
    assert(error?.code === 'LINEAR_MAINTENANCE_INVALID_NAME', 'rename accepted a missing name');
  }));
  results.push(await run('lost mutation response is explicitly indeterminate', async () => {
    const apiBinding = new FakeLinearApi(); apiBinding.loseResponse = true;
    let error; try { await applyLinearMaintenance({ action: 'issue_label_retire', id: 'label-1' }, { apiBinding }); } catch (caught) { error = caught; }
    assert(error?.code === 'LINEAR_MAINTENANCE_INDETERMINATE' && error?.details?.may_have_mutated === true, 'lost response was not indeterminate');
  }));
  results.push(await run('arbitrary GraphQL is impossible through the action surface', async () => {
    const apiBinding = new FakeLinearApi();
    let error; try { await applyLinearMaintenance({ action: 'graphql', id: 'x' }, { apiBinding }); } catch (caught) { error = caught; }
    assert(error?.code === 'LINEAR_MAINTENANCE_INVALID_ACTION', 'arbitrary action was accepted');
    assert(apiBinding.calls.length === 0, 'invalid action reached Linear');
  }));
  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}