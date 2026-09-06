import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProjectArtifactBindingRequest,
  evaluateProjectArtifactBinding,
  createProjectArtifactBindingService,
} from '../lib/project-artifact-binding.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const AUTHORITY_REVISION = 'aecc350f37ceb627cb9d7ff5db7ba079c821da56';

function request(overrides = {}) {
  return {
    project_ref:PROJECT_REF,
    transition_id:'example-obligation',
    expected_revision:AUTHORITY_REVISION,
    artifact:{ provider:'github', repository:REPOSITORY, kind:'issue', number:123 },
    relationship:'full_coverage_equivalent',
    satisfaction_condition:'artifact_closed',
    ...overrides,
  };
}

test('explicit binding captures exact project, obligation, authority, and provider identity', () => {
  assert.deepEqual(normalizeProjectArtifactBindingRequest(request()), request());
});

test('an explicitly bound closed artifact can satisfy its exact obligation', () => {
  const binding = normalizeProjectArtifactBindingRequest(request());
  assert.equal(evaluateProjectArtifactBinding(binding, {
    provider:'github', repository:REPOSITORY, kind:'issue', number:123, state:'closed',
  }), 'satisfied');
});

test('an unbound lookalike artifact remains ambiguous rather than satisfying by prose similarity', () => {
  const binding = normalizeProjectArtifactBindingRequest(request());
  assert.equal(evaluateProjectArtifactBinding(binding, {
    provider:'github', repository:REPOSITORY, kind:'issue', number:124, state:'closed', title:'example obligation',
  }), 'ambiguous');
});

test('rebind and revoke require explicit prior binding identity', () => {
  assert.throws(() => normalizeProjectArtifactBindingRequest(request({ operation:'rebind' })), /prior_binding_sha256/);
  assert.throws(() => normalizeProjectArtifactBindingRequest(request({ operation:'revoke' })), /prior_binding_sha256/);
});

test('binding service reads exact authority and provider identity before appending audit evidence', async () => {
  const events = [];
  const service = createProjectArtifactBindingService({
    readProjectAuthority:async () => ({ kind:'github', repository:REPOSITORY, revision:AUTHORITY_REVISION, derivation:'overcenter-project-graph-v1', transition_ids:['example-obligation'] }),
    readArtifact:async (artifact) => ({ ...artifact, node_id:'I_kwDOexact', state:'open' }),
    appendEvent:async (event) => { events.push(event); return event; },
    readCurrentBinding:async () => null,
  });
  const result = await service.mutate(request());
  assert.equal(result.ok, true);
  assert.equal(result.binding.authority.revision, AUTHORITY_REVISION);
  assert.equal(result.binding.artifact.node_id, 'I_kwDOexact');
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'bind');
  assert.match(events[0].binding_sha256, /^[0-9a-f]{64}$/);
});

test('binding service fails closed on stale project authority before persisting evidence', async () => {
  let appended = false;
  const service = createProjectArtifactBindingService({
    readProjectAuthority:async () => ({ kind:'github', repository:REPOSITORY, revision:'1111111111111111111111111111111111111111', derivation:'overcenter-project-graph-v1', transition_ids:['example-obligation'] }),
    readArtifact:async () => { throw new Error('provider read must not occur after stale authority'); },
    appendEvent:async () => { appended = true; },
    readCurrentBinding:async () => null,
  });
  await assert.rejects(() => service.mutate(request()), (error) => error.code === 'PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE');
  assert.equal(appended, false);
});
