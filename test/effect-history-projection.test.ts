import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_SCHEMA,
  EFFECT_RELEASE_SCHEMA,
  EFFECT_RELEASE_SCHEMA_VERSION,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  GRAPH_PATCH_SCHEMA,
  RECEIPT_SCHEMA,
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
  type FactCommit,
} from '../src/authority/facts.ts';
import {
  EFFECT_RELEASE_EVIDENCE_SCHEMA,
  EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION,
  effectReleaseEvidenceRef,
  type EffectReleaseEvidence,
} from '../src/effect-release-witness.ts';
import {
  projectDurableEffectHistory,
  type FourByFourProjection,
} from '../src/authority/effect-history-projection.ts';

const oid = (character: string): string => character.repeat(40);
const digest = (character: string): string => character.repeat(64);

function graph(
  commit: string,
  parent: string | null,
  content = 'done',
): { record: FactCommit; definition_id: string } {
  const obligation = normalizeObligation({
    id: 'effect',
    dependencies: [],
    packet: { effect_contract: 'fixture-effect/v1' },
    postcondition: { verifier: 'file-content-equals/v1', path: '/tmp/effect', content },
  });
  const definition = obligationDefinition(obligation);
  const definition_id = obligationDefinitionId(definition);
  return {
    definition_id,
    record: {
      commit,
      parent,
      graph_patch: {
        schema: GRAPH_PATCH_SCHEMA,
        definitions: [{ id: definition_id, definition }],
        bindings: [{ node_id: 'effect', definition_id }],
        retire: [],
      },
    },
  };
}

function claim(commit: string, parent: string, runId: string): FactCommit {
  return {
    commit,
    parent,
    claim: {
      schema: CLAIM_SCHEMA,
      run_id: runId,
      obligation_id: 'effect',
      claimed_revision: parent,
      obligation_key: `key-${runId}`,
      execution_capability_sha256: digest(runId === 'run-1' ? '1' : '2'),
    },
  };
}

function reservation(
  commit: string,
  parent: string,
  runId: string,
  generation: number,
  authorityCommit: string,
): FactCommit {
  return {
    commit,
    parent,
    effect_reservation: {
      schema: EFFECT_RESERVATION_SCHEMA,
      run_id: runId,
      obligation_id: 'effect',
      execution_generation: generation,
      execution_authority_commit: authorityCommit,
    },
  };
}

function observationReceipt({
  commit,
  parent,
  runId,
  claimCommit,
  authorityCommit,
  generation,
  certainty,
}: {
  commit: string;
  parent: string;
  runId: string;
  claimCommit: string;
  authorityCommit: string;
  generation: number;
  certainty: 'present' | 'uncertain';
}): FactCommit {
  return {
    commit,
    parent,
    receipt: {
      schema: RECEIPT_SCHEMA,
      run_id: runId,
      obligation_id: 'effect',
      claimed_revision: oid('a'),
      claim_commit: claimCommit,
      execution_generation: generation,
      execution_authority_commit: authorityCommit,
      kind: 'observation',
      observed: {
        verifier: 'file-content-equals/v1',
        mutation_certainty: certainty,
        path: '/tmp/effect',
        expected_sha256: digest('a'),
        ...(certainty === 'present'
          ? { actual_sha256: digest('a') }
          : {
              observation_error: 'READ_FAILED',
              provider_evidence: { operation_id: 'fixture-read', status: 'indeterminate' },
            }),
      },
      settled_at: '2026-10-01T20:00:00.000Z',
    },
  };
}

function successHistory(): FactCommit[] {
  const g = graph(oid('a'), null);
  const c = claim(oid('b'), g.record.commit, 'run-1');
  const r = reservation(oid('c'), c.commit, 'run-1', 1, c.commit);
  const receipt = observationReceipt({
    commit: oid('d'),
    parent: r.commit,
    runId: 'run-1',
    claimCommit: c.commit,
    authorityCommit: c.commit,
    generation: 1,
    certainty: 'present',
  });
  return [g.record, c, r, receipt];
}

function notDispatchedHistory(): FactCommit[] {
  const g = graph(oid('a'), null);
  const c = claim(oid('b'), g.record.commit, 'run-1');
  const r = reservation(oid('c'), c.commit, 'run-1', 1, c.commit);
  const evidence: EffectReleaseEvidence = {
    schema: EFFECT_RELEASE_EVIDENCE_SCHEMA,
    schema_version: EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION,
    kind: 'trusted-not-dispatched',
    source: 'fixture',
    attempt: {
      run_id: 'run-1',
      obligation_id: 'effect',
      execution_generation: 1,
      execution_authority_commit: c.commit,
      reservation_commit: r.commit,
      effect_contract: 'fixture-effect/v1',
    },
    observation: { outcome: 'not-dispatched' },
  };
  const releaseCommit = oid('d');
  return [
    g.record,
    c,
    r,
    {
      commit: releaseCommit,
      parent: r.commit,
      effect_release: {
        schema: EFFECT_RELEASE_SCHEMA,
        schema_version: EFFECT_RELEASE_SCHEMA_VERSION,
        run_id: 'run-1',
        obligation_id: 'effect',
        execution_generation: 1,
        execution_authority_commit: c.commit,
        reservation_commit: r.commit,
        effect_contract: 'fixture-effect/v1',
        evidence_kind: evidence.kind,
        evidence,
        evidence_ref: effectReleaseEvidenceRef(evidence),
      },
      receipt: {
        schema: RECEIPT_SCHEMA,
        run_id: 'run-1',
        obligation_id: 'effect',
        claimed_revision: g.record.commit,
        claim_commit: c.commit,
        execution_generation: 1,
        execution_authority_commit: c.commit,
        kind: 'effect-not-dispatched',
        observed: null,
        settled_at: '2026-10-01T20:00:00.000Z',
      },
    },
  ];
}

function recoveryHistory(): FactCommit[] {
  const g = graph(oid('a'), null);
  const c = claim(oid('b'), g.record.commit, 'run-1');
  const r = reservation(oid('c'), c.commit, 'run-1', 1, c.commit);
  return [
    g.record,
    c,
    r,
    observationReceipt({
      commit: oid('d'),
      parent: r.commit,
      runId: 'run-1',
      claimCommit: c.commit,
      authorityCommit: c.commit,
      generation: 1,
      certainty: 'uncertain',
    }),
  ];
}

function staleGenerationHistory(): FactCommit[] {
  const g = graph(oid('a'), null);
  const c = claim(oid('b'), g.record.commit, 'run-1');
  const advanced = oid('c');
  return [
    g.record,
    c,
    {
      commit: advanced,
      parent: c.commit,
      execution_authority: {
        schema: EXECUTION_AUTHORITY_SCHEMA,
        run_id: 'run-1',
        obligation_id: 'effect',
        generation: 2,
        previous_authority_commit: c.commit,
        execution_capability_sha256: digest('3'),
      },
    },
    reservation(oid('d'), advanced, 'run-1', 2, advanced),
  ];
}

function terminalHistory(): FactCommit[] {
  const first = successHistory();
  const g2 = graph(oid('e'), first.at(-1)!.commit, 'done-v2');
  const c2 = claim(oid('f'), g2.record.commit, 'run-2');
  return [...first, g2.record, c2];
}

const fixtures = [
  ['success', successHistory],
  ['ready-not-dispatched', notDispatchedHistory],
  ['recovery-required', recoveryHistory],
  ['stale-generation', staleGenerationHistory],
  ['terminal-history', terminalHistory],
] as const;

function allSources(projection: FourByFourProjection) {
  return [
    ...projection.objects,
    ...projection.events,
    ...projection.propositions,
    ...projection.coordinates,
    ...projection.permits,
    ...projection.asserts,
    ...projection.supports,
    ...projection.requires,
  ].flatMap((item) => item.sources);
}

for (const [name, fixture] of fixtures) {
  test(`4x4 durable projection is deterministic and source-backed: ${name}`, () => {
    const history = fixture();
    const first = projectDurableEffectHistory(history);
    const second = projectDurableEffectHistory(structuredClone(history));
    assert.deepEqual(second, first);

    const commits = new Set(history.map((record) => record.commit));
    const sources = allSources(first);
    assert.ok(sources.length > 0);
    assert.ok(sources.every((item) => commits.has(item.commit)));
  });
}

test('reservation permit is bound to the exact current generation, not stale authority', () => {
  const projection = projectDurableEffectHistory(staleGenerationHistory());
  const authorities = projection.objects.filter((item) => item.role === 'execution-authority');
  assert.equal(authorities.length, 2);
  const current = authorities.find((item) => item.value.generation === 2);
  const stale = authorities.find((item) => item.value.generation === 1);
  const attempt = projection.events.find((item) => item.role === 'effect-attempt');
  if (!current || !stale || !attempt) throw new Error('STALE_GENERATION_FIXTURE_INCOMPLETE');
  assert.ok(
    projection.permits.some((edge) => edge.object === current.id && edge.event === attempt.id),
  );
  assert.equal(
    projection.permits.some((edge) => edge.object === stale.id && edge.event === attempt.id),
    false,
  );
});

test('trusted not-dispatched evidence supports the exact attempt proposition', () => {
  const projection = projectDurableEffectHistory(notDispatchedHistory());
  const evidence = projection.objects.find((item) => item.role === 'effect-release-evidence');
  const proposition = projection.propositions.find((item) => item.role === 'not-dispatched');
  if (!evidence || !proposition) throw new Error('NOT_DISPATCHED_FIXTURE_INCOMPLETE');
  assert.equal(evidence.coordinate, proposition.coordinate);
  assert.ok(
    projection.supports.some(
      (edge) => edge.object === evidence.id && edge.proposition === proposition.id,
    ),
  );
  assert.ok(projection.asserts.some((edge) => edge.proposition === proposition.id));
});

test('uncertain observations remain explicit and are not promoted into support', () => {
  const projection = projectDurableEffectHistory(recoveryHistory());
  const proposition = projection.propositions.find((item) => item.role === 'observation');
  if (!proposition) throw new Error('RECOVERY_FIXTURE_INCOMPLETE');
  assert.equal(proposition.value.mutation_certainty, 'uncertain');
  assert.equal(
    projection.supports.some((edge) => edge.proposition === proposition.id),
    false,
  );
});

test('terminal history survives semantic rebinding instead of being overwritten', () => {
  const projection = projectDurableEffectHistory(terminalHistory());
  const postconditions = projection.propositions.filter((item) => item.role === 'postcondition');
  assert.equal(postconditions.length, 2);
  assert.deepEqual(postconditions.map((item) => item.value.content).sort(), ['done', 'done-v2']);
  assert.equal(projection.events.filter((item) => item.role === 'observation').length, 1);
});
