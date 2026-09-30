import { createHash } from 'node:crypto';
import { canonicalDigest } from '../digest.ts';
import { factCommitFromFiles } from '../authority/store.ts';
import type { FactCommit } from '../authority/facts.ts';

export type ObjectType = 'commit' | 'tree' | 'blob';
export type ObjectReader = (id: string, type: ObjectType) => Buffer;
export function verifyObject(id: string, type: ObjectType, bytes: Buffer): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new Error('FACT_OBJECT_ID_INVALID');
  const digest = createHash(id.length === 64 ? 'sha256' : 'sha1')
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (digest !== id) throw new Error('FACT_OBJECT_DIGEST_MISMATCH');
}

export function readFact(commit: string, read: ObjectReader): FactCommit {
  const object = (id: string, type: ObjectType) => {
    const bytes = read(id, type);
    verifyObject(id, type, bytes);
    return bytes;
  };
  const headers = object(commit, 'commit').toString('utf8').split('\n\n', 1)[0]!.split('\n');
  const treeId = headers[0]!.replace(/^tree /, '');
  const parents = headers.filter((line) => line.startsWith('parent '));
  if (parents.length > 1) throw new Error('FACT_HISTORY_MULTIPLE_PARENTS');
  const parent = parents[0]?.slice(7) ?? null;
  const tree = object(treeId, 'tree');
  const files: Record<string, unknown> = {};
  for (let offset = 0; offset < tree.length; ) {
    const end = tree.indexOf(0, offset);
    const entry = tree.subarray(offset, end).toString('utf8');
    if (
      end < offset ||
      !/^100644 (?:graph-patch|claim|source-revision|execution-authority|effect-reservation|effect-release|receipt|state)\.json$/.test(
        entry,
      )
    )
      throw new Error('FACT_PAYLOAD_ENTRY_INVALID');
    const name = entry.slice(7);
    if (Object.hasOwn(files, name)) throw new Error('FACT_PAYLOAD_ENTRY_INVALID');
    const next = end + 1 + commit.length / 2;
    if (next > tree.length) throw new Error('FACT_PAYLOAD_ENTRY_INVALID');
    const blob = tree.subarray(end + 1, next).toString('hex');
    files[name] = JSON.parse(object(blob, 'blob').toString('utf8'));
    offset = next;
  }
  if (
    Object.hasOwn(files, 'state.json') &&
    (parent !== null ||
      Object.keys(files).length !== 1 ||
      canonicalDigest(files['state.json']) !==
        canonicalDigest({ schema: 'overcenter-git-state-v2', obligations: {}, active_run: null }))
  ) {
    throw new Error('FACT_HISTORY_NONEMPTY_LEGACY_SNAPSHOT');
  }
  return factCommitFromFiles(commit, parent, files);
}

export function readFactHistory(head: string, read: ObjectReader): FactCommit[] {
  const history: FactCommit[] = [];
  const seen = new Set<string>();
  for (let revision: string | null = head; revision !== null; ) {
    if (seen.has(revision)) throw new Error('FACT_HISTORY_PARENT_MISMATCH');
    seen.add(revision);
    const fact = readFact(revision, read);
    history.push(fact);
    revision = fact.parent;
  }
  return history.reverse();
}
