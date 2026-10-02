import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FourByFourRelation = 'permits' | 'asserts' | 'supports' | 'requires';

export interface ImplementationTransitionSources {
  readonly engine: string;
  readonly formalKernel: string;
  readonly formalConfig: string;
}

export interface ImplementationTransition {
  readonly id: 'source-integration-receipt';
  readonly durable: boolean;
  readonly relations: readonly FourByFourRelation[];
  readonly formalActions: readonly string[];
}

export interface ImplementationTransitionRefinement {
  readonly transitions: readonly ImplementationTransition[];
  readonly hostileGuards: {
    readonly evidenceMigration: true;
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
    engine: readFileSync(resolve(root, 'src/authority/engine.ts'), 'utf8'),
    formalKernel: readFileSync(resolve(root, 'formal/TransitionKernel.tla'), 'utf8'),
    formalConfig: readFileSync(resolve(root, 'formal/TransitionKernel.cfg'), 'utf8'),
  };
}

export function verifyImplementationTransitionRefinement(
  sources: ImplementationTransitionSources,
): ImplementationTransitionRefinement {
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
        id: 'source-integration-receipt',
        durable: true,
        relations: ['permits', 'supports', 'requires'],
        formalActions: ['Settle', 'ExactEvidenceAllowed'],
      },
    ],
    hostileGuards: {
      evidenceMigration: true,
    },
  };
}
