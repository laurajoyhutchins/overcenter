import assert from 'node:assert/strict';
import test from 'node:test';

import { localFileEnoentEvidence } from '../src/observation/evidence.ts';
import type { HistoricalRun, Receipt, State } from '../src/authority/facts.ts';
import type { Dependency, FileContentPostcondition, Obligation, Run } from '../src/model.ts';
import type { Lifecycle } from '../src/authority/project-state.ts';
import { obligationKey } from '../src/graph/identity.ts';
import {
  classifyCurrentRealization,
  deriveCurrentRealizationJudgments,
} from '../src/authority/realization-reuse.ts';

const work: Obligation = {
  id: 'a',
  dependencies: [],
  packet: {},
  postcondition: {
    verifier: 'file-content-equals/v1',
    path: '/provider/a',
    content: 'A',
  },
};
const state: State = {
  obligations: { a: work },
  definition_ids: { a: 'define-a' },
};

const semanticOutput = (upstream: string): Dependency => ({
  kind: 'semantic',
  upstream,
  consumes: { kind: 'output', selector: 'verified-content' },
});

const dependencyRun = (obligationId: string, provenance: string): Run => ({
  id: `run-${obligationId}-${provenance}`,
  obligation_id: obligationId,
  claimed_revision: `revision-${provenance}`,
  claim_commit: `claim-${provenance}`,
  obligation_key: `prior-key-${provenance}`,
  execution_generation: 1,
  execution_authority_commit: `authority-${provenance}`,
  execution_capability_sha256: provenance.repeat(64).slice(0, 64),
});

function liveBuildKey(
  obligation: Obligation,
  sourceContent = 'source-a',
  producerProvenance = 'a',
): string | null {
  const source: Obligation = {
    id: 'source',
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/inputs/source',
      content: sourceContent,
    },
  };
  const toolchain: Obligation = {
    id: 'toolchain',
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/inputs/toolchain',
      content: 'node-22',
    },
  };
  const fixtureState: State = {
    obligations: { source, toolchain, [obligation.id]: obligation },
    definition_ids: {
      source: 'definition-source',
      toolchain: 'definition-toolchain',
      [obligation.id]: 'definition-build',
    },
  };
  const lifecycles = new Map<string, Lifecycle>([
    [
      'source',
      {
        status: 'DONE',
        run: dependencyRun('source', producerProvenance),
      },
    ],
    [
      'toolchain',
      {
        status: 'DONE',
        run: dependencyRun('toolchain', producerProvenance),
      },
    ],
  ]);
  return obligationKey(fixtureState, obligation, lifecycles, new Map());
}

test('live obligation identity preserves the useful realization-key metamorphisms', () => {
  const base: Obligation & { postcondition: FileContentPostcondition } = {
    id: 'build',
    dependencies: [semanticOutput('source'), semanticOutput('toolchain')],
    packet: {
      command: 'build',
      target: 'app',
      configuration: { os: 'linux', arch: 'x64', mode: 'release' },
      source_input: { commit: '1111111111111111111111111111111111111111' },
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/artifacts/app',
      content: 'compiled artifact bytes',
    },
  };
  const baseKey = liveBuildKey(base);
  assert.ok(baseKey);

  assert.equal(
    liveBuildKey({ ...base, dependencies: [...base.dependencies].reverse() }),
    baseKey,
    'semantic dependency declaration order is not material',
  );
  assert.equal(
    liveBuildKey(base, 'source-a', 'b'),
    baseKey,
    'run and producer/audit provenance do not change verified-content identity',
  );

  const materialChanges: Obligation[] = [
    { ...base, packet: { ...base.packet, target: 'other-app' } },
    {
      ...base,
      packet: {
        ...base.packet,
        configuration: { os: 'linux', arch: 'arm64', mode: 'release' },
      },
    },
    {
      ...base,
      packet: {
        ...base.packet,
        source_input: { commit: '2222222222222222222222222222222222222222' },
      },
    },
    {
      ...base,
      postcondition: {
        ...base.postcondition,
        verifier: 'eventually-consistent-file-content-equals/v1',
      },
    },
    {
      ...base,
      postcondition: { ...base.postcondition, content: 'different artifact bytes' },
    },
  ];
  for (const changed of materialChanges) {
    assert.notEqual(liveBuildKey(changed), baseKey);
  }

  assert.notEqual(
    liveBuildKey(base, 'source-b'),
    baseKey,
    'exact semantic dependency identity is material',
  );
});

test('current realization classifier separates proof, contradiction, absence, and uncertainty', () => {
  const expected = '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd';

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition, {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: expected,
      actual_sha256: expected,
      mutation_certainty: 'present',
    }),
    {
      state: 'admissible',
      reason: 'CURRENT_POSTCONDITION_VERIFIED',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition, {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: expected,
      actual_sha256: '0'.repeat(64),
      mutation_certainty: 'present',
    }),
    {
      state: 'rejected',
      reason: 'CURRENT_POSTCONDITION_NOT_VERIFIED',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition, {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: expected,
      mutation_certainty: 'absent',
      absence_evidence: localFileEnoentEvidence('/provider/a'),
    }),
    {
      state: 'rejected',
      reason: 'CURRENT_REALIZATION_AUTHORITATIVELY_ABSENT',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition, {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: expected,
      mutation_certainty: 'uncertain',
      observation_error: 'READBACK_UNAVAILABLE',
    }),
    {
      state: 'indeterminate',
      reason: 'READBACK_UNAVAILABLE',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition, {
      verifier: 'file-content-equals/v1',
      path: '/wrong-coordinate',
      expected_sha256: expected,
      actual_sha256: expected,
      mutation_certainty: 'present',
    }),
    {
      state: 'indeterminate',
      reason: 'OBSERVATION_COORDINATE_MISMATCH',
    },
  );
});

test('observable historical DONE requires current exact-key readback and stale identity is ignored', () => {
  const run: HistoricalRun = {
    id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    obligation_key: 'key-a',
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    execution_capability_sha256: '0'.repeat(64),
    obligation: work,
    definition_id: 'define-a',
  };
  const receipt: Receipt = {
    schema: 'overcenter-git-receipt-v5',
    run_id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    kind: 'observation',
    observed: null,
    settled_at: 'now',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'receipt-a',
  };
  let observations = 0;
  const judgments = deriveCurrentRealizationJudgments({
    state,
    runs: new Map([[run.id, run]]),
    receiptsByRun: new Map([[run.id, receipt]]),
    semanticKeys: new Map([['a', 'key-a']]),
    observe: (postcondition) => {
      observations += 1;
      assert.deepEqual(postcondition, work.postcondition);
      return {
        verifier: 'file-content-equals/v1',
        path: '/provider/a',
        expected_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
        actual_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
        mutation_certainty: 'present',
      };
    },
  });

  assert.equal(observations, 1);
  assert.deepEqual(judgments.get('run-a'), {
    state: 'admissible',
    reason: 'CURRENT_POSTCONDITION_VERIFIED',
  });

  observations = 0;
  const changed = deriveCurrentRealizationJudgments({
    state,
    runs: new Map([[run.id, run]]),
    receiptsByRun: new Map([[run.id, receipt]]),
    semanticKeys: new Map([['a', 'different-key']]),
    observe: () => {
      observations += 1;
      throw new Error('should not observe stale semantic identity');
    },
  });
  assert.equal(observations, 0);
  assert.equal(changed.size, 0);
});

test('immutable source-integration settlement is reusable without turning observable effects into cache hits', () => {
  const sourceWork: Obligation = {
    id: 'source',
    dependencies: [],
    packet: { kind: 'source-change' },
    postcondition: { verifier: 'source-integration/v1' },
  };
  const sourceState: State = {
    obligations: { source: sourceWork },
    definition_ids: { source: 'define-source' },
  };
  const run: HistoricalRun = {
    id: 'run-source',
    obligation_id: 'source',
    claimed_revision: 'revision-source',
    claim_commit: 'claim-source',
    obligation_key: 'key-source',
    execution_generation: 1,
    execution_authority_commit: 'claim-source',
    execution_capability_sha256: '1'.repeat(64),
    source_revision: 'a'.repeat(40),
    obligation: sourceWork,
    definition_id: 'define-source',
  };
  const receipt: Receipt = {
    schema: 'overcenter-git-receipt-v5',
    run_id: run.id,
    obligation_id: run.obligation_id,
    claimed_revision: run.claimed_revision,
    claim_commit: run.claim_commit,
    execution_generation: run.execution_generation,
    execution_authority_commit: run.execution_authority_commit,
    kind: 'source-integration',
    observed: null,
    settled_at: 'now',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'receipt-source',
  };

  let observations = 0;
  const judgments = deriveCurrentRealizationJudgments({
    state: sourceState,
    runs: new Map([[run.id, run]]),
    receiptsByRun: new Map([[run.id, receipt]]),
    semanticKeys: new Map([['source', run.obligation_key]]),
    observe: () => {
      observations += 1;
      throw new Error('historical source integration should not be re-observed');
    },
  });

  assert.equal(observations, 0);
  assert.deepEqual(judgments.get(run.id), {
    state: 'admissible',
    reason: 'HISTORICAL_SOURCE_INTEGRATION',
  });
});
