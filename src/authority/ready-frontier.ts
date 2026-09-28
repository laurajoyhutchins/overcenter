export interface ReadyCandidate {
  id: string;
  serviceAge: number;
}

function compareReady(left: ReadyCandidate, right: ReadyCandidate): number {
  return left.serviceAge - right.serviceAge || left.id.localeCompare(right.id);
}

export class ReadyFrontier {
  readonly #items: ReadyCandidate[] = [];
  readonly #positions = new Map<string, number>();

  get size(): number {
    return this.#items.length;
  }

  has(id: string): boolean {
    return this.#positions.has(id);
  }

  peek(): ReadyCandidate | null {
    const candidate = this.#items[0];
    return candidate ? { ...candidate } : null;
  }

  add(candidate: ReadyCandidate): void {
    if (this.has(candidate.id)) throw new Error(`READY_FRONTIER_DUPLICATE:${candidate.id}`);
    const position = this.#items.length;
    this.#items.push({ ...candidate });
    this.#positions.set(candidate.id, position);
    this.#up(position);
  }

  remove(id: string): void {
    const position = this.#positions.get(id);
    if (position === undefined) return;
    const last = this.#items.pop()!;
    this.#positions.delete(id);
    if (position === this.#items.length) return;
    this.#items[position] = last;
    this.#positions.set(last.id, position);
    this.#repair(position);
  }

  rekey(id: string, serviceAge: number): void {
    const position = this.#positions.get(id);
    if (position === undefined) throw new Error(`READY_FRONTIER_MISSING:${id}`);
    this.#items[position] = { id, serviceAge };
    this.#repair(position);
  }

  #less(left: number, right: number): boolean {
    return compareReady(this.#items[left]!, this.#items[right]!) < 0;
  }

  #swap(left: number, right: number): void {
    const a = this.#items[left]!;
    const b = this.#items[right]!;
    this.#items[left] = b;
    this.#items[right] = a;
    this.#positions.set(a.id, right);
    this.#positions.set(b.id, left);
  }

  #up(start: number): number {
    let position = start;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!this.#less(position, parent)) break;
      this.#swap(position, parent);
      position = parent;
    }
    return position;
  }

  #down(start: number): void {
    let position = start;
    for (;;) {
      const left = position * 2 + 1;
      const right = left + 1;
      let best = position;
      if (left < this.#items.length && this.#less(left, best)) best = left;
      if (right < this.#items.length && this.#less(right, best)) best = right;
      if (best === position) return;
      this.#swap(position, best);
      position = best;
    }
  }

  #repair(position: number): void {
    const raised = this.#up(position);
    this.#down(raised);
  }
}
