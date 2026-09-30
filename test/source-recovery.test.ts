import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { brokerAssignedSourceProposal } from '../src/source/source-broker.ts';
import {
  SOURCE_VERIFICATION_SCHEMA,
  integrateVerifiedSourceCandidate,
  type SourceVerification,
} from '../src/source/source-integration.ts';
import {
  buildSourceAssignment,
  validateSourceTaskPacket,
} from '../src/source/source-obligation.ts';
import { admitSourceProof, trustedSourceProof } from '../src/source/source-proof.ts';
import { sourceProofRecord } from '../src/source/source-proof-record.ts';
import { reportSourceTransaction } from '../src/source/transaction-report.ts';
import {
  buildSourceTransactionPlan,
  sourceTransactionPlanDigest,
} from '../src/source/transaction.ts';

function fixture(t: TestContext) {
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
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: 'Update value',
    writable_paths: ['value.ts', 'extra.ts'],
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

  const brokered = brokerAssignedSourceProposal(repo, assignment, proposal);
  const plan = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: brokered.candidate.commit_sha,
    context,
  });
  const record = sourceProofRecord(
    plan,
    { workflow_run_id: 123, workflow_run_attempt: 1, job_id: 11 },
    'success',
  );
  const get = (_token: string, path: string): unknown => {
    if (path.endsWith('/actions/runs/123')) {
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
    }
    if (path.endsWith('/attempts/1/jobs?per_page=100')) {
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
    }
    return { id: 42, full_name: 'acme/widget' };
  };
  const proofWitness = admitSourceProof(plan, record, {
    githubToken: 'fixture',
    expectedWorkflowRunId: 123,
    expectedWorkflowRunAttempt: 1,
    context,
    get,
  });
  const proof = trustedSourceProof(proofWitness);
  const verification: SourceVerification = {
    schema: SOURCE_VERIFICATION_SCHEMA,
    state: 'verified',
    run_id: proof.run_id,
    candidate_sha: proof.candidate_sha,
    base_sha: proof.base_sha,
    tree_sha: proof.tree_sha,
    reason: null,
  };
  const integrate = (performReservedMutation: (mutation: () => boolean) => boolean) =>
    integrateVerifiedSourceCandidate(
      repo,
      task,
      claim,
      'source',
      plan.candidate_sha,
      verification,
      {
        performReservedMutation,
      },
    );
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
] as const) {
  test(`source uncertainty at ${boundary} never blindly replays a mutation`, (t) => {
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
    assert.equal(initial.state, 'RECOVERY_REQUIRED');
    f.kernel.recoverInterrupted(permit, { interrupted_at: boundary });
    const replayed = new GitOvercenterKernel(f.repo, { remote: 'origin' });
    assert.equal(replayed.inspect()[0]?.status, 'RECOVERY_REQUIRED');
    assert.equal(mutations, boundary === 'timeout-after-commit' ? 1 : 0);
    if (boundary === 'timeout-after-commit') assert.notEqual(f.head(), f.base);
    else assert.equal(f.head(), f.base);
  });
}

test('successful reserved integration settles through the unchanged source settlement kernel', (t) => {
  const f = fixture(t);
  const permit = f.kernel.acquireExecution(f.claim.run_id);
  const authority = f.kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
  let mutations = 0;
  const integrated = f.integrate((mutation) =>
    f.kernel.performEffectSync(authority, () => {
      mutations += 1;
      return mutation();
    }),
  );
  assert.equal(integrated.state, 'INTEGRATED');
  if (integrated.state !== 'INTEGRATED') throw new Error('missing integration');
  const settled = f.kernel.settleSourceIntegration(permit, integrated.witness);
  assert.equal(settled.disposition, 'DONE');
  assert.equal(settled.verified, true);
  assert.equal(mutations, 1);
  assert.equal(f.head(), integrated.commit_sha);

  const report = reportSourceTransaction(f.repo, f.claim.run_id, {
    transactionContext: f.context,
  });
  assert.equal(report.authority_settled, true);
  assert.equal(report.settled, false);
  assert.deepEqual(report.planned_write_set, report.observed_write_set);
});

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

test('broker retry never replaces an already-published candidate', (t) => {
  const f = fixture(t);
  const publishedSha = f.brokered.candidate.commit_sha;
  const repeated = brokerAssignedSourceProposal(f.repo, f.assignment, f.proposal);
  if (repeated.publication.state === 'CONFLICT') {
    assert.equal(repeated.publication.observed_sha, publishedSha);
  } else {
    assert.equal(repeated.publication.state, 'ALREADY_PUBLISHED');
    assert.equal(repeated.candidate.commit_sha, publishedSha);
  }
  assert.equal(
    f
      .git('ls-remote', 'origin', `refs/heads/overcenter/candidate/${f.claim.run_id}`)
      .split(/\s+/)[0],
    publishedSha,
  );
});

test('changed policy produces a different proof plan without changing the canonical candidate', (t) => {
  const f = fixture(t);
  const originalPlan = buildSourceTransactionPlan({
    repo: f.repo,
    taskValue: f.assignment.task,
    claim: f.assignment.claim,
    candidateSha: f.brokered.candidate.commit_sha,
    context: f.context,
  });
  const changedPlan = buildSourceTransactionPlan({
    repo: f.repo,
    taskValue: f.assignment.task,
    claim: f.assignment.claim,
    candidateSha: f.brokered.candidate.commit_sha,
    context: { ...f.context, baseline_id: 'different-policy' },
  });
  assert.notEqual(
    sourceTransactionPlanDigest(changedPlan),
    sourceTransactionPlanDigest(originalPlan),
  );
});
