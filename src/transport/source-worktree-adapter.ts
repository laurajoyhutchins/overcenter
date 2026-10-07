import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  SOURCE_PROPOSAL_SCHEMA,
  validateSourceAssignment,
  type SourceProposal,
} from '../source/source-obligation.ts';

export interface SourceWorkerCommand {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export interface SourceWorktreeAdapterResult {
  proposal: SourceProposal;
  worker: {
    adapter: 'process/v1';
    exit_code: number;
    signal: NodeJS.Signals | null;
  };
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function nulPaths(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function changedPaths(worktree: string, sourceSha: string): string[] {
  const paths = new Set<string>();
  for (const args of [
    ['diff', '--name-only', '--no-renames', '-z', sourceSha, '--'],
    ['diff', '--cached', '--name-only', '--no-renames', '-z', sourceSha, '--'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    for (const path of nulPaths(
      execFileSync('git', ['-C', worktree, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function workerEnvironment(
  objective: string,
  sourceSha: string,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };

  for (const key of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_CACHE_URL',
    'ACTIONS_RESULTS_URL',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GHA_CREDS_PATH',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  ]) {
    delete env[key];
  }

  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
  env.GIT_CONFIG_VALUE_1 = '';
  env.OVERCENTER_TASK_OBJECTIVE = objective;
  env.OVERCENTER_SOURCE_BASE_SHA = sourceSha;
  return env;
}

function sourceProposalFromWorktree(
  worktree: string,
  sourceSha: string,
  runId: string,
  claimedRevision: string,
): SourceProposal {
  const files = changedPaths(worktree, sourceSha).map((path) => {
    const target = resolve(worktree, path);
    const root = resolve(worktree) + sep;
    if (!target.startsWith(root)) throw new Error('SOURCE_WORKTREE_PATH_ESCAPE');

    if (!existsSync(target)) return { path, content_base64: null };

    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error(`SOURCE_WORKTREE_ENTRY_UNSUPPORTED:${path}`);
    return {
      path,
      content_base64: readFileSync(target).toString('base64'),
    };
  });

  return {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: runId,
    claimed_revision: claimedRevision,
    claimed_source_sha: sourceSha,
    files,
  };
}

export function runSourceWorktreeAdapter(
  repo: string,
  assignmentValue: unknown,
  worker: SourceWorkerCommand,
  { stdio = 'inherit' }: { stdio?: 'inherit' | 'ignore' } = {},
): SourceWorktreeAdapterResult {
  const assignment = validateSourceAssignment(assignmentValue);
  if (!worker.command.trim()) throw new Error('SOURCE_WORKER_COMMAND_REQUIRED');

  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-worker-'));
  try {
    execFileSync(
      'git',
      ['-C', repo, 'worktree', 'add', '--detach', root, assignment.claim.source_sha],
      {
        stdio: 'ignore',
      },
    );
    if (git(root, ['rev-parse', 'HEAD']) !== assignment.claim.source_sha) {
      throw new Error('SOURCE_WORKTREE_BASE_MISMATCH');
    }

    const result = spawnSync(worker.command, [...(worker.args ?? [])], {
      cwd: root,
      env: workerEnvironment(
        assignment.task.objective,
        assignment.claim.source_sha,
        worker.env ?? {},
      ),
      stdio,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`SOURCE_WORKER_EXIT_NONZERO:${result.status ?? 'signal'}`);
    }
    if (git(root, ['rev-parse', 'HEAD']) !== assignment.claim.source_sha) {
      throw new Error('SOURCE_WORKTREE_HEAD_MOVED');
    }

    return {
      proposal: sourceProposalFromWorktree(
        root,
        assignment.claim.source_sha,
        assignment.claim.run_id,
        assignment.claim.claimed_revision,
      ),
      worker: {
        adapter: 'process/v1',
        exit_code: result.status,
        signal: result.signal,
      },
    };
  } finally {
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', root], { stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}
