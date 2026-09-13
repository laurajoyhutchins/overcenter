import test from 'node:test';
import assert from 'node:assert/strict';
import { bindProjectArtifact, reconstructProjectArtifactLineage } from '../lib/project-artifact-lineage.js';
import { deriveProjectWorkSurfaceConvergence } from '../lib/project-work-surface-convergence.js';

const REV = '0123456789abcdef0123456789abcdef01234567';
const PROJECT = 'github:laurajoyhutchins/overcenter';
const REPO = 'laurajoyhutchins/overcenter';

function lineage({ transition_id, provider_id, head, state='open' }) {
  return reconstructProjectArtifactLineage({
    project_ref:PROJECT,
    repository:REPO,
    transition_id,
    semantic_operation:'project.authoring',
    idempotency_identity:`op-${provider_id}`,
    authority_revision:REV,
    provider:{ kind:'pull_request', id:provider_id, state, head, base:REV },
    candidate:{ head, base:REV },
  });
}

test('classifies superseded project-authoring candidates as mechanically safe to retire', () => {
  const oldLineage = lineage({ transition_id:'same-obligation', provider_id:10, head:'1111111111111111111111111111111111111111' });
  const newLineage = lineage({ transition_id:'same-obligation', provider_id:11, head:'2222222222222222222222222222222222222222' });
  const result = deriveProjectWorkSurfaceConvergence({
    artifacts:[{ lineage:oldLineage, newer_lineage:newLineage }],
    current_project_transition_ids:['same-obligation'],
  });
  assert.equal(result.safe_to_retire[0].classification, 'superseded');
});

test('classifies owned temporary verification PRs with no live continuation as orphaned', () => {
  const old = lineage({ transition_id:'retired-transition', provider_id:20, head:'3333333333333333333333333333333333333333' });
  const result = deriveProjectWorkSurfaceConvergence({
    artifacts:[{ lineage:old }],
    current_project_transition_ids:['different-transition'],
    live_execution_provider_ids:[],
    overcenter_owned_provider_ids:[20],
  });
  assert.equal(result.safe_to_retire[0].classification, 'orphaned');
});

test('classifies explicitly bound issues whose obligation is durably completed as safe to retire', () => {
  const binding = bindProjectArtifact({
    project_ref:PROJECT,
    repository:REPO,
    transition_id:'completed-obligation',
    authority_revision:REV,
    provider:{ kind:'issue', id:30 },
    relationship:'full_coverage_equivalence',
    satisfaction:{ condition:'closed' },
  });
  const result = deriveProjectWorkSurfaceConvergence({
    artifacts:[{ binding, provider:{ repository:REPO, kind:'issue', id:30, state:'closed' } }],
  });
  assert.equal(result.safe_to_retire[0].classification, 'satisfied');
});

test('refuses to infer safe retirement from loosely related human issue prose', () => {
  const result = deriveProjectWorkSurfaceConvergence({
    artifacts:[{ provider:{ repository:REPO, kind:'issue', id:40, state:'closed' }, title:'looks related to completed work' }],
  });
  assert.equal(result.ambiguous[0].classification, 'ambiguous');
  assert.equal(result.ambiguous[0].evidence.reason, 'durable-lineage-or-binding-absent');
});

test('keeps unknown provider state ambiguous through explicit binding evidence', () => {
  const binding = bindProjectArtifact({
    project_ref:PROJECT,
    repository:REPO,
    transition_id:'completed-obligation',
    authority_revision:REV,
    provider:{ kind:'issue', id:50 },
    relationship:'full_coverage_equivalence',
    satisfaction:{ condition:'closed' },
  });
  const result = deriveProjectWorkSurfaceConvergence({ artifacts:[{ binding, provider:null }] });
  assert.equal(result.ambiguous[0].classification, 'ambiguous');
});