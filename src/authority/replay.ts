import type { Data, Obligation } from '../model.ts';
import { isData } from '../validation.ts';
import { authoritativeAbsenceEvidence, observationVerified } from '../observation/observe.ts';
import {
  emptyState,
  validateClaimFact,
  validateEffectReleaseFact,
  validateEffectReservationFact,
  materializeObligation,
  validateExecutionAuthorityFact,
  validateGraphPatchFact,
  validateReceiptFact,
  validateSourceRevisionBindingFact,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservation,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationDefinition,
  Receipt,
  ReceiptFact,
  SourceRevisionBindingFact,
  State,
} from './facts.ts';
import { validateGraph } from '../graph/topology.ts';
import { settlementSemantics } from '../semantics.ts';
import {
  effectPostconditionBindingSafe,
  reservedEffectReleaseWitnessSafe,
  reservedEffectReplaySafe,
} from '../effect-adapter.ts';
import {
  effectReleaseAuthorityError,
  effectReservationAuthorityError,
  executionAuthorityAdvanceError,
  receiptAuthorityError,
} from './transaction-admission.ts';
import { validateSourceIntegrationEvidence } from '../source/source-integration-evidence.ts';
import {
  deriveClaimPrerequisites,
  deriveProjectProjection,
  hasInFlight,
  type ProjectProjection as WorkProjection,
} from './project-state.ts';

export interface HistoryProjection {
  runs: Map<string, HistoricalRun>;
  receiptsByRun: Map<string, Receipt>;
  unresolvedReservationsByRun: Map<string, EffectReservation>;
  reservationsByRun?: Map<string, EffectReservation>;
  receipts: Receipt[];
  currentBindingOrdinals: Map<string, number>;
  claimOrdinalsByRun: Map<string, number>;
  authorityOrdinal: number;
}

export interface Projection {
  state: State;
  definitions: Record<string, ObligationDefinition>;
  project: WorkProjection;
  history: HistoryProjection;
}

export const CURRENT_REALIZATION_REFRESH_SCHEMA =
  'overcenter-current-realization-refresh/v1' as const;

export function currentRealizationRefreshDiagnostic(priorSettlementCommit: string): Data {
  return {
    current_realization_refresh: {
      schema: CURRENT_REALIZATION_REFRESH_SCHEMA,
      prior_settlement_commit: priorSettlementCommit,
    },
  };
}

function currentRealizationRefreshBinding(fact: ReceiptFact): string | null {
  const value = fact.diagnostic?.current_realization_refresh;
  if (value === undefined) return null;
  if (
    !isData(value) ||
    value.schema !== CURRENT_REALIZATION_REFRESH_SCHEMA ||
    typeof value.prior_settlement_commit !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(value.prior_settlement_commit) ||
    Object.keys(value).some((key) => key !== 'schema' && key !== 'prior_settlement_commit')
  ) {
    throw new Error('CURRENT_REALIZATION_REFRESH_INVALID');
  }
  return value.prior_settlement_commit;
}

export function projectReceipt(
  fact: ReceiptFact,
  work: Obligation,
  settlementCommit?: string,
  unresolvedEffect = false,
  notDispatchedRelease = false,
): Receipt {
  let disposition: Receipt['disposition'];
  let verified = false;

  if (fact.kind === 'source-integration') {
    if (fact.observed) throw new Error('SOURCE_INTEGRATION_RECEIPT_HAS_OBSERVATION');
    validateSourceIntegrationEvidence(fact.diagnostic?.source_integration);
    disposition = 'DONE';
    verified = true;
  } else if (fact.kind === 'source-retry') {
    if (fact.observed) throw new Error('SOURCE_RETRY_RECEIPT_HAS_OBSERVATION');
    disposition = 'READY';
  } else if (fact.kind === 'observation') {
    if (!fact.observed) throw new Error('OBSERVATION_RECEIPT_MISSING_EVIDENCE');
    verified = observationVerified(work.postcondition, fact.observed);
    const policy = settlementSemantics(work.postcondition);
    const absenceEvidence = authoritativeAbsenceEvidence(work.postcondition, fact.observed);
    const acceptedAbsence =
      absenceEvidence && policy.acceptedAbsenceEvidenceKinds.includes(absenceEvidence.kind);
    const replaySafe =
      !unresolvedEffect ||
      (absenceEvidence !== null && reservedEffectReplaySafe(work, absenceEvidence));
    disposition = verified ? 'DONE' : acceptedAbsence && replaySafe ? 'READY' : 'RECOVERY_REQUIRED';
  } else {
    if (fact.observed) throw new Error('NONOBSERVATION_RECEIPT_HAS_EVIDENCE');
    disposition =
      fact.kind === 'judgment-required'
        ? 'WAITING'
        : fact.kind === 'effect-not-dispatched' && notDispatchedRelease
          ? 'READY'
          : 'RECOVERY_REQUIRED';
  }

  return {
    ...fact,
    disposition,
    verified,
    ...(settlementCommit ? { settlement_commit: settlementCommit } : {}),
  };
}

export function replayProjection(
  commits: FactCommit[],
  base: Projection | null = null,
): Projection {
  const state = base
    ? {
        obligations: { ...base.state.obligations },
        definition_ids: { ...base.state.definition_ids },
      }
    : emptyState();
  const definitions: Record<string, ObligationDefinition> = base ? { ...base.definitions } : {};
  const runs = base ? new Map(base.history.runs) : new Map<string, HistoricalRun>();
  const receiptsByRun = base ? new Map(base.history.receiptsByRun) : new Map<string, Receipt>();
  const unresolvedReservationsByRun = base
    ? new Map(base.history.unresolvedReservationsByRun)
    : new Map<string, EffectReservation>();
  const reservationsByRun = base?.history.reservationsByRun
    ? new Map(base.history.reservationsByRun)
    : new Map<string, EffectReservation>();
  const receipts = base ? [...base.history.receipts] : [];
  const currentBindingOrdinals = base
    ? new Map(base.history.currentBindingOrdinals)
    : new Map<string, number>();
  const claimOrdinalsByRun = base
    ? new Map(base.history.claimOrdinalsByRun)
    : new Map<string, number>();
  let authorityOrdinal = base?.history.authorityOrdinal ?? 0;
  let project =
    base?.project ??
    deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision: '',
      currentBindingOrdinals,
      claimOrdinalsByRun,
    });

  const refresh = (revision: string): void => {
    project = deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision,
      currentBindingOrdinals,
      claimOrdinalsByRun,
    });
  };

  for (const record of commits) {
    authorityOrdinal += 1;
    let notDispatchedRelease = false;
    if (record.graph_patch != null) {
      refresh(record.parent ?? '');
      if (hasInFlight(project)) throw new Error('GRAPH_PATCH_WHILE_IN_FLIGHT');

      const patch = validateGraphPatchFact(record.graph_patch);
      for (const introduced of patch.definitions) {
        if (definitions[introduced.id]) {
          throw new Error(`DUPLICATE_DEFINITION:${introduced.id}`);
        }
        definitions[introduced.id] = structuredClone(introduced.definition);
      }

      for (const id of patch.retire) {
        if (!state.obligations[id]) {
          throw new Error(`RETIRE_UNKNOWN_OBLIGATION:${id}`);
        }
        delete state.obligations[id];
        delete state.definition_ids[id];
        currentBindingOrdinals.delete(id);
      }

      for (const binding of patch.bindings) {
        const definition = definitions[binding.definition_id];
        if (!definition) {
          throw new Error(`UNKNOWN_OBLIGATION_DEFINITION:${binding.definition_id}`);
        }
        state.obligations[binding.node_id] = materializeObligation(binding.node_id, definition);
        state.definition_ids[binding.node_id] = binding.definition_id;
        currentBindingOrdinals.set(binding.node_id, authorityOrdinal);
      }

      validateGraph(state);
    }

    if (record.source_revision != null && record.claim == null) {
      throw new Error('SOURCE_REVISION_WITHOUT_CLAIM');
    }

    if (record.claim != null) {
      const claim = validateClaimFact(record.claim);
      const sourceRevision: SourceRevisionBindingFact | null =
        record.source_revision == null
          ? null
          : validateSourceRevisionBindingFact(record.source_revision);
      if (
        sourceRevision &&
        (sourceRevision.run_id !== claim.run_id ||
          sourceRevision.obligation_id !== claim.obligation_id)
      ) {
        throw new Error('SOURCE_REVISION_CLAIM_MISMATCH');
      }
      const obligation = state.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent !== claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      refresh(record.commit);
      const prerequisites = deriveClaimPrerequisites(
        obligation,
        project.lifecycles,
        project.semanticKeys.get(claim.obligation_id) ?? null,
      );
      if (prerequisites.error === 'NOT_READY') throw new Error('CLAIM_WHILE_NOT_READY');
      if (prerequisites.error === 'DEPENDENCIES_NOT_DONE') {
        throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');
      }
      if (prerequisites.error === 'SEMANTIC_DEPENDENCY_UNRESOLVED') {
        throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      }

      const expectedKey = prerequisites.semanticKey;
      if (!expectedKey) throw new Error('CLAIM_PREREQUISITES_INCONSISTENT');
      if (claim.obligation_key !== expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

      const run: HistoricalRun = {
        id: claim.run_id,
        obligation_id: claim.obligation_id,
        claimed_revision: claim.claimed_revision,
        claim_commit: record.commit,
        obligation_key: claim.obligation_key,
        execution_generation: 1,
        execution_authority_commit: record.commit,
        execution_capability_sha256: claim.execution_capability_sha256,
        ...(sourceRevision ? { source_revision: sourceRevision.source_revision } : {}),
        obligation: structuredClone(obligation),
        definition_id: state.definition_ids[claim.obligation_id]!,
      };
      runs.set(run.id, run);
      claimOrdinalsByRun.set(run.id, authorityOrdinal);
    }

    if (record.execution_authority != null) {
      const fact = validateExecutionAuthorityFact(record.execution_authority);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error('EXECUTION_AUTHORITY_WITHOUT_CLAIM');
      const authorityError = executionAuthorityAdvanceError(run, fact);
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (
        current?.run?.id !== run.id ||
        !['EXECUTING', 'WAITING', 'RECOVERY_REQUIRED'].includes(current.status)
      ) {
        throw new Error('EXECUTION_AUTHORITY_FOR_NONCURRENT_RUN');
      }
      runs.set(run.id, {
        ...run,
        execution_generation: fact.generation,
        execution_authority_commit: record.commit,
        execution_capability_sha256: fact.execution_capability_sha256,
      });
    }

    if (record.effect_reservation != null) {
      const fact = validateEffectReservationFact(record.effect_reservation);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error('EFFECT_RESERVATION_WITHOUT_CLAIM');
      const authorityError = effectReservationAuthorityError(
        run,
        fact,
        unresolvedReservationsByRun.has(run.id),
      );
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (current?.run?.id !== run.id || current.status !== 'EXECUTING') {
        throw new Error('EFFECT_RESERVATION_WHILE_NOT_EXECUTING');
      }
      if (
        fact.effect_contract !== undefined &&
        fact.postcondition !== undefined &&
        !effectPostconditionBindingSafe(run.obligation, fact.effect_contract, fact.postcondition)
      ) {
        throw new Error('EFFECT_RESERVATION_POSTCONDITION_UNAUTHORIZED');
      }
      const reservation = {
        ...fact,
        reservation_commit: record.commit,
      };
      reservationsByRun.set(run.id, reservation);
      unresolvedReservationsByRun.set(run.id, reservation);
    }

    if (record.effect_release != null) {
      const release = validateEffectReleaseFact(record.effect_release);
      const run = runs.get(release.run_id);
      if (!run) throw new Error('EFFECT_RELEASE_WITHOUT_CLAIM');
      const reservation = unresolvedReservationsByRun.get(run.id);
      if (!reservation) throw new Error('EFFECT_RELEASE_WITHOUT_RESERVATION');
      const authorityError = effectReleaseAuthorityError(run, reservation, release);
      if (authorityError) throw new Error(authorityError);
      if (
        release.effect_contract !== run.obligation.packet.effect_contract ||
        (reservation.effect_contract !== undefined &&
          release.effect_contract !== reservation.effect_contract)
      ) {
        throw new Error('EFFECT_RELEASE_CONTRACT_MISMATCH');
      }
      if (
        !reservedEffectReleaseWitnessSafe(run.obligation, release.effect_contract, {
          kind: release.evidence.kind,
          source: release.evidence.source,
          attempt: release.evidence.attempt,
          observation: release.evidence.observation,
        })
      ) {
        throw new Error('EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED');
      }
      if (record.receipt == null) throw new Error('EFFECT_RELEASE_WITHOUT_READY_RECEIPT');
      const paired = validateReceiptFact(record.receipt);
      if (paired.kind !== 'effect-not-dispatched') {
        throw new Error('EFFECT_RELEASE_RECEIPT_KIND_MISMATCH');
      }
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (current?.run?.id !== run.id || current.status !== 'EXECUTING') {
        throw new Error('EFFECT_RELEASE_WHILE_NOT_EXECUTING');
      }
      unresolvedReservationsByRun.delete(run.id);
      notDispatchedRelease = true;
    }

    if (record.receipt == null) continue;
    const fact = validateReceiptFact(record.receipt);
    const run = runs.get(fact.run_id);
    if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
    const receiptError = receiptAuthorityError(run, fact);
    if (receiptError) throw new Error(receiptError);

    refresh(record.commit);
    const current = project.lifecycles.get(run.obligation_id);
    if (current?.run?.id !== run.id) throw new Error('RECEIPT_FOR_NONCURRENT_RUN');
    const previous = receiptsByRun.get(run.id);
    const refreshBinding = currentRealizationRefreshBinding(fact);
    const realizationRefresh = refreshBinding !== null;
    if (realizationRefresh) {
      if (
        fact.kind !== 'observation' ||
        current.status !== 'DONE' ||
        !previous ||
        previous.disposition !== 'DONE' ||
        previous.kind === 'source-integration' ||
        previous.settlement_commit !== refreshBinding ||
        unresolvedReservationsByRun.has(run.id)
      ) {
        throw new Error('CURRENT_REALIZATION_REFRESH_BINDING_MISMATCH');
      }
    }
    if (fact.kind === 'judgment-required' && current.status !== 'EXECUTING') {
      throw new Error('JUDGMENT_REQUIRED_WHILE_NOT_EXECUTING');
    }
    if (fact.kind === 'judgment-required' && unresolvedReservationsByRun.has(run.id)) {
      throw new Error('JUDGMENT_REQUIRED_WITH_UNRESOLVED_EFFECT');
    }
    if (fact.kind === 'execution-terminated' && current.status !== 'EXECUTING') {
      throw new Error('EXECUTION_TERMINATED_WHILE_NOT_EXECUTING');
    }
    if (
      (fact.kind === 'source-integration' || fact.kind === 'source-retry') &&
      current.status !== 'EXECUTING'
    ) {
      throw new Error('SOURCE_RECEIPT_WHILE_NOT_EXECUTING');
    }
    if (
      (fact.kind === 'source-integration' || fact.kind === 'source-retry') &&
      (run.obligation.packet.kind !== 'source-change' ||
        run.obligation.postcondition.verifier !== 'source-integration/v1')
    ) {
      throw new Error('SOURCE_RECEIPT_FOR_NON_SOURCE_WORK');
    }
    if (fact.kind === 'source-integration' && !unresolvedReservationsByRun.has(run.id)) {
      throw new Error('SOURCE_INTEGRATION_WITHOUT_RESERVED_EFFECT');
    }
    if (fact.kind === 'source-retry' && unresolvedReservationsByRun.has(run.id)) {
      throw new Error('SOURCE_RETRY_WITH_UNRESOLVED_EFFECT');
    }
    if (fact.kind === 'effect-not-dispatched' && !notDispatchedRelease) {
      throw new Error('EFFECT_NOT_DISPATCHED_RECEIPT_WITHOUT_RELEASE');
    }
    if (
      fact.kind === 'observation' &&
      !realizationRefresh &&
      !['EXECUTING', 'WAITING', 'RECOVERY_REQUIRED'].includes(current.status)
    ) {
      throw new Error('OBSERVATION_WHILE_NOT_RESOLVABLE');
    }
    if (previous && ['DONE', 'READY'].includes(previous.disposition) && !realizationRefresh) {
      throw new Error('RECEIPT_AFTER_TERMINAL_SETTLEMENT');
    }

    const unresolvedEffect = unresolvedReservationsByRun.has(run.id);
    const reservation = unresolvedReservationsByRun.get(run.id);
    const settledWork =
      reservation?.postcondition === undefined
        ? run.obligation
        : { ...run.obligation, postcondition: structuredClone(reservation.postcondition) };
    const receipt = projectReceipt(
      fact,
      settledWork,
      record.commit,
      unresolvedEffect,
      notDispatchedRelease,
    );
    receiptsByRun.set(run.id, receipt);
    if (receipt.disposition === 'DONE' || receipt.disposition === 'READY') {
      unresolvedReservationsByRun.delete(run.id);
    }
    receipts.push(receipt);
  }

  const revision = commits.at(-1)?.commit ?? base?.project.work[0]?.revision ?? '';
  refresh(revision);
  return {
    state,
    definitions,
    project,
    history: {
      runs,
      receiptsByRun,
      unresolvedReservationsByRun,
      reservationsByRun,
      receipts,
      currentBindingOrdinals,
      claimOrdinalsByRun,
      authorityOrdinal,
    },
  };
}

export function advanceProjection(previous: Projection, record: FactCommit): Projection {
  return replayProjection([record], previous);
}
