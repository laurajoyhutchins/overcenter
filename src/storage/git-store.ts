import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalDigest } from '../digest.ts';

import { factCommitFromFiles, type DurableFactStore } from '../authority/store.ts';
import type { FactCommit } from '../authority/facts.ts';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export class GitFactStore implements DurableFactStore {
  readonly repo: string;
  readonly ref: string;
  readonly remote: string | null;

  constructor(repo: string, { ref, remote = null }: { ref: string; remote?: string | null }) {
    this.repo = repo;
    this.ref = ref;
    this.remote = remote;
    this.#git(['rev-parse', '--git-dir']);
  }

  head(): string | null {
    if (!this.remote) {
      const result = this.#git(['rev-parse', '-q', '--verify', this.ref], { allowFailure: true });
      return result.ok ? result.stdout.trim() : null;
    }
    const listed = this.#git(['ls-remote', this.remote, this.ref], { allowFailure: true });
    if (!listed.ok) throw new Error('AUTHORITY_UNREACHABLE');
    const line = listed.stdout.trim();
    if (!line) {
      this.#git(['update-ref', '-d', this.ref], { allowFailure: true });
      return null;
    }
    const sha = line.split(/\s+/)[0];
    if (!sha) throw new Error('AUTHORITY_REMOTE_REF_INVALID');
    const fetched = this.#git(['fetch', '--no-tags', this.remote, `+${this.ref}:${this.ref}`], {
      allowFailure: true,
    });
    if (!fetched.ok) throw new Error('AUTHORITY_UNREACHABLE');
    return this.#git(['rev-parse', '--verify', this.ref]).stdout.trim();
  }

  append(
    expectedHead: string | null,
    message: string,
    files: Record<string, unknown> = {},
  ): string | null {
    const commit = this.createCommit(
      expectedHead,
      `${message}\n\nappend-attempt: ${randomUUID()}`,
      files,
    );
    const expected = expectedHead ?? this.zeroObjectId();
    return this.cas(commit, expected) ? commit : null;
  }

  history(head: string): FactCommit[] {
    let expectedParent: string | null = null;
    return this.revisions(head).map((commit) => {
      const parent = this.parent(commit);
      if (parent !== expectedParent) throw new Error('FACT_HISTORY_PARENT_MISMATCH');
      expectedParent = commit;
      const files: Record<string, unknown> = {};
      const entries = this.#git(['ls-tree', '-z', commit]).stdout.split('\0').filter(Boolean);
      for (const entry of entries) {
        const match =
          /^100644 blob ([0-9a-f]+)\t((?:graph-patch|claim|source-revision|execution-authority|effect-reservation|effect-release|receipt|state)\.json)$/.exec(
            entry,
          );
        if (!match?.[1] || !match[2]) throw new Error('FACT_PAYLOAD_ENTRY_INVALID');
        files[match[2]] = JSON.parse(this.#readObject(match[1], 'blob').toString('utf8'));
        if (match[2] === 'state.json') {
          const initial = files[match[2]];
          if (
            parent !== null ||
            entries.length !== 1 ||
            canonicalDigest(initial) !==
              canonicalDigest({
                schema: 'overcenter-git-state-v2',
                obligations: {},
                active_run: null,
              })
          ) {
            throw new Error('FACT_HISTORY_NONEMPTY_LEGACY_SNAPSHOT');
          }
        }
      }
      return factCommitFromFiles(commit, parent, files);
    });
  }

  revisions(head: string): string[] {
    return this.#git(['rev-list', '--reverse', head]).stdout.trim().split(/\n+/).filter(Boolean);
  }

  parent(commit: string): string | null {
    const body = this.#readObject(commit, 'commit').toString('utf8');
    const parents = body
      .split('\n\n', 1)[0]!
      .split('\n')
      .filter((line) => line.startsWith('parent '));
    if (parents.length > 1) throw new Error('FACT_HISTORY_MULTIPLE_PARENTS');
    const tree = body.split('\n', 1)[0]!.replace(/^tree /, '');
    this.#readObject(tree, 'tree');
    return parents[0]?.slice(7) ?? null;
  }

  #readObject(id: string, type: 'commit' | 'tree' | 'blob'): Buffer {
    const bytes = execFileSync('git', ['-C', this.repo, 'cat-file', type, id], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const digest = createHash(id.length === 64 ? 'sha256' : 'sha1')
      .update(`${type} ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (digest !== id) throw new Error('FACT_OBJECT_DIGEST_MISMATCH');
    return bytes;
  }

  createCommit(
    parent: string | null,
    message: string,
    files: Record<string, unknown> = {},
  ): string {
    const entries = Object.entries(files)
      .map(([name, value]) => [name, this.#blob(json(value))] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const treeInput = entries.map(([name, sha]) => `100644 blob ${sha}\t${name}\n`).join('');
    const tree = this.#git(['mktree'], { input: treeInput }).stdout.trim();
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Overcenter Kernel',
      GIT_AUTHOR_EMAIL: 'overcenter@local',
      GIT_COMMITTER_NAME: 'Overcenter Kernel',
      GIT_COMMITTER_EMAIL: 'overcenter@local',
    };
    return this.#git(args, { input: `${message}\n`, env }).stdout.trim();
  }

  cas(next: string, expected: string): boolean {
    if (!this.remote) {
      return this.#git(['update-ref', this.ref, next, expected], { allowFailure: true }).ok;
    }
    const zero = '0'.repeat(this.#objectIdLength());
    const lease =
      expected === zero
        ? `--force-with-lease=${this.ref}:`
        : `--force-with-lease=${this.ref}:${expected}`;
    const pushed = this.#git(['push', '--porcelain', lease, this.remote, `${next}:${this.ref}`], {
      allowFailure: true,
    });
    if (/^=\t/m.test(pushed.stdout)) return false;
    if (!pushed.ok) {
      if (/^!\t[^\n]*\[(?:remote )?rejected\]/m.test(pushed.stdout)) return false;
      // A lost push acknowledgement is not evidence that the ref stayed unchanged.
      try {
        const observed = this.head();
        if (
          observed === next ||
          (observed &&
            (this.parent(next) === expected || (expected === zero && this.parent(next) === null)) &&
            this.history(observed).some((fact) => fact.commit === next))
        )
          return true;
      } catch {}
      throw new Error('AUTHORITY_COMMIT_UNCERTAIN');
    }
    this.#git(['update-ref', this.ref, next]);
    return true;
  }

  zeroObjectId(): string {
    return '0'.repeat(this.#objectIdLength());
  }

  #blob(content: string): string {
    return this.#git(['hash-object', '-w', '--stdin'], { input: content }).stdout.trim();
  }

  #objectIdLength(): number {
    return this.#git(['rev-parse', '--show-object-format']).stdout.trim() === 'sha256' ? 64 : 40;
  }

  #git(
    args: string[],
    {
      input = undefined,
      env = process.env,
      allowFailure = false,
    }: {
      input?: string;
      env?: Record<string, string | undefined>;
      allowFailure?: boolean;
    } = {},
  ): GitResult {
    try {
      const stdout = execFileSync('git', ['-C', this.repo, ...args], {
        input,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, stdout };
    } catch (error: unknown) {
      const failure = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      if (allowFailure) {
        return {
          ok: false,
          stdout: String(failure.stdout ?? ''),
          stderr: String(failure.stderr ?? ''),
        };
      }
      throw new Error(
        `git ${args.join(' ')} failed: ${String(failure.stderr ?? failure.message ?? '').trim()}`,
      );
    }
  }
}
