import type { HistoricalRun } from './facts.ts';
import type { Projection } from './replay.ts';

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
 * Reconstructible exact-head data acceleration for effect admission.
 *
 * The durable fact history and transaction-admission functions remain
 * authoritative. This snapshot only materializes the run lookup and the two
 * mutable predicates needed by the existing admission rule.
 */
export class EffectAdmissionSnapshot {
  readonly head: string;
  readonly runCount: number;
  readonly unresolvedReservationsByRun: { has(runId: string): boolean };
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
    this.unresolvedReservationsByRun = Object.freeze({
      has: (runId: string) => this.#test(runId, this.#unresolved),
    });
  }

  run(runId: string): HistoricalRun | undefined {
    return this.#byRun.get(runId)?.run;
  }

  executing(runId: string): boolean {
    return this.#test(runId, this.#executing);
  }

  #test(runId: string, bits: Uint32Array): boolean {
    const indexed = this.#byRun.get(runId);
    return indexed ? hasBit(bits, indexed.index) : false;
  }
}

export function buildEffectAdmissionSnapshot(
  head: string,
  projection: Projection,
): EffectAdmissionSnapshot {
  return new EffectAdmissionSnapshot(head, projection);
}
