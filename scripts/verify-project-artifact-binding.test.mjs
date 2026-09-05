import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProjectArtifactBindingRequest,
  evaluateProjectArtifactBinding,
  createProjectArtifactBindingService,
} from '../lib/project-artifact-binding.js';

const REVISION = '2d9d725e370eb57d6f0b68fec1b247471eb033fa';

function request(overrides = {}) {
  return {
    project_ref: 'github:laurajoyhutchins/overcenter',
    expected_revision: REVISION,
    transition_id: 'add-project-artifact-binding',
    provider: { kind: 'issue', id: 420 },
    relationship: 'full-coverage-equivalent',
    satisfaction_condition: 'issue-closed',
    action: 'bind',
    ...overrides,
  };
}

test('binding intent contains only explicit machine facts and derives repository plus retry identity', async () => {
  const normalized = await normalizeProjectArtifactBindingRequest(request());
  assert.equal(normalized.repository, 'laurajoyhutchins/overcenter');
  assert.match(normalized.binding_id, /^pab_[0-9a-f]{64}$/);
  assert.equal(normalized.provider.kind, 'issue');
  assert.equal(normalized.provider.id, 420);
  assert.equal('title' in normalized, false);
  assert.equal('body' in normalized, false);
});

test('unbound lookalike remains ambiguous while explicit exact binding can mechanically satisfy', () => {
  assert.deepEqual(evaluateProjectArtifactBinding(null, { kind: 'issue', id: 420, state: 'closed' }), { classification: 'ambiguous', reason: 'no-explicit-binding' });
  const binding = { ...request(), binding_id: 'pab_x', repository: 'laurajoyhutchins/overcenter', provider: { kind: 'issue', id: 420 } };
  assert.equal(evaluateProjectArtifactBinding(binding, { kind: 'issue', id: 420, state: 'closed' }).classification, 'satisfied');
  assert.equal(evaluateProjectArtifactBinding(binding, { kind: 'issue', id: 421, state: 'closed' }).classification, 'ambiguous');
});

test('stale project authority fails before durable mutation', async () => {
  let stored = 0;
  const service = createProjectArtifactBindingService({
    inspectProject: async () => ({ authority: { revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
    readProvider: async () => ({ kind: 'issue', id: 420, state: 'open' }),
    store: { record: async () => { stored += 1; } },
  });
  await assert.rejects(service.bind(request()), (error) => error.code === 'PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE');
  assert.equal(stored, 0);
});

test('explicit bind persists append-only evidence and exact replay is idempotent', async () => {
  const rows = new Map();
  const store = {
    async record(event) {
      const existing = rows.get(event.binding_id);
      if (existing && JSON.stringify(existing.request) !== JSON.stringify(event.request)) return { outcome: 'conflict', event: existing };
      if (existing) return { outcome: 'replay', event: existing };
      rows.set(event.binding_id, event);
      return { outcome: 'recorded', event };
    },
  };
  const service = createProjectArtifactBindingService({
    inspectProject: async () => ({ authority: { revision: REVISION } }),
    readProvider: async () => ({ kind: 'issue', id: 420, state: 'closed' }),
    store,
  });
  const first = await service.bind(request());
  const replay = await service.bind(request());
  assert.equal(first.outcome, 'recorded');
  assert.equal(first.binding.classification, 'satisfied');
  assert.equal(replay.outcome, 'replay');
  assert.equal(rows.size, 1);
});

test('revoke, supersede, and rebind require an explicit prior binding identity', async () => {
  for (const action of ['revoke', 'supersede', 'rebind']) {
    await assert.rejects(normalizeProjectArtifactBindingRequest(request({ action })), /prior_binding_id/);
  }
});