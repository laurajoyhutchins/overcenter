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
  readonly transitions: readonly [];
  readonly hostileGuards: {};
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
    transitions: [],
    hostileGuards: {},
  };
}
