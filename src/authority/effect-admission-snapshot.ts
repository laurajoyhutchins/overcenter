import type { ExecutionPermit } from '../model.ts';
import type { HistoricalRun } from './facts.ts';
import type { Projection } from './replay.ts';
import { executionPermits } from './transaction-admission.ts';

export type EffectAdmissionSnapshotError =
  | 'UNKNOWN_RUN'
  | 'STALE_EXECUTION_GENERATION'
  | 'RUN_NOT_EXECUTING'
  | 'UNRESOLVED_EFFECT';

export type EffectAdmissionSnapshotDecision =
  | { readonly admitted: true; readonly run: HistoricalRun }
  | { readonly admitted: false; readonly error: EffectAdmissionSnapshotError };

interface IndexedRun {
  readonly index: number;
  readonly run: HistoricalRun;
}

const WORD_BITS = 32;

function setBit(bits: Uint32Array, index: number): void {
  const word = index >>> 5;
  const mask = 1 << (index & (WORD_BITS - 1));
  bits[word] = (bits[word] ?? 0) | mask;
}

function hasBit(bits: Uint32Array, index: number): boolean {
  const word = index >>> 5;
  const mask = 1 << (index & (WORD_BITS - 1));
  return ((bits[word] ?? 0) & mask) !== 0;
}

/**
 * Reconstructible exact-head acceleration for effect admission.
 *
 * The durable fact history remains authoritative. This snapshot is valid only
 * for `head`; callers must rebuild it whenever the authority head changes.
 * Dense bitsets hold the two mutable predicates in the admission rule while
 * exact permit/authority identity stays in the canonical HistoricalRun tuple.
 */
export class EffectAdmissionSnapshot {
  readonly head: string;
  readonly runCount: number;
  readonly #byRun: ReadonlyMap<string, IndexedRun>;
  readonly #executing: Uint32Array;
  readonly #unresolved: Uint32Array;

  constructor(head: string, projection: Projection) {
    this.head = head;
    const runs = [...projection.history.runs.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    this.runCount = runs.length;
    const words = Math.ceil(runs.length / WORD_BITS);
    this.#executing = new Uint32Array(words);
    this.#unresolved = new Uint32Array(words);
    const byRun = new Map<string, IndexedRun>();

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]!;
      byRun.set(run.id, { index, run });
      const lifecycle = projection.project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id === run.id && lifecycle.status === 'EXECUTING') {
        setBit(this.#executing, index);
      }
      if (projection.history.unresolvedReservationsByRun.has(run.id)) {
        setBit(this.#unresolved, index);
      }
    }

    this.#byRun = byRun;
  }

  decide(permit: ExecutionPermit, capabilitySha256: string): EffectAdmissionSnapshotDecision {
    const indexed = this.#byRun.get(permit.id);
    if (!indexed) return { admitted: false, error: 'UNKNOWN_RUN' };
    if (!executionPermits(indexed.run, permit, capabilitySha256)) {
      return { admitted: false, error: 'STALE_EXECUTION_GENERATION' };
    }
    if (!hasBit(this.#executing, indexed.index)) {
      return { admitted: false, error: 'RUN_NOT_EXECUTING' };
    }
    if (hasBit(this.#unresolved, indexed.index)) {
      return { admitted: false, error: 'UNRESOLVED_EFFECT' };
    }
    return { admitted: true, run: indexed.run };
  }
}

export function buildEffectAdmissionSnapshot(
  head: string,
  projection: Projection,
): EffectAdmissionSnapshot {
  return new EffectAdmissionSnapshot(head, projection);
}
