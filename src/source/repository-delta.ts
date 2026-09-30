import { execFileSync } from 'node:child_process';

export interface RepositoryDeltaObject {
  mode: string;
  object_id: string;
  object_type: 'blob' | 'commit';
}

export interface RepositoryDeltaEntry {
  path: string;
  before: RepositoryDeltaObject | null;
  after: RepositoryDeltaObject | null;
}

export interface RepositoryDelta {
  base_revision: string;
  candidate_revision: string;
  candidate_tree: string;
  entries: RepositoryDeltaEntry[];
}

function git(repo: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', repo, '--literal-pathspecs', ...args], {
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(repo: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('REPOSITORY_DELTA_REVISION_INVALID');
  const normalized = sha.toLowerCase();
  if (git(repo, ['cat-file', '-t', normalized]).toString('utf8').trim() !== 'commit') {
    throw new Error('REPOSITORY_DELTA_NOT_COMMIT');
  }
  return normalized;
}

function object(mode: string, sha: string): RepositoryDeltaObject | null {
  if (mode === '000000') return null;
  return { mode, object_id: sha, object_type: mode === '160000' ? 'commit' : 'blob' };
}

export function observeRepositoryDelta(
  repo: string,
  baseSha: string,
  candidateSha: string,
): RepositoryDelta {
  const base = commit(repo, baseSha);
  const candidate = commit(repo, candidateSha);
  const raw = git(repo, [
    'diff-tree',
    '--no-commit-id',
    '--raw',
    '-r',
    '-z',
    '--no-renames',
    '--no-abbrev',
    base,
    candidate,
  ]);
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new Error('REPOSITORY_DELTA_PATH_ENCODING_UNSUPPORTED');
  const fields = text.split('\0');
  if (fields.pop() !== '') throw new Error('REPOSITORY_DELTA_INVALID');
  const entries: RepositoryDeltaEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]!;
    const path = fields[index + 1];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [AMDT]$/.exec(header);
    if (!match || !path) throw new Error('REPOSITORY_DELTA_INVALID');
    entries.push({
      path,
      before: object(match[1]!, match[3]!),
      after: object(match[2]!, match[4]!),
    });
  }
  return {
    base_revision: base,
    candidate_revision: candidate,
    candidate_tree: git(repo, ['rev-parse', `${candidate}^{tree}`])
      .toString('utf8')
      .trim(),
    entries: entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
}

export function assertSupportedSourceDelta(delta: RepositoryDelta): void {
  for (const entry of delta.entries) {
    const path = entry.path;
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      /^[A-Za-z]:/.test(path) ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))
    ) {
      throw new Error(`SOURCE_DELTA_PATH_INVALID:${path}`);
    }
    for (const side of [entry.before, entry.after]) {
      if (side && !['100644', '100755'].includes(side.mode)) {
        throw new Error(`SOURCE_DELTA_MODE_UNSUPPORTED:${path}:${side.mode}`);
      }
    }
  }
}
