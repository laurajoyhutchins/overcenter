import { reportSourceTransaction } from '../src/source/transaction-report.ts';
import { baselineSourceTransactionPlan } from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  buildSourceAssignment,
  validateSourceTaskPacket,
} from '../src/source/source-obligation.ts';
import { brokerAssignedSourceProposal, brokerSourceProposal } from '../src/source/source-broker.ts';
import { admitSourceProof } from '../src/source/source-proof.ts';
import { sourceProofRecord } from '../src/source/source-proof-record.ts';
import { validateSourceTransactionPlan } from '../src/source/transaction.ts';
import { integrateVerifiedSourceCandidate } from '../src/source/source-integration.ts';

function fixture(t: TestContext, interruptPublication = false) {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'work');
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('config', 'user.name', 'Recovery');
  git('config', 'user.email', 'recovery@local');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/agent-candidate-signal.yml'), 'immutable workflow');
  writeFileSync(join(repo, 'baseline.txt'), 'independent checks');
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  const kernel = new GitOvercenterKernel(repo, { remote: 'origin' });
  kernel.initialize();
  const task = validateSourceTaskPacket({
    schema: 'overcenter-source-task',
    schema_version: 2,
    kind: 'source-change',
    objective: 'Update value',
    writable_paths: ['value.ts', 'extra.ts'],
    expected_write_set: ['value.ts'],
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  });
  kernel.define({
    id: 'source',
    packet: task,
    postcondition: { verifier: 'source-integration/v1' },
  });
  const claimed = kernel.claim('source', kernel.head()!, { sourceRevision: base });
  const claim = kernel.sourceClaimBinding(claimed.id);
  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    baseline_id: 'fixture',
    validator_paths: ['baseline.txt', '.github/workflows'],
  };
  const assignment = buildSourceAssignment('source', task, claim);
  const proposal = {
    schema: 'overcenter-source-proposal/v1',
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: base,
    files: [
      {
        path: 'value.ts',
        content_base64: Buffer.from('export const value = 2;\n').toString('base64'),
      },
    ],
  };
  if (interruptPublication) {
    assert.throws(
      () =>
        brokerSourceProposal(repo, 'source', task, claim, proposal, {
          beforePublish: (candidate) => {
            const delta = observeRepositoryDelta(repo, base, candidate.commit_sha);
            kernel.bindSourceTransaction(claimed, {
              schema: 'overcenter-source-transaction',
              schema_version: 1,
              repository_id: context.repository_id,
              repository_full_name: context.repository_full_name,
              runtime_sha: context.runtime_sha,
              claim,
              execution_generation: claimed.execution_generation,
              execution_authority_commit: claimed.execution_authority_commit,
              candidate_sha: candidate.commit_sha,
              candidate_tree: delta.candidate_tree,
              authorized_write_set: task.writable_paths,
              expected_write_set: task.expected_write_set!,
              observed_write_set: delta.entries.map((entry) => entry.path),
              assurance: baselineSourceTransactionPlan(repo, delta, context),
            });
            throw new Error('publication interrupted');
          },
        }),
      /publication interrupted/,
    );
    assert.equal(git('ls-remote', 'origin', `refs/heads/overcenter/candidate/${claim.run_id}`), '');
  }
  const brokered = brokerAssignedSourceProposal(repo, assignment, proposal, {
    transactionContext: context,
  });
  const binding = kernel.sourceTransaction(claim.run_id)!;
  const plan = validateSourceTransactionPlan(binding.plan);
  const record = sourceProofRecord(
    plan,
    { workflow_run_id: 123, workflow_run_attempt: 1, job_id: 11 },
    'success',
  );
  const get = (_token: string, path: string): unknown => {
    if (path.endsWith('/actions/runs/123'))
      return {
        id: 123,
        path: '.github/workflows/agent-candidate-signal.yml',
        run_attempt: 1,
        head_sha: plan.candidate_sha,
        head_branch: `overcenter/candidate/${claim.run_id}`,
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        repository: { id: 42 },
        head_repository: { id: 42 },
      };
    if (path.endsWith('/attempts/1/jobs?per_page=100'))
      return {
        jobs: [
          {
            id: 10,
            run_id: 123,
            head_sha: plan.candidate_sha,
            status: 'completed',
            name: 'Verify source candidate / Candidate evidence',
            conclusion: 'success',
          },
          {
            id: 11,
            run_id: 123,
            head_sha: plan.candidate_sha,
            status: 'completed',
            name: 'Record source verification',
            conclusion: 'success',
          },
        ],
      };
    if (path.endsWith('/artifacts?per_page=100'))
      return {
        artifacts: [
          {
            id: 12,
            name: 'overcenter-source-verification',
            expired: false,
            digest: `sha256:${'f'.repeat(64)}`,
            workflow_run: {
              id: 123,
              head_sha: plan.candidate_sha,
              repository_id: 42,
              head_repository_id: 42,
            },
          },
        ],
      };
    return { id: 42, full_name: 'acme/widget' };
  };
  const proof = admitSourceProof(binding, record, {
    githubToken: 'fixture',
    expectedWorkflowRunId: 123,
    expectedWorkflowRunAttempt: 1,
    context,
    get,
  });
  const integrate = (performReservedMutation: (mutation: () => boolean) => boolean) =>
    integrateVerifiedSourceCandidate(repo, task, claim, 'source', plan.candidate_sha, proof, {
      performReservedMutation,
    });
  const head = () => git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  return {
    repo,
    git,
    base,
    kernel,
    claim,
    assignment,
    proposal,
    context,
    brokered,
    integrate,
    head,
  };
}

for (const boundary of [
  'before-reservation',
  'after-reservation',
  'timeout-after-commit',
  'after-readback',
] as const) {
  test(`source recovery at ${boundary} never blindly replays an uncertain mutation`, (t) => {
    const f = fixture(t);
    const permit = f.kernel.acquireExecution(f.claim.run_id);
    const authority = f.kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
    let mutations = 0;
    const initial = f.integrate((mutation) => {
      if (boundary === 'before-reservation') throw new Error('interruption');
      return f.kernel.performEffectSync(authority, () => {
        if (boundary === 'after-reservation') throw new Error('interruption');
        mutations += 1;
        const result = mutation();
        if (boundary === 'timeout-after-commit') throw new Error('transport timeout');
        return result;
      });
    });
    if (boundary === 'after-readback') assert.equal(initial.state, 'INTEGRATED');
    else assert.equal(initial.state, 'RECOVERY_REQUIRED');
    f.kernel.recoverInterrupted(permit, { interrupted_at: boundary });
    const replayed = new GitOvercenterKernel(f.repo, { remote: 'origin' });
    assert.equal(replayed.inspect()[0]?.status, 'RECOVERY_REQUIRED');
    const next = replayed.acquireExecution(f.claim.run_id);
    const nextAuthority = replayed.authorizeEffect(next, GITHUB_SOURCE_INTEGRATION_EFFECT);
    const recovered = f.integrate((mutation) =>
      replayed.performEffectSync(nextAuthority, () => {
        mutations += 1;
        return mutation();
      }),
    );
    if (boundary === 'after-reservation') {
      assert.equal(recovered.state, 'RECOVERY_REQUIRED');
      assert.equal(mutations, 0);
      assert.equal(f.head(), f.base);
    } else {
      assert.ok(recovered.state === 'INTEGRATED' || recovered.state === 'ALREADY_INTEGRATED');
      if (recovered.state !== 'INTEGRATED' && recovered.state !== 'ALREADY_INTEGRATED')
        throw new Error('missing integration');
      replayed.settleSourceIntegration(next, recovered.witness);
      assert.equal(mutations, 1);
      const final = new GitOvercenterKernel(f.repo, { remote: 'origin' });
      assert.equal(final.inspect()[0]?.status, 'DONE');
      assert.equal(final.receipts(f.claim.run_id).at(-1)?.verified, true);
      assert.equal(f.head(), recovered.commit_sha);
      const report = reportSourceTransaction(f.repo, f.claim.run_id);
      assert.equal(report.settled, false);
      assert.equal(report.authority_settled, true);
      assert.throws(
        () => reportSourceTransaction(f.repo, f.claim.run_id, { requireSettled: true }),
        /LIFECYCLE_INCOMPLETE/,
      );
      assert.equal(report.repository_identity, 'unverified');
      const provider = (_token: string, path: string): unknown => {
        if (path.includes('/attempts/1/jobs?'))
          return {
            jobs: [
              {
                id: 10,
                run_id: 123,
                head_sha: report.candidate_sha,
                name: 'Verify source candidate / Candidate evidence',
                status: 'completed',
                conclusion: 'success',
                steps: [
                  {
                    number: 1,
                    name: 'Independent baseline',
                    status: 'completed',
                    conclusion: 'success',
                  },
                ],
              },
            ],
          };
        if (path.endsWith('/git/ref/heads/main'))
          return {
            ref: 'refs/heads/main',
            object: { sha: report.independently_observed_source_sha },
          };
        if (path.endsWith('/git/ref/overcenter/state'))
          return { ref: 'refs/overcenter/state', object: { sha: report.authority_head } };
        return { id: 42, full_name: 'acme/widget' };
      };
      assert.equal(
        reportSourceTransaction(f.repo, f.claim.run_id, { githubToken: 'fixture', get: provider })
          .settled,
        true,
      );
      const verifiedReport = reportSourceTransaction(f.repo, f.claim.run_id, {
        githubToken: 'fixture',
        get: provider,
        requireSettled: true,
      });
      assert.deepEqual(verifiedReport.validation_executed?.observed_steps, [
        { number: 1, name: 'Independent baseline', status: 'completed', conclusion: 'success' },
      ]);
      assert.throws(
        () =>
          reportSourceTransaction(f.repo, f.claim.run_id, {
            githubToken: 'fixture',
            get: (token, path) =>
              path.includes('/attempts/') ? { jobs: [] } : provider(token, path),
          }),
        /CHECKS_UNVERIFIED/,
      );
      assert.throws(
        () =>
          reportSourceTransaction(f.repo, f.claim.run_id, {
            githubToken: 'fixture',
            get: () => ({ id: 43, full_name: 'acme/widget' }),
          }),
        /REPOSITORY_IDENTITY_MISMATCH/,
      );
      assert.throws(
        () =>
          reportSourceTransaction(f.repo, f.claim.run_id, {
            githubToken: 'fixture',
            get: (token, path) =>
              path.includes('/git/ref/')
                ? { ref: 'refs/heads/main', object: { sha: f.base } }
                : provider(token, path),
          }),
        /REPOSITORY_REF_MISMATCH/,
      );
      assert.equal(report.reconstructed_state, 'DONE');
      assert.deepEqual(report.planned_write_set, report.observed_write_set);
      assert.equal(report.validation_executed?.producer_job_id, 11);
      assert.equal(report.independently_observed_source_sha, recovered.commit_sha);
    }
  });
}

test('source movement and stale execution generation prevent a reserved source CAS', (t) => {
  const f = fixture(t);
  const stale = f.kernel.acquireExecution(f.claim.run_id);
  const authority = f.kernel.authorizeEffect(stale, GITHUB_SOURCE_INTEGRATION_EFFECT);
  f.kernel.acquireExecution(f.claim.run_id);
  let mutations = 0;
  const refused = f.integrate((mutation) =>
    f.kernel.performEffectSync(authority, () => {
      mutations += 1;
      return mutation();
    }),
  );
  assert.equal(refused.state, 'RECOVERY_REQUIRED');
  assert.equal(mutations, 0);
  assert.equal(f.head(), f.base);
  writeFileSync(join(f.repo, 'other.txt'), 'source moved');
  f.git('add', '-A');
  f.git('commit', '-qm', 'external source change');
  f.git('push', 'origin', 'main');
  const moved = f.integrate(() => {
    mutations += 1;
    return true;
  });
  assert.equal(moved.state, 'REREALIZE_REQUIRED');
  assert.equal(mutations, 0);
});

test('broker resumes immutable candidate publication despite changed process timestamps', (t) => {
  const f = fixture(t, true);
  assert.equal(f.brokered.publication.state, 'PUBLISHED');
  const before = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = '2050-01-01T00:00:00Z';
  process.env.GIT_COMMITTER_DATE = '2050-01-01T00:00:00Z';
  try {
    const repeated = brokerAssignedSourceProposal(f.repo, f.assignment, f.proposal, {
      transactionContext: f.context,
    });
    assert.equal(repeated.publication.state, 'ALREADY_PUBLISHED');
    assert.equal(repeated.candidate.commit_sha, f.brokered.candidate.commit_sha);
  } finally {
    if (before.author === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = before.author;
    if (before.committer === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = before.committer;
  }
});

test('broker retry refuses a changed trusted baseline policy', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      brokerAssignedSourceProposal(f.repo, f.assignment, f.proposal, {
        transactionContext: { ...f.context, baseline_id: 'different-policy' },
      }),
    /SOURCE_TRANSACTION_ALREADY_BOUND/,
  );
});
