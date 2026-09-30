import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { DurableFactStore } from '../authority/store.ts';
import { GitAuthorityJournal } from './git-store.ts';
import { readFact, readFactHistory, type ObjectType } from './git-facts.ts';

export class SqliteFactStore implements DurableFactStore {
  readonly journal: GitAuthorityJournal;
  readonly cachePath: string;
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(
    repo: string,
    { ref, remote = null, cachePath }: { ref: string; remote?: string | null; cachePath?: string },
  ) {
    this.journal = new GitAuthorityJournal(repo, { ref, remote });
    this.cachePath = cachePath ?? join(this.journal.directory, 'overcenter.sqlite');
    this.#db = new DatabaseSync(this.cachePath);
    this.#db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID',
    );
  }
  head(): string | null {
    return this.journal.head();
  }
  append(
    expected: string | null,
    message: string,
    files: Record<string, unknown> = {},
  ): string | null {
    const next = this.journal.publish(expected, message, files);
    readFact(next, (id, type) => this.#object(id, type));
    return this.journal.cas(next, expected ?? this.journal.zeroObjectId()) ? next : null;
  }
  history(head: string) {
    return readFactHistory(head, (id, type) => this.#object(id, type));
  }
  #object(id: string, type: ObjectType): Buffer {
    const row = this.#db.prepare('SELECT type, bytes FROM objects WHERE id = ?').get(id);
    if (row) {
      if (row.type !== type || !(row.bytes instanceof Uint8Array))
        throw new Error('FACT_OBJECT_TYPE_INVALID');
      return Buffer.from(row.bytes);
    }
    const bytes = this.journal.readObject(id, type);
    this.#db
      .prepare('INSERT OR IGNORE INTO objects (id, type, bytes) VALUES (?, ?, ?)')
      .run(id, type, bytes);
    return bytes;
  }
  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
