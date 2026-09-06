import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProjectArtifactBindingRequest,
  evaluateProjectArtifactBinding,
} from './project-artifact-binding.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const AUTHORITY_REVISION = 'aecc350f37ceb627cb9d7ff5db7ba079c821da56';

function request(overrides = {}) {
  return {
    project_ref:PROJECT_REF,
    transition_id:'example-obligation',
    expected_revision:AUTHORITY_REVISION,
    artifact:{ provider:'github', repository:'laurajoyhutchins/overcenter', kind:'issue', number:123 },
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
    provider:'github', repository:'laurajoyhutchins/overcenter', kind:'issue', number:123, state:'closed',
  }), 'satisfied');
});

test('an unbound lookalike artifact remains ambiguous rather than satisfying by prose similarity', () => {
  const binding = normalizeProjectArtifactBindingRequest(request());
  assert.equal(evaluateProjectArtifactBinding(binding, {
    provider:'github', repository:'laurajoyhutchins/overcenter', kind:'issue', number:124, state:'closed',
    title:'example obligation',
  }), 'ambiguous');
});

test('rebind and revoke require explicit prior binding identity', () => {
  assert.throws(() => normalizeProjectArtifactBindingRequest(request({ operation:'rebind' })), /prior_binding_sha256/);
  assert.throws(() => normalizeProjectArtifactBindingRequest(request({ operation:'revoke' })), /prior_binding_sha256/);
});
