import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runSourceWorktreeAdapter } from '../src/transport/source-worktree-adapter.ts';
import {
  bindSourceClaim,
  buildSourceAssignment,
  validateSourceProposal,
} from '../src/source/source-obligation.ts';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-worker-test-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'value.txt'), 'before\n');
  git(repo, 'add', 'value.txt');
  git(repo, 'commit', '-qm', 'base');
  const sourceSha = git(repo, 'rev-parse', 'HEAD');
  const claim = bindSourceClaim('key', 'run-1', 'revision-1', sourceSha);
  const task = {
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: 'Update value.txt.',
    writable_paths: ['value.txt'],
  };
  const assignment = buildSourceAssignment('change-value', task, claim);
  return { repo, sourceSha, claim, task, assignment };
}

test('process adapter materializes the exact base and emits bytes, not worker success claims', () => {
  const { repo, sourceSha, claim, task, assignment } = fixture();
  try {
    const script =
      "require('node:fs').writeFileSync('value.txt', process.env.OVERCENTER_TASK_OBJECTIVE + '\\n')";
    const result = runSourceWorktreeAdapter(
      repo,
      assignment,
      { command: process.execPath, args: ['-e', script] },
      { stdio: 'ignore' },
    );

    assert.equal(result.worker.exit_code, 0);
    assert.equal(result.proposal.claimed_source_sha, sourceSha);
    assert.equal(result.proposal.run_id, claim.run_id);
    assert.equal(
      Buffer.from(result.proposal.files[0]!.content_base64!, 'base64').toString('utf8'),
      'Update value.txt.\n',
    );
    assert.equal(git(repo, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), 'before\n');
    assert.doesNotThrow(() => validateSourceProposal(result.proposal, task, claim));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('exit zero and success text cannot manufacture an acceptable proposal', () => {
  const { repo, claim, task, assignment } = fixture();
  try {
    const result = runSourceWorktreeAdapter(
      repo,
      assignment,
      { command: process.execPath, args: ['-e', "process.stdout.write('SUCCESS\\n')"] },
      { stdio: 'ignore' },
    );
    assert.equal(result.worker.exit_code, 0);
    assert.deepEqual(result.proposal.files, []);
    assert.throws(
      () => validateSourceProposal(result.proposal, task, claim),
      /SOURCE_PROPOSAL_FILES_INVALID/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('adapter reports out-of-envelope edits for the trusted broker to reject', () => {
  const { repo, claim, task, assignment } = fixture();
  try {
    const script = "require('node:fs').writeFileSync('outside.txt', 'nope\\n')";
    const result = runSourceWorktreeAdapter(
      repo,
      assignment,
      { command: process.execPath, args: ['-e', script] },
      { stdio: 'ignore' },
    );
    assert.deepEqual(
      result.proposal.files.map((file) => file.path),
      ['outside.txt'],
    );
    assert.throws(
      () => validateSourceProposal(result.proposal, task, claim),
      /SOURCE_PROPOSAL_SCOPE_VIOLATION:outside\.txt/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worker cannot replace the assigned source revision with its own commit', () => {
  const { repo, assignment } = fixture();
  try {
    const script = [
      "const {execFileSync}=require('node:child_process')",
      "require('node:fs').writeFileSync('value.txt','after\\n')",
      "execFileSync('git',['config','user.name','Worker'])",
      "execFileSync('git',['config','user.email','worker@example.com'])",
      "execFileSync('git',['add','value.txt'])",
      "execFileSync('git',['commit','-qm','worker commit'])",
    ].join(';');
    assert.throws(
      () =>
        runSourceWorktreeAdapter(
          repo,
          assignment,
          { command: process.execPath, args: ['-e', script] },
          { stdio: 'ignore' },
        ),
      /SOURCE_WORKTREE_HEAD_MOVED/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
