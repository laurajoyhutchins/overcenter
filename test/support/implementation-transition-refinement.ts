import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FourByFourRelation = 'permits' | 'asserts' | 'supports' | 'requires';

export interface ImplementationTransitionSources {
  readonly transactionAdmission: string;
  readonly engine: string;
  readonly replay: string;
  readonly settlement: string;
  readonly formalKernel: string;
  readonly formalConfig: string;
}

export interface ImplementationTransition {
  readonly id:
    | 'dispatch-effect'
    | 'release-not-dispatched'
    | 'observation-receipt'
    | 'source-integration-receipt';
  readonly durable: boolean;
  readonly relations: readonly FourByFourRelation[];
  readonly formalActions: readonly string[];
}

export interface ImplementationTransitionRefinement {
  readonly transitions: readonly ImplementationTransition[];
  readonly hostileGuards: {
    readonly staleAuthority: true;
    readonly evidenceMigration: true;
    readonly ambiguity: true;
    readonly aba: true;
    readonly duplicateEffect: true;
  };
}

function fail(label: string, detail: string): never {
  throw new Error(`IMPLEMENTATION_TRANSITION_REFINEMENT_${label}:${detail}`);
}

function section(source: string, label: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) fail('SOURCE_SHAPE', `${label}:missing:${start}`);
  const endIndex =
    end === undefined ? source.length : source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) fail('SOURCE_SHAPE', `${label}:missing-end:${end}`);
  return source.slice(startIndex, endIndex);
}

function requireIncludes(label: string, source: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!source.includes(token)) fail('DRIFT', `${label}:missing:${token}`);
  }
}

function requireOrdered(label: string, source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const index = source.indexOf(token, cursor);
    if (index < 0) fail('DRIFT', `${label}:missing-or-reordered:${token}`);
    cursor = index + token.length;
  }
}

export function readImplementationTransitionSources(
  root = process.cwd(),
): ImplementationTransitionSources {
  return {
    transactionAdmission: readFileSync(
      resolve(root, 'src/authority/transaction-admission.ts'),
      'utf8',
    ),
    engine: readFileSync(resolve(root, 'src/authority/engine.ts'), 'utf8'),
    replay: readFileSync(resolve(root, 'src/authority/replay.ts'), 'utf8'),
    settlement: readFileSync(resolve(root, 'src/authority/settlement.ts'), 'utf8'),
    formalKernel: readFileSync(resolve(root, 'formal/TransitionKernel.tla'), 'utf8'),
    formalConfig: readFileSync(resolve(root, 'formal/TransitionKernel.cfg'), 'utf8'),
  };
}

export function verifyImplementationTransitionRefinement(
  sources: ImplementationTransitionSources,
): ImplementationTransitionRefinement {
  const authorityProjection = section(
    sources.transactionAdmission,
    'executionPermits',
    'export function projectExecutionAuthority(',
    '\nexport const executionPermits',
  );
  requireIncludes('executionPermits', authorityProjection, [
    'permit.id === run.id',
    'permit.obligation_id === run.obligation_id',
    'permit.claimed_revision === run.claimed_revision',
    'permit.claim_commit === run.claim_commit',
    'permit.obligation_key === run.obligation_key',
    'permit.execution_generation === run.execution_generation',
    'permit.execution_authority_commit === run.execution_authority_commit',
    'permit.execution_capability_sha256 === run.execution_capability_sha256',
    'capabilitySha256 === run.execution_capability_sha256',
  ]);

  const permits = section(
    sources.transactionAdmission,
    'executionPermits',
    'export const executionPermits = (',
    '\nexport type EffectReservationAuthorityError',
  );
  requireIncludes('executionPermits', permits, [
    'projectExecutionAuthority(run, permit, capabilitySha256)',
    '.every((value) => value)',
  ]);

  requireIncludes('mutationAdmitted', sources.transactionAdmission, [
    's.current_authority && s.exact_revision && !s.unresolved_effect',
    'export const mutationAdmitted = effectAdmissionDecision;',
  ]);

  const authorityAdvance = section(
    sources.transactionAdmission,
    'executionAuthorityAdvanceError',
    'export function executionAuthorityAdvanceError(',
    '\nexport type EffectAdmissionState',
  );
  requireIncludes('executionAuthorityAdvanceError', authorityAdvance, [
    'fact.generation !== run.execution_generation + 1',
    'fact.previous_authority_commit !== run.execution_authority_commit',
  ]);

  const receiptAuthority = section(
    sources.transactionAdmission,
    'receiptAuthorityError',
    'export function receiptAuthorityError(',
    '\nexport type ExecutionAuthorityAdvanceError',
  );
  requireIncludes('receiptAuthorityError', receiptAuthority, [
    'fact.claimed_revision !== run.claimed_revision',
    'fact.claim_commit !== run.claim_commit',
    'fact.execution_generation !== run.execution_generation',
    'fact.execution_authority_commit !== run.execution_authority_commit',
  ]);

  const beginEffect = section(
    sources.engine,
    'beginEffect',
    '  beginEffect(permit: ExecutionPermit): string {',
    '\n  async performEffect<',
  );
  requireOrdered('beginEffect', beginEffect, [
    'const authority = projectExecutionAuthority(',
    '!authority.current_authority || !authority.exact_revision',
    "throw new Error('STALE_EXECUTION_GENERATION')",
    "lifecycle.status !== 'EXECUTING'",
    '!mutationAdmitted({',
    '...authority',
    'unresolved_effect: history.unresolvedReservationsByRun.has(run.id)',
    "throw new Error('UNRESOLVED_EFFECT')",
    "'effect-reservation.json': fact",
  ]);

  const performEffect = section(
    sources.engine,
    'performEffect',
    '  async performEffect<',
    '\n  performEffectSync<',
  );
  requireOrdered('performEffect', performEffect, [
    'const reservationCommit = this.beginEffect(permit);',
    'return await effect(attempt);',
  ]);

  const performEffectSync = section(
    sources.engine,
    'performEffectSync',
    '  performEffectSync<',
    '\n  releaseEffectReservation<',
  );
  requireOrdered('performEffectSync', performEffectSync, [
    'const reservationCommit = this.beginEffect(permit);',
    'return effect(attempt);',
  ]);

  const release = section(
    sources.engine,
    'releaseEffectReservation',
    '  releaseEffectReservation<',
    '\n  settleSourceIntegration(',
  );
  requireOrdered('releaseEffectReservation', release, [
    '!executionPermits(',
    "throw new Error('STALE_EXECUTION_GENERATION')",
    'history.unresolvedReservationsByRun.get(run.id)',
    'binding.run_id !== run.id',
    'binding.obligation_id !== run.obligation_id',
    'binding.execution_generation !== run.execution_generation',
    'binding.execution_authority_commit !== run.execution_authority_commit',
    'binding.reservation_commit !== reservation.reservation_commit',
    'binding.effect_contract !== effectContract',
    'reservedEffectReleaseWitnessSafe(',
    'retainEffectReleaseEvidence(validatedWitness)',
    "'effect-release.json': release",
    "'receipt.json': receiptFact",
    "receipt.disposition !== 'READY'",
  ]);

  const sourceIntegration = section(
    sources.engine,
    'settleSourceIntegration',
    '  settleSourceIntegration(',
    '\n  retrySourceIntegration(',
  );
  requireOrdered('settleSourceIntegration', sourceIntegration, [
    "work.packet.kind !== 'source-change'",
    'work.packet.effect_contract !== GITHUB_SOURCE_INTEGRATION_EFFECT',
    "work.postcondition.verifier !== 'source-integration/v1'",
    'evidence.run_id !== run.id',
    'evidence.obligation_key !== run.obligation_key',
    'evidence.source_sha !== run.source_revision',
    "receipt.disposition !== 'DONE' || !receipt.verified",
  ]);

  const resolution = section(
    sources.engine,
    'resolutionCandidate',
    '  #resolutionCandidate(permit: ExecutionPermit):',
    '\n  #commitObservation(',
  );
  requireOrdered('resolutionCandidate', resolution, [
    'const run = this.#requireExecutionPermit(history, permit);',
    "['EXECUTING', 'RECOVERY_REQUIRED', 'WAITING'].includes(lifecycle.status)",
    'unresolvedEffect: history.unresolvedReservationsByRun.has(runId)',
  ]);

  const commitObservation = section(
    sources.engine,
    'commitObservation',
    '  #commitObservation(',
    '\n  #settleWithoutObservation(',
  );
  requireOrdered('commitObservation', commitObservation, [
    "this.#receiptFact(run, work.id, 'observation', observed, diagnostic)",
    'projectReceipt(fact, work, undefined, unresolvedEffect)',
    "'receipt.json': fact",
  ]);

  const settleWithoutObservation = section(
    sources.engine,
    'settleWithoutObservation',
    '  #settleWithoutObservation(',
    '\n  #requireHead(): string {',
  );
  requireOrdered('settleWithoutObservation', settleWithoutObservation, [
    'const run = this.#requireExecutionPermit(history, permit);',
    "lifecycle.status !== 'EXECUTING'",
    "kind === 'source-integration' && !unresolvedEffect",
    'if (policy.unresolvedError && unresolvedEffect)',
    'validate?.({ run, work });',
    'const receipt = projectReceipt(fact, work);',
    "'receipt.json': fact",
  ]);

  const projectReceipt = section(
    sources.replay,
    'projectReceipt',
    'export function projectReceipt(',
    '\nexport function replayProjection(',
  );
  requireIncludes('projectReceipt', projectReceipt, [
    'verified = observationVerified(work.postcondition, fact.observed);',
    'const absenceEvidence = authoritativeAbsenceEvidence(work.postcondition, fact.observed);',
    'absenceEvidence && policy.acceptedAbsenceEvidenceKinds.includes(absenceEvidence.kind)',
    '!unresolvedEffect ||',
    '(absenceEvidence !== null && reservedEffectReplaySafe(work, absenceEvidence))',
    "disposition = verified ? 'DONE' : acceptedAbsence && replaySafe ? 'READY' : 'RECOVERY_REQUIRED';",
    "fact.kind === 'effect-not-dispatched' && notDispatchedRelease",
  ]);

  const replayReceipt = section(
    sources.replay,
    'replayReceipt',
    '    if (record.receipt == null) continue;',
    '\n    receipts.push(receipt);',
  );
  requireOrdered('replayReceipt', replayReceipt, [
    'const receiptError = receiptAuthorityError(run, fact);',
    'if (receiptError) throw new Error(receiptError);',
    "if (previous && ['DONE', 'READY'].includes(previous.disposition))",
    'const receipt = projectReceipt(',
    "if (receipt.disposition === 'DONE' || receipt.disposition === 'READY')",
    'unresolvedReservationsByRun.delete(run.id);',
  ]);

  requireOrdered('settlementDispositionFromRelations', sources.settlement, [
    'if (relations.event_asserts_postcondition)',
    'relations.object_supports_not_dispatched ||',
    'relations.object_supports_accepted_absence',
    '!relations.accepted_absence_requires_replay_safety ||',
    'relations.object_supports_replay_safety',
    "return 'RECOVERY_REQUIRED';",
  ]);

  requireIncludes('TransitionKernel authority refinement', sources.formalKernel, [
    'CurrentFenceAuthority(w) ==',
    's.leaseFence = s.fence',
    'MutationAuthorityAllowed(w) ==',
    'SettlementAuthorityAllowed(w) ==',
    'MutationAuthoritySafety == s.mutationWasAuthorized',
    'SettlementAuthoritySafety == s.settlement = "None" \\/ s.settlementWasAuthorized',
  ]);
  requireIncludes('TransitionKernel evidence refinement', sources.formalKernel, [
    'ExactEvidenceAllowed ==',
    's.verifiedRevision = s.authorityRevision',
    'ReplayEvidenceIsAbsence ==',
    's.verifiedEffect = "Absent"',
    's.verifiedEffect = "Present"',
    'ExactRevisionEvidence == s.settlement = "None" \\/ s.settlementEvidenceMatches',
    'ReplaySafety == ~s.replayWithoutAbsence',
  ]);
  requireIncludes('TransitionKernel reservation refinement', sources.formalKernel, [
    '(~EnableReservationCheck \\/ ~s.unresolved)',
    'ReservationSafety == ~s.reservationViolated',
  ]);
  requireIncludes('TransitionKernel negative controls enabled', sources.formalConfig, [
    'EnableFenceCheck = TRUE',
    'EnableRevisionCheck = TRUE',
    'EnableReplayGuard = TRUE',
    'EnableReservationCheck = TRUE',
    'RequireEvidenceForDone = TRUE',
    'INVARIANT MutationAuthoritySafety',
    'INVARIANT SettlementAuthoritySafety',
    'INVARIANT ExactRevisionEvidence',
    'INVARIANT ReplaySafety',
    'INVARIANT ReservationSafety',
    'INVARIANT NoFalseDone',
  ]);

  return {
    transitions: [
      {
        id: 'dispatch-effect',
        durable: false,
        relations: ['permits'],
        formalActions: ['BeginMutation', 'MutationAuthorityAllowed'],
      },
      {
        id: 'release-not-dispatched',
        durable: true,
        relations: ['permits', 'supports', 'requires'],
        formalActions: ['Verify', 'ReplayEvidenceIsAbsence'],
      },
      {
        id: 'observation-receipt',
        durable: true,
        relations: ['permits', 'asserts', 'supports', 'requires'],
        formalActions: ['Verify', 'Settle', 'ExactEvidenceAllowed'],
      },
      {
        id: 'source-integration-receipt',
        durable: true,
        relations: ['permits', 'supports', 'requires'],
        formalActions: ['Settle', 'ExactEvidenceAllowed'],
      },
    ],
    hostileGuards: {
      staleAuthority: true,
      evidenceMigration: true,
      ambiguity: true,
      aba: true,
      duplicateEffect: true,
    },
  };
}
