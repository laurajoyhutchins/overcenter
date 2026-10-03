import { SqliteFactStore } from '../storage/sqlite.ts';
import { KernelCore, type KernelOptions } from './engine.ts';

export type { Receipt } from './engine.ts';

const STATE_REF = 'refs/overcenter/state';

export interface KernelStorageOptions extends KernelOptions {
  cachePath?: string;
  ref?: string;
  remote?: string | null;
}

export class OvercenterKernel extends KernelCore {
  readonly #facts: SqliteFactStore;
  close(): void {
    this.#facts.close();
  }
  readonly repo: string;
  readonly ref: string;
  readonly remote: string | null;

  constructor(
    repo: string,
    {
      ref = STATE_REF,
      remote = null,
      cachePath,
      githubToken = null,
      observationContext = {},
    }: KernelStorageOptions = {},
  ) {
    const store = new SqliteFactStore(repo, { ref, remote, ...(cachePath ? { cachePath } : {}) });

    super(store, { githubToken, observationContext });
    this.#facts = store;
    this.repo = repo;
    this.ref = ref;
    this.remote = remote;
  }
}
