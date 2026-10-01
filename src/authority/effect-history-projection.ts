import { canonicalDigest } from '../digest.ts';
import type { Data } from '../model.ts';
import {
  validateClaimFact,
  validateEffectReleaseFact,
  validateEffectReservationFact,
  validateExecutionAuthorityFact,
  validateGraphPatchFact,
  validateReceiptFact,
  validateSourceRevisionBindingFact,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  ObligationDefinition,
  ReceiptFact,
} from './facts.ts';

export type FourByFourSourceKind =
  | 'graph-patch'
  | 'claim'
  | 'source-revision'
  | 'execution-authority'
  | 'effect-reservation'
  | 'effect-release'
  | 'receipt';

export interface FourByFourSource {
  commit: string;
  fact: FourByFourSourceKind;
}

export interface FourByFourCoordinate {
  id: string;
  value: Data;
  sources: FourByFourSource[];
}

export interface FourByFourObject {
  id: string;
  coordinate: string;
  role: string;
  value: Data;
  sources: FourByFourSource[];
}

export interface FourByFourEvent {
  id: string;
  coordinate: string;
  role: string;
  value: Data;
  sources: FourByFourSource[];
}

export interface FourByFourProposition {
  id: string;
  coordinate: string;
  role: string;
  value: Data;
  sources: FourByFourSource[];
}

export interface FourByFourPermits {
  id: string;
  object: string;
  event: string;
  sources: FourByFourSource[];
}

export interface FourByFourAsserts {
  id: string;
  event: string;
  proposition: string;
  sources: FourByFourSource[];
}

export interface FourByFourSupports {
  id: string;
  object: string;
  proposition: string;
  sources: FourByFourSource[];
}

export interface FourByFourRequires {
  id: string;
  proposition: string;
  required: string;
  sources: FourByFourSource[];
}

export interface FourByFourProjection {
  objects: FourByFourObject[];
  events: FourByFourEvent[];
  propositions: FourByFourProposition[];
  coordinates: FourByFourCoordinate[];
  permits: FourByFourPermits[];
  asserts: FourByFourAsserts[];
  supports: FourByFourSupports[];
  requires: FourByFourRequires[];
}

interface BindingState {
  definition_id: string;
  definition: ObligationDefinition;
  sources: FourByFourSource[];
}

interface RunState {
  claim: ClaimFact;
  source_revision?: string;
  binding: BindingState;
  authorities: Map<string, { object: FourByFourObject; generation: number }>;
}

const source = (commit: string, fact: FourByFourSourceKind): FourByFourSource => ({ commit, fact });

function sourceKey(value: FourByFourSource): string {
  return `${value.commit}\u0000${value.fact}`;
}

function mergeSources(...groups: readonly FourByFourSource[][]): FourByFourSource[] {
  const unique = new Map<string, FourByFourSource>();
  for (const item of groups.flat()) unique.set(sourceKey(item), item);
  return [...unique.values()].sort(
    (left, right) => left.commit.localeCompare(right.commit) || left.fact.localeCompare(right.fact),
  );
}

function semanticId(domain: string, value: unknown): string {
  return canonicalDigest({ domain: `overcenter-4x4-${domain}-v1`, value });
}

function cloneData(value: Data): Data {
  return structuredClone(value);
}

class ProjectionBuilder {
  private readonly coordinateById = new Map<string, FourByFourCoordinate>();
  private readonly objectById = new Map<string, FourByFourObject>();
  private readonly eventById = new Map<string, FourByFourEvent>();
  private readonly propositionById = new Map<string, FourByFourProposition>();
  private readonly permitsById = new Map<string, FourByFourPermits>();
  private readonly assertsById = new Map<string, FourByFourAsserts>();
  private readonly supportsById = new Map<string, FourByFourSupports>();
  private readonly requiresById = new Map<string, FourByFourRequires>();

  coordinate(value: Data, sources: FourByFourSource[]): FourByFourCoordinate {
    const snapshot = cloneData(value);
    const id = semanticId('coordinate', snapshot);
    const existing = this.coordinateById.get(id);
    if (existing) {
      existing.sources = mergeSources(existing.sources, sources);
      return existing;
    }
    const coordinate = { id, value: snapshot, sources: mergeSources(sources) };
    this.coordinateById.set(id, coordinate);
    return coordinate;
  }

  object(
    role: string,
    coordinate: FourByFourCoordinate,
    value: Data,
    sources: FourByFourSource[],
  ): FourByFourObject {
    const snapshot = cloneData(value);
    const merged = mergeSources(sources);
    const id = semanticId('object', {
      role,
      coordinate: coordinate.id,
      value: snapshot,
      sources: merged,
    });
    const item = { id, coordinate: coordinate.id, role, value: snapshot, sources: merged };
    this.objectById.set(id, item);
    return item;
  }

  event(
    role: string,
    coordinate: FourByFourCoordinate,
    value: Data,
    sources: FourByFourSource[],
  ): FourByFourEvent {
    const snapshot = cloneData(value);
    const merged = mergeSources(sources);
    const id = semanticId('event', {
      role,
      coordinate: coordinate.id,
      value: snapshot,
      sources: merged,
    });
    const item = { id, coordinate: coordinate.id, role, value: snapshot, sources: merged };
    this.eventById.set(id, item);
    return item;
  }

  proposition(
    role: string,
    coordinate: FourByFourCoordinate,
    value: Data,
    sources: FourByFourSource[],
  ): FourByFourProposition {
    const snapshot = cloneData(value);
    const merged = mergeSources(sources);
    const id = semanticId('proposition', {
      role,
      coordinate: coordinate.id,
      value: snapshot,
      sources: merged,
    });
    const item = { id, coordinate: coordinate.id, role, value: snapshot, sources: merged };
    this.propositionById.set(id, item);
    return item;
  }

  permits(object: FourByFourObject, event: FourByFourEvent, sources: FourByFourSource[]): void {
    const merged = mergeSources(sources);
    const id = semanticId('permits', { object: object.id, event: event.id, sources: merged });
    this.permitsById.set(id, { id, object: object.id, event: event.id, sources: merged });
  }

  asserts(
    event: FourByFourEvent,
    proposition: FourByFourProposition,
    sources: FourByFourSource[],
  ): void {
    const merged = mergeSources(sources);
    const id = semanticId('asserts', {
      event: event.id,
      proposition: proposition.id,
      sources: merged,
    });
    this.assertsById.set(id, {
      id,
      event: event.id,
      proposition: proposition.id,
      sources: merged,
    });
  }

  supports(
    object: FourByFourObject,
    proposition: FourByFourProposition,
    sources: FourByFourSource[],
  ): void {
    const merged = mergeSources(sources);
    const id = semanticId('supports', {
      object: object.id,
      proposition: proposition.id,
      sources: merged,
    });
    this.supportsById.set(id, {
      id,
      object: object.id,
      proposition: proposition.id,
      sources: merged,
    });
  }

  requires(
    proposition: FourByFourProposition,
    required: FourByFourProposition,
    sources: FourByFourSource[],
  ): void {
    const merged = mergeSources(sources);
    const id = semanticId('requires', {
      proposition: proposition.id,
      required: required.id,
      sources: merged,
    });
    this.requiresById.set(id, {
      id,
      proposition: proposition.id,
      required: required.id,
      sources: merged,
    });
  }

  finish(): FourByFourProjection {
    const ordered = <T extends { id: string }>(values: Iterable<T>): T[] =>
      [...values].sort((left, right) => left.id.localeCompare(right.id));
    return {
      objects: ordered(this.objectById.values()),
      events: ordered(this.eventById.values()),
      propositions: ordered(this.propositionById.values()),
      coordinates: ordered(this.coordinateById.values()),
      permits: ordered(this.permitsById.values()),
      asserts: ordered(this.assertsById.values()),
      supports: ordered(this.supportsById.values()),
      requires: ordered(this.requiresById.values()),
    };
  }
}

function runCoordinate(
  run: RunState,
  executionGeneration: number,
  executionAuthorityCommit: string,
  extra: Data = {},
): Data {
  return {
    obligation_id: run.claim.obligation_id,
    run_id: run.claim.run_id,
    claimed_revision: run.claim.claimed_revision,
    ...(run.source_revision ? { source_revision: run.source_revision } : {}),
    execution_generation: executionGeneration,
    execution_authority_commit: executionAuthorityCommit,
    ...structuredClone(extra),
  };
}

function authorityObjectValue(
  fact: ClaimFact | ExecutionAuthorityFact,
  definitionId: string,
  generation: number,
  authorityCommit: string,
): Data {
  return {
    run_id: fact.run_id,
    obligation_id: fact.obligation_id,
    definition_id: definitionId,
    generation,
    execution_authority_commit: authorityCommit,
    execution_capability_sha256: fact.execution_capability_sha256,
  };
}

function projectClaimRequirements(
  builder: ProjectionBuilder,
  run: RunState,
  authorityCoordinate: FourByFourCoordinate,
  claimSources: FourByFourSource[],
): void {
  const definitionSources = mergeSources(run.binding.sources, claimSources);
  const obligation = builder.proposition(
    'obligation-satisfied',
    authorityCoordinate,
    {
      obligation_id: run.claim.obligation_id,
      definition_id: run.binding.definition_id,
    },
    definitionSources,
  );
  const postcondition = builder.proposition(
    'postcondition',
    authorityCoordinate,
    structuredClone(run.binding.definition.postcondition) as unknown as Data,
    definitionSources,
  );
  builder.requires(obligation, postcondition, definitionSources);

  for (const dependency of run.binding.definition.dependencies) {
    const required = builder.proposition(
      'dependency',
      authorityCoordinate,
      structuredClone(dependency) as unknown as Data,
      definitionSources,
    );
    builder.requires(obligation, required, definitionSources);
  }
}

function retainedObservationSupport(
  builder: ProjectionBuilder,
  eventCoordinate: FourByFourCoordinate,
  proposition: FourByFourProposition,
  receipt: ReceiptFact,
  receiptSources: FourByFourSource[],
): void {
  if (!receipt.observed) return;
  const observed = receipt.observed as unknown as Record<string, unknown>;
  if (observed.mutation_certainty === 'uncertain') return;
  for (const field of ['provider_evidence', 'absence_evidence'] as const) {
    const evidence = observed[field];
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) continue;
    const object = builder.object(
      'retained-evidence',
      eventCoordinate,
      { field, evidence: structuredClone(evidence) },
      receiptSources,
    );
    builder.supports(object, proposition, receiptSources);
  }
}

export function projectDurableEffectHistory(history: readonly FactCommit[]): FourByFourProjection {
  const builder = new ProjectionBuilder();
  const definitions = new Map<
    string,
    { definition: ObligationDefinition; source: FourByFourSource }
  >();
  const bindings = new Map<string, BindingState>();
  const runs = new Map<string, RunState>();
  const reservations = new Map<string, { fact: EffectReservationFact; event: FourByFourEvent }>();

  for (const record of history) {
    if (record.graph_patch != null) {
      const patchSource = source(record.commit, 'graph-patch');
      const patch = validateGraphPatchFact(record.graph_patch);
      for (const introduced of patch.definitions) {
        if (definitions.has(introduced.id)) {
          throw new Error(`4X4_PROJECTION_DUPLICATE_DEFINITION:${introduced.id}`);
        }
        definitions.set(introduced.id, { definition: introduced.definition, source: patchSource });
      }
      for (const id of patch.retire) bindings.delete(id);
      for (const binding of patch.bindings) {
        const definition = definitions.get(binding.definition_id);
        if (!definition)
          throw new Error(`4X4_PROJECTION_UNKNOWN_DEFINITION:${binding.definition_id}`);
        bindings.set(binding.node_id, {
          definition_id: binding.definition_id,
          definition: structuredClone(definition.definition),
          sources: mergeSources([definition.source], [patchSource]),
        });
      }
    }

    if (record.source_revision != null && record.claim == null) {
      throw new Error('4X4_PROJECTION_SOURCE_REVISION_WITHOUT_CLAIM');
    }

    let sourceRevision: string | undefined;
    let sourceRevisionSource: FourByFourSource | undefined;
    if (record.source_revision != null) {
      const fact = validateSourceRevisionBindingFact(record.source_revision);
      sourceRevision = fact.source_revision;
      sourceRevisionSource = source(record.commit, 'source-revision');
    }

    if (record.claim != null) {
      const fact = validateClaimFact(record.claim);
      if (runs.has(fact.run_id)) throw new Error(`4X4_PROJECTION_DUPLICATE_RUN:${fact.run_id}`);
      if (record.parent !== fact.claimed_revision) {
        throw new Error('4X4_PROJECTION_CLAIM_REVISION_MISMATCH');
      }
      const binding = bindings.get(fact.obligation_id);
      if (!binding) throw new Error(`4X4_PROJECTION_CLAIM_WITHOUT_BINDING:${fact.obligation_id}`);
      if (sourceRevision && record.source_revision != null) {
        const paired = validateSourceRevisionBindingFact(record.source_revision);
        if (paired.run_id !== fact.run_id || paired.obligation_id !== fact.obligation_id) {
          throw new Error('4X4_PROJECTION_SOURCE_REVISION_CLAIM_MISMATCH');
        }
      }
      const claimSource = source(record.commit, 'claim');
      const claimSources = mergeSources(
        [claimSource],
        sourceRevisionSource ? [sourceRevisionSource] : [],
      );
      const run: RunState = {
        claim: fact,
        ...(sourceRevision ? { source_revision: sourceRevision } : {}),
        binding,
        authorities: new Map(),
      };
      const coordinate = builder.coordinate(
        runCoordinate(run, 1, record.commit),
        mergeSources(binding.sources, claimSources),
      );
      const authority = builder.object(
        'execution-authority',
        coordinate,
        authorityObjectValue(fact, binding.definition_id, 1, record.commit),
        claimSources,
      );
      run.authorities.set(record.commit, { object: authority, generation: 1 });
      runs.set(fact.run_id, run);
      projectClaimRequirements(builder, run, coordinate, claimSources);
    }

    if (record.execution_authority != null) {
      const fact = validateExecutionAuthorityFact(record.execution_authority);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error(`4X4_PROJECTION_AUTHORITY_WITHOUT_CLAIM:${fact.run_id}`);
      const previous = run.authorities.get(fact.previous_authority_commit);
      if (!previous) {
        throw new Error(
          `4X4_PROJECTION_AUTHORITY_WITHOUT_PREVIOUS:${fact.previous_authority_commit}`,
        );
      }
      const factSource = source(record.commit, 'execution-authority');
      const coordinate = builder.coordinate(runCoordinate(run, fact.generation, record.commit), [
        factSource,
      ]);
      const authority = builder.object(
        'execution-authority',
        coordinate,
        authorityObjectValue(fact, run.binding.definition_id, fact.generation, record.commit),
        [factSource],
      );
      run.authorities.set(record.commit, { object: authority, generation: fact.generation });
    }

    let releaseProposition: FourByFourProposition | null = null;
    if (record.effect_reservation != null) {
      const fact = validateEffectReservationFact(record.effect_reservation);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error(`4X4_PROJECTION_RESERVATION_WITHOUT_CLAIM:${fact.run_id}`);
      const authority = run.authorities.get(fact.execution_authority_commit);
      if (!authority || authority.generation !== fact.execution_generation) {
        throw new Error(
          `4X4_PROJECTION_RESERVATION_WITHOUT_AUTHORITY:${fact.execution_authority_commit}`,
        );
      }
      const factSource = source(record.commit, 'effect-reservation');
      const coordinate = builder.coordinate(
        runCoordinate(run, fact.execution_generation, fact.execution_authority_commit, {
          reservation_commit: record.commit,
        }),
        [factSource],
      );
      const event = builder.event(
        'effect-attempt',
        coordinate,
        {
          run_id: fact.run_id,
          obligation_id: fact.obligation_id,
          execution_generation: fact.execution_generation,
          execution_authority_commit: fact.execution_authority_commit,
          reservation_commit: record.commit,
        },
        [factSource],
      );
      builder.permits(authority.object, event, [factSource]);
      reservations.set(record.commit, { fact, event });
    }

    if (record.effect_release != null) {
      const release = validateEffectReleaseFact(record.effect_release);
      const run = runs.get(release.run_id);
      if (!run) throw new Error(`4X4_PROJECTION_RELEASE_WITHOUT_CLAIM:${release.run_id}`);
      const reservation = reservations.get(release.reservation_commit);
      if (!reservation) {
        throw new Error(`4X4_PROJECTION_RELEASE_WITHOUT_RESERVATION:${release.reservation_commit}`);
      }
      if (
        reservation.fact.run_id !== release.run_id ||
        reservation.fact.obligation_id !== release.obligation_id ||
        reservation.fact.execution_generation !== release.execution_generation ||
        reservation.fact.execution_authority_commit !== release.execution_authority_commit
      ) {
        throw new Error('4X4_PROJECTION_RELEASE_RESERVATION_MISMATCH');
      }
      const factSource = source(record.commit, 'effect-release');
      const coordinate = builder.coordinate(
        runCoordinate(run, release.execution_generation, release.execution_authority_commit, {
          reservation_commit: release.reservation_commit,
        }),
        [factSource],
      );
      releaseProposition = builder.proposition(
        'not-dispatched',
        coordinate,
        {
          effect_contract: release.effect_contract,
          evidence_kind: release.evidence_kind,
          evidence_ref: structuredClone(release.evidence_ref),
        },
        [factSource],
      );
      const evidence = builder.object(
        'effect-release-evidence',
        coordinate,
        {
          effect_contract: release.effect_contract,
          evidence_kind: release.evidence_kind,
          evidence: structuredClone(release.evidence),
          evidence_ref: structuredClone(release.evidence_ref),
        },
        [factSource],
      );
      builder.supports(evidence, releaseProposition, [factSource]);
    }

    if (record.receipt != null) {
      const receipt = validateReceiptFact(record.receipt);
      const run = runs.get(receipt.run_id);
      if (!run) throw new Error(`4X4_PROJECTION_RECEIPT_WITHOUT_CLAIM:${receipt.run_id}`);
      const authority = run.authorities.get(receipt.execution_authority_commit);
      if (!authority || authority.generation !== receipt.execution_generation) {
        throw new Error('4X4_PROJECTION_RECEIPT_AUTHORITY_MISMATCH');
      }
      const factSource = source(record.commit, 'receipt');
      const coordinate = builder.coordinate(
        runCoordinate(run, receipt.execution_generation, receipt.execution_authority_commit, {
          settlement_commit: record.commit,
        }),
        [factSource],
      );
      const event = builder.event(
        receipt.kind === 'observation' ? 'observation' : 'receipt',
        coordinate,
        {
          kind: receipt.kind,
          settled_at: receipt.settled_at,
          ...(receipt.observed ? { observed: structuredClone(receipt.observed) } : {}),
          ...(receipt.diagnostic ? { diagnostic: structuredClone(receipt.diagnostic) } : {}),
        },
        [factSource],
      );
      const proposition =
        receipt.kind === 'effect-not-dispatched' && releaseProposition
          ? releaseProposition
          : builder.proposition(
              receipt.kind === 'observation' ? 'observation' : 'receipt',
              coordinate,
              receipt.observed
                ? (structuredClone(receipt.observed) as unknown as Data)
                : {
                    kind: receipt.kind,
                    ...(receipt.diagnostic
                      ? { diagnostic: structuredClone(receipt.diagnostic) }
                      : {}),
                  },
              [factSource],
            );
      builder.asserts(event, proposition, [factSource]);
      retainedObservationSupport(builder, coordinate, proposition, receipt, [factSource]);
    }
  }

  return builder.finish();
}
