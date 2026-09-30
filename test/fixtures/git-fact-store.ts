// Direct transport reader oracle; production uses the SQLite composition.
import { GitAuthorityJournal } from '../../src/storage/git-store.ts';
import { readFactHistory } from '../../src/storage/git-facts.ts';
import type { DurableFactStore } from '../../src/authority/store.ts';
export class GitFactStore extends GitAuthorityJournal implements DurableFactStore {
  append(expected: string | null, message: string, files: Record<string, unknown> = {}) {
    const next = this.publish(expected, message, files);
    return this.cas(next, expected ?? this.zeroObjectId()) ? next : null;
  }
  history(head: string) {
    return readFactHistory(head, (id, type) => this.readObject(id, type));
  }
}
