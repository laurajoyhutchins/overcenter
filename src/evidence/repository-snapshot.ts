import { execFileSync } from 'node:child_process';

export interface RepositorySnapshot {
  readonly repo: string;
  readonly revision: string;
  bytes(path: string): Buffer;
  optionalBytes(path: string): Buffer | null;
  blob(path: string): string;
}

function validateRevision(revision: string): string {
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error('REPOSITORY_SNAPSHOT_REVISION_INVALID');
  }
  return revision.toLowerCase();
}

export function repositorySnapshot(repo: string, revision: string): RepositorySnapshot {
  const sourceRevision = validateRevision(revision);

  const entry = (path: string): { mode: string; id: string } | null => {
    if (!path || path.includes('\0')) throw new Error('REPOSITORY_SNAPSHOT_PATH_INVALID');
    const raw = execFileSync('git', [
      '-C',
      repo,
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      sourceRevision,
      '--',
      path,
    ]);
    if (raw.length === 0) return null;
    const text = raw.toString('utf8');
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(text);
    if (!match || match[3] !== path || !Buffer.from(text).equals(raw)) {
      throw new Error(`REPOSITORY_SNAPSHOT_BLOB_MISSING:${path}`);
    }
    return { mode: match[1]!, id: match[2]! };
  };

  const bytes = (path: string): Buffer => {
    const file = entry(path);
    if (!file) throw new Error(`REPOSITORY_SNAPSHOT_BLOB_MISSING:${path}`);
    return execFileSync('git', ['-C', repo, 'cat-file', 'blob', file.id], {
      maxBuffer: 16 * 1024 * 1024,
    });
  };

  const optionalBytes = (path: string): Buffer | null => {
    if (!entry(path)) return null;
    return bytes(path);
  };

  const blob = (path: string): string => {
    const file = entry(path);
    if (!file) {
      throw new Error(`REPOSITORY_SNAPSHOT_BLOB_MISSING:${path}`);
    }
    return file.id;
  };

  return Object.freeze({
    repo,
    revision: sourceRevision,
    bytes,
    optionalBytes,
    blob,
  });
}
