import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION,
  inspectOutcomeIntegrity,
  assertOutcomeIntegrityReviewCurrent,
} from '../lib/outcome-integrity-inspection.js';

const REVISION = '203d4b1b919ca77108fc4188934fdee6d423ff94';

function baseInput(overrides = {}) {
  return {
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:REVISION, derivation:'overcenter-project-graph-v1' },
    graph_semantic_identity:'sha256:graph-v1',
    selected_horizon:{ kind:'project', root:'root-outcome' },
    graph:{
      root_claim:'root-outcome',
      obligations:[
        { id:'implement', produces:['candidate'], evidence_bindings:['candidate-source'] },
        { id:'verify', requires:['implement'], consumes:['candidate'], produces:['verified-candidate'], evidence_bindings:['exact-test'] },
        { id:'integrate', requires:['verify'], consumes:['verified-candidate'], produces:['root-outcome'], evidence_bindings:['authoritative-effect'] },
      ],
      assumptions:[{ id:'github-source-authority', owner:'github', supports:['root-outcome'] }],
      argument:[['candidate','verified-candidate'],['verified-candidate','root-outcome']],
    },
    ...overrides,
  };
}

test('binds read-only inspection to exact project authority, semantic identity, contract, and selected root', () => {
  const report = inspectOutcomeIntegrity(baseInput());
  assert.equal(report.schema, 'outcome-integrity-inspection-v0');
  assert.equal(report.review_contract_version, OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION);
  assert.equal(report.project_ref, 'github:laurajoyhutchins/overcenter');
  assert.equal(report.authority.revision, REVISION);
  assert.equal(report.authority.derivation, 'overcenter-project-graph-v1');
  assert.equal(report.graph_semantic_identity, 'sha256:graph-v1');
  assert.equal(report.selected_horizon.root, 'root-outcome');
  assert.equal('semantically_valid' in report, false);
  assert.equal(report.mutation_authority, 'none');
});

test('stale review is invalidated by any authority revision change', () => {
  const report = inspectOutcomeIntegrity(baseInput());
  assert.doesNotThrow(() => assertOutcomeIntegrityReviewCurrent(report, { ...baseInput().authority }));
  assert.throws(() => assertOutcomeIntegrityReviewCurrent(report, {
    ...baseInput().authority,
    revision:'303d4b1b919ca77108fc4188934fdee6d423ff94',
  }), /OUTCOME_INTEGRITY_REVIEW_STALE/);
});

test('deterministic analysis finds mechanically knowable proof-closure defects without inventing semantic truth', () => {
  const report = inspectOutcomeIntegrity(baseInput({
    graph:{
      root_claim:'root-outcome',
      obligations:[
        { id:'orphan', produces:[], evidence_bindings:[] },
        { id:'consumer', requires:['missing-obligation'], consumes:['missing-claim'], produces:['root-outcome'], evidence_bindings:[] },
      ],
      assumptions:[{ id:'unowned-assumption', supports:['root-outcome'] }],
      argument:[['root-outcome','supporting-claim'],['supporting-claim','root-outcome']],
    },
  }));
  const codes = new Set(report.objective_violations.map((finding) => finding.code));
  for (const code of ['ORPHAN_WORK','MISSING_REQUIRED_OBLIGATION','MISSING_PRODUCER','UNOWNED_ASSUMPTION','MISSING_EVIDENCE_BINDING','SEMANTIC_JUSTIFICATION_CYCLE']) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
  assert.equal(report.execution_gate, 'blocked_by_objective_violation');
});

test('packet-only disposable-agent counterexample survives leaf success and becomes a falsification obligation', () => {
  const report = inspectOutcomeIntegrity(baseInput({
    graph:{
      root_claim:'fresh-agent-can-execute-from-packet-alone',
      obligations:[
        { id:'emit-packet', produces:['packet-issued'], evidence_bindings:['packet-schema-test'] },
        { id:'lease-transition', requires:['emit-packet'], produces:['lease-issued'], evidence_bindings:['lease-test'] },
      ],
      assumptions:[{ id:'packet-is-self-contained', owner:null, supports:['fresh-agent-can-execute-from-packet-alone'] }],
      argument:[['packet-issued','lease-issued']],
    },
    selected_horizon:{ kind:'project', root:'fresh-agent-can-execute-from-packet-alone' },
  }));
  assert.ok(report.falsification.counterexamples.some((item) => item.kind === 'all_declared_work_succeeds_root_unestablished'));
  assert.ok(report.unresolved_proof_obligations.some((item) => item.claim === 'fresh-agent-can-execute-from-packet-alone'));
  assert.equal(report.reasoning_review.authoritative, false);
  assert.equal(report.reasoning_review.repair_authority, 'project.authoring');
});

test('reasoning protocol contains positive derivation and falsification inputs, not a validity boolean', () => {
  const report = inspectOutcomeIntegrity(baseInput());
  assert.ok(Array.isArray(report.positive_derivation.argument_steps));
  assert.ok(Array.isArray(report.falsification.defeaters));
  assert.ok(Array.isArray(report.reasoning_review.findings));
  assert.ok(Array.isArray(report.reasoning_review.counterexamples));
  assert.equal('semantically_valid' in report.reasoning_review, false);
});