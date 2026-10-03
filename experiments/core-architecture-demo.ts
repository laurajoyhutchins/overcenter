import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { githubGet } from '../src/providers/github/rest.ts';
import { dispatchSourceValidation } from '../src/source/validation-dispatch.ts';
import { brokerAssignedSourceProposal } from '../src/source/source-broker.ts';
import {
  SOURCE_VERIFICATION_SCHEMA,
  integrateVerifiedSourceCandidate,
  type SourceVerification,
} from '../src/source/source-integration.ts';
import {
  buildSourceAssignment,
  validateSourceTaskPacket,
  type SourceClaimBinding,
  type SourceTaskPacket,
} from '../src/source/source-obligation.ts';
import { admitSourceProof, trustedSourceProof } from '../src/source/source-proof.ts';
import { sourceProofRecord } from '../src/source/source-proof-record.ts';
import {
  buildSourceTransactionPlan,
  type SourceTransactionPlan,
} from '../src/source/transaction.ts';
import { isData, isPositiveSafeInteger } from '../src/validation.ts';

interface VerificationObservation {
  readonly workflow_run_id: number;
  readonly workflow_run_attempt: number;
  readonly record_job_id: number;
}

interface Scenario {
  readonly name: 'clean' | 'stale' | 'ambiguous';
  readonly authorityRef: string;
  readonly targetRef: string;
  readonly kernel: GitOvercenterKernel;
  readonly task: SourceTaskPacket;
  readonly claim: SourceClaimBinding;
  readonly candidateSha: string;
  readonly candidateRef: string;
  readonly plan: SourceTransactionPlan;
  verification?: SourceVerification;
  observation?: VerificationObservation;
}

interface DemoReport {
  schema: 'overcenter-core-architecture-demo/v1';
  repository: string;
  runtime_sha: string;
  workflow_run_id: string;
  workflow_run_attempt: string;
  scope_violation: { rejected: boolean; reason: string };
  clean: Record<string, unknown>;
  stale: Record<string, unknown>;
  ambiguous: Record<string, unknown>;
}

const repo = process.cwd();
const repository = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? '';
const runtimeSha = (process.env.GITHUB_SHA ?? '').toLowerCase();
const workflowRunId = process.env.GITHUB_RUN_ID ?? '';
const workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('DEMO_REPOSITORY_INVALID');
}
if (!token) throw new Error('DEMO_GITHUB_TOKEN_MISSING');
if (!/^[0-9a-f]{40}$/.test(runtimeSha)) throw new Error('DEMO_RUNTIME_SHA_INVALID');
if (!/^\d+$/.test(workflowRunId) || !/^\d+$/.test(workflowRunAttempt)) {
  throw new Error('DEMO_WORKFLOW_ID_INVALID');
}

const [owner, name] = repository.split('/');
if (!owner || !name) throw new Error('DEMO_REPOSITORY_INVALID');

const api = (suffix: string): unknown =>
  githubGet(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`,
  );

const repositoryValue = api('');
if (!isData(repositoryValue) || !isPositiveSafeInteger(repositoryValue.id)) {
  throw new Error('DEMO_REPOSITORY_ID_UNAVAILABLE');
}
const repositoryId = repositoryValue.id;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function remoteHead(ref: string): string | null {
  const listed = git('ls-remote', 'origin', ref);
  if (!listed) return null;
  const sha = listed.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('DEMO_REMOTE_REF_INVALID');
  return sha;
}

function createRemoteRef(ref: string, sha: string): void {
  assert.equal(remoteHead(ref), null, `ref already exists: ${ref}`);
  git('push', '--porcelain', 'origin', `${sha}:${ref}`);
  assert.equal(remoteHead(ref), sha);
}

function forceRemoteRef(ref: string, sha: string): void {
  git('push', '--porcelain', '--force', 'origin', `${sha}:${ref}`);
  assert.equal(remoteHead(ref), sha);
}

function deleteRemoteRef(ref: string): void {
  try {
    git('push', '--porcelain', 'origin', `:${ref}`);
  } catch {
    // Cleanup is deliberately best effort. The evidence is already bound to an exact SHA.
  }
}

const runLabel = `${workflowRunId}-${workflowRunAttempt}`;

function scenarioRefs(name: Scenario['name']): { authorityRef: string; targetRef: string } {
  return {
    authorityRef: `refs/overcenter/core-demo/${runLabel}/${name}`,
    targetRef: `refs/heads/overcenter/core-demo/${runLabel}/${name}`,
  };
}

function proposalFor(
  claim: SourceClaimBinding,
  path: string,
  content: string,
): {
  schema: 'overcenter-source-proposal/v1';
  run_id: string;
  claimed_revision: string;
  claimed_source_sha: string;
  files: Array<{ path: string; content_base64: string }>;
} {
  return {
    schema: 'overcenter-source-proposal/v1',
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    files: [{ path, content_base64: Buffer.from(content, 'utf8').toString('base64') }],
  };
}

function createScenario(name: Scenario['name']): Scenario {
  const refs = scenarioRefs(name);
  createRemoteRef(refs.targetRef, runtimeSha);

  const kernel = new GitOvercenterKernel(repo, {
    ref: refs.authorityRef,
    remote: 'origin',
    githubToken: token,
  });
  kernel.initialize();

  const path = `docs/core-architecture-demo-${name}.txt`;
  const task = validateSourceTaskPacket({
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: `Hosted core architecture demonstration: ${name}`,
    writable_paths: [path],
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  });

  kernel.define({
    id: 'source',
    packet: task,
    postcondition: { verifier: 'source-integration/v1' },
  });
  const claimPermit = kernel.claim('source', kernel.head()!, { sourceRevision: runtimeSha });
  const claim = kernel.sourceClaimBinding(claimPermit.id);
  const assignment = buildSourceAssignment('source', task, claim);

  if (name === 'clean') {
    const invalid = proposalFor(
      claim,
      'README.md',
      'This write must never escape the declared source scope.\n',
    );
    let rejected = '';
    try {
      brokerAssignedSourceProposal(repo, assignment, invalid, {
        authorityRef: refs.authorityRef,
        remote: 'origin',
        githubToken: token,
      });
    } catch (error: unknown) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    assert.ok(rejected, 'out-of-scope proposal unexpectedly survived the broker');
    assert.equal(remoteHead(`refs/heads/overcenter/candidate/${claim.run_id}`), null);
    scopeViolation = { rejected: true, reason: rejected };
  }

  const proposal = proposalFor(
    claim,
    path,
    `Overcenter integrated the ${name} hosted core-architecture demonstration.\n`,
  );
  const brokered = brokerAssignedSourceProposal(repo, assignment, proposal, {
    authorityRef: refs.authorityRef,
    remote: 'origin',
    githubToken: token,
  });
  if (brokered.publication.state === 'CONFLICT') {
    throw new Error('DEMO_CANDIDATE_PUBLICATION_CONFLICT');
  }

  const plan = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: brokered.candidate.commit_sha,
    context: {
      repository_id: repositoryId,
      repository_full_name: repository,
      runtime_sha: runtimeSha,
    },
  });

  dispatchSourceValidation(token, repository, brokered.publication, runtimeSha);

  return {
    name,
    authorityRef: refs.authorityRef,
    targetRef: refs.targetRef,
    kernel,
    task,
    claim,
    candidateSha: brokered.candidate.commit_sha,
    candidateRef: brokered.publication.ref,
    plan,
  };
}

let scopeViolation = { rejected: false, reason: '' };

function parseWorkflowRun(value: unknown):
  | {
      id: number;
      run_attempt: number;
      status: string;
      conclusion: string | null;
      head_sha: string;
      head_branch: string;
      event: string;
    }
  | null {
  if (!isData(value)) return null;
  if (
    !isPositiveSafeInteger(value.id) ||
    !isPositiveSafeInteger(value.run_attempt) ||
    typeof value.status !== 'string' ||
    (value.conclusion !== null && typeof value.conclusion !== 'string') ||
    typeof value.head_sha !== 'string' ||
    typeof value.head_branch !== 'string' ||
    typeof value.event !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    run_attempt: value.run_attempt,
    status: value.status,
    conclusion: value.conclusion,
    head_sha: value.head_sha,
    head_branch: value.head_branch,
    event: value.event,
  };
}

function parseJob(value: unknown):
  | {
      id: number;
      run_id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_sha: string;
    }
  | null {
  if (!isData(value)) return null;
  if (
    !isPositiveSafeInteger(value.id) ||
    !isPositiveSafeInteger(value.run_id) ||
    typeof value.name !== 'string' ||
    typeof value.status !== 'string' ||
    (value.conclusion !== null && typeof value.conclusion !== 'string') ||
    typeof value.head_sha !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    run_id: value.run_id,
    name: value.name,
    status: value.status,
    conclusion: value.conclusion,
    head_sha: value.head_sha,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function observeVerification(scenario: Scenario): Promise<void> {
  const branch = scenario.candidateRef.slice('refs/heads/'.length);
  let run:
    | {
        id: number;
        run_attempt: number;
        status: string;
        conclusion: string | null;
        head_sha: string;
        head_branch: string;
        event: string;
      }
    | null = null;

  for (let poll = 0; poll < 240; poll += 1) {
    const response = api(
      `/actions/workflows/agent-candidate-signal.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=20`,
    );
    if (isData(response) && Array.isArray(response.workflow_runs)) {
      run =
        response.workflow_runs
          .map(parseWorkflowRun)
          .find(
            (candidate) =>
              candidate !== null &&
              candidate.head_sha === scenario.candidateSha &&
              candidate.head_branch === branch &&
              candidate.event === 'workflow_dispatch',
          ) ?? null;
    }
    if (run?.status === 'completed') break;
    await delay(5_000);
  }

  if (!run || run.status !== 'completed') {
    throw new Error(`DEMO_VERIFICATION_TIMEOUT:${scenario.name}`);
  }
  if (run.conclusion !== 'success') {
    throw new Error(`DEMO_VERIFICATION_FAILED:${scenario.name}:${run.conclusion ?? 'unknown'}`);
  }

  const jobsValue = api(
    `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  if (!isData(jobsValue) || !Array.isArray(jobsValue.jobs) || jobsValue.jobs.length >= 100) {
    throw new Error('DEMO_VERIFICATION_JOBS_INVALID');
  }
  const jobs = jobsValue.jobs.map(parseJob).filter((job) => job !== null);
  const recordJobs = jobs.filter(
    (job) => job.name === scenario.plan.verification_profile.profile.record_job,
  );
  assert.equal(recordJobs.length, 1);
  const recordJob = recordJobs[0]!;
  assert.equal(recordJob.status, 'completed');
  assert.equal(recordJob.conclusion, 'success');
  assert.equal(recordJob.run_id, run.id);
  assert.equal(recordJob.head_sha, scenario.candidateSha);

  const record = sourceProofRecord(
    scenario.plan,
    {
      workflow_run_id: run.id,
      workflow_run_attempt: run.run_attempt,
      job_id: recordJob.id,
    },
    'success',
  );
  const proofWitness = admitSourceProof(scenario.plan, record, {
    githubToken: token,
    expectedWorkflowRunId: run.id,
    expectedWorkflowRunAttempt: run.run_attempt,
    context: {
      repository_id: repositoryId,
      repository_full_name: repository,
      runtime_sha: runtimeSha,
      verification_profile_id: scenario.plan.verification_profile.profile.id,
      verification_profile_sha256: scenario.plan.verification_profile.sha256,
    },
    get: githubGet,
  });
  const proof = trustedSourceProof(proofWitness);
  scenario.verification = {
    schema: SOURCE_VERIFICATION_SCHEMA,
    state: 'verified',
    run_id: proof.run_id,
    candidate_sha: proof.candidate_sha,
    base_sha: proof.base_sha,
    tree_sha: proof.tree_sha,
    reason: null,
  };
  scenario.observation = {
    workflow_run_id: run.id,
    workflow_run_attempt: run.run_attempt,
    record_job_id: recordJob.id,
  };
}

function verified(scenario: Scenario): SourceVerification {
  if (!scenario.verification) throw new Error(`DEMO_VERIFICATION_MISSING:${scenario.name}`);
  return scenario.verification;
}

function integrateClean(scenario: Scenario): Record<string, unknown> {
  const permit = scenario.kernel.acquireExecution(scenario.claim.run_id);
  const authority = scenario.kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
  let mutations = 0;
  const integrated = integrateVerifiedSourceCandidate(
    repo,
    scenario.task,
    scenario.claim,
    'source',
    scenario.candidateSha,
    verified(scenario),
    {
      remote: 'origin',
      ref: scenario.targetRef,
      performReservedMutation: (mutation) =>
        scenario.kernel.performEffectSync(authority, () => {
          mutations += 1;
          return mutation();
        }),
    },
  );
  assert.equal(integrated.state, 'INTEGRATED');
  if (integrated.state !== 'INTEGRATED') throw new Error('DEMO_CLEAN_NOT_INTEGRATED');
  const settled = scenario.kernel.settleSourceIntegration(permit, integrated.witness);
  assert.equal(settled.disposition, 'DONE');
  assert.equal(settled.verified, true);
  assert.equal(mutations, 1);
  assert.equal(remoteHead(scenario.targetRef), integrated.commit_sha);

  let replayMutations = 0;
  const replayed = integrateVerifiedSourceCandidate(
    repo,
    scenario.task,
    scenario.claim,
    'source',
    scenario.candidateSha,
    verified(scenario),
    {
      remote: 'origin',
      ref: scenario.targetRef,
      performReservedMutation: () => {
        replayMutations += 1;
        return false;
      },
    },
  );
  assert.equal(replayed.state, 'ALREADY_INTEGRATED');
  assert.equal(replayMutations, 0);

  return {
    outcome: integrated.state,
    integration_commit: integrated.commit_sha,
    disposition: settled.disposition,
    verified: settled.verified,
    mutation_count: mutations,
    replay_outcome: replayed.state,
    replay_mutation_count: replayMutations,
    target_ref: scenario.targetRef,
    target_head: remoteHead(scenario.targetRef),
    authority_ref: scenario.authorityRef,
    authority_head: scenario.kernel.head(),
    candidate_sha: scenario.candidateSha,
    verification: scenario.observation,
  };
}

function integrateStale(scenario: Scenario): Record<string, unknown> {
  const tree = git('rev-parse', `${runtimeSha}^{tree}`);
  const external = git('commit-tree', tree, '-p', runtimeSha, '-m', 'external demo source movement');
  assert.match(external, /^[0-9a-f]{40}$/);
  forceRemoteRef(scenario.targetRef, external);

  const permit = scenario.kernel.acquireExecution(scenario.claim.run_id);
  const authority = scenario.kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
  let mutations = 0;
  const result = integrateVerifiedSourceCandidate(
    repo,
    scenario.task,
    scenario.claim,
    'source',
    scenario.candidateSha,
    verified(scenario),
    {
      remote: 'origin',
      ref: scenario.targetRef,
      performReservedMutation: (mutation) =>
        scenario.kernel.performEffectSync(authority, () => {
          mutations += 1;
          return mutation();
        }),
    },
  );
  assert.equal(result.state, 'REREALIZE_REQUIRED');
  assert.equal(mutations, 0);
  if (result.state !== 'REREALIZE_REQUIRED') throw new Error('DEMO_STALE_NOT_REFUSED');
  const retried = scenario.kernel.retrySourceIntegration(permit, result.reason, {
    demo: 'stale-source',
  });
  assert.equal(retried.disposition, 'READY');

  return {
    outcome: result.state,
    reason: result.reason,
    mutation_count: mutations,
    disposition: retried.disposition,
    target_ref: scenario.targetRef,
    target_head: remoteHead(scenario.targetRef),
    external_commit: external,
    authority_ref: scenario.authorityRef,
    authority_head: scenario.kernel.head(),
    candidate_sha: scenario.candidateSha,
    verification: scenario.observation,
  };
}

function integrateAmbiguous(scenario: Scenario): Record<string, unknown> {
  const permit = scenario.kernel.acquireExecution(scenario.claim.run_id);
  const authority = scenario.kernel.authorizeEffect(permit, GITHUB_SOURCE_INTEGRATION_EFFECT);
  let mutations = 0;
  const uncertain = integrateVerifiedSourceCandidate(
    repo,
    scenario.task,
    scenario.claim,
    'source',
    scenario.candidateSha,
    verified(scenario),
    {
      remote: 'origin',
      ref: scenario.targetRef,
      performReservedMutation: (mutation) =>
        scenario.kernel.performEffectSync(authority, () => {
          mutations += 1;
          const applied = mutation();
          assert.equal(applied, true);
          throw new Error('SIMULATED_TRANSPORT_TIMEOUT_AFTER_REMOTE_COMMIT');
        }),
    },
  );
  assert.equal(uncertain.state, 'RECOVERY_REQUIRED');
  assert.equal(mutations, 1);
  assert.notEqual(remoteHead(scenario.targetRef), runtimeSha);

  const recovery = scenario.kernel.recoverInterrupted(permit, {
    demo: 'simulated transport timeout after remote commit',
  });
  assert.equal(recovery.disposition, 'RECOVERY_REQUIRED');

  const recoveredPermit = scenario.kernel.acquireExecution(scenario.claim.run_id);
  let replayMutations = 0;
  const reconciled = integrateVerifiedSourceCandidate(
    repo,
    scenario.task,
    scenario.claim,
    'source',
    scenario.candidateSha,
    verified(scenario),
    {
      remote: 'origin',
      ref: scenario.targetRef,
      performReservedMutation: () => {
        replayMutations += 1;
        return false;
      },
    },
  );
  assert.equal(reconciled.state, 'ALREADY_INTEGRATED');
  assert.equal(replayMutations, 0);
  if (reconciled.state !== 'ALREADY_INTEGRATED') {
    throw new Error('DEMO_AMBIGUOUS_RECONCILIATION_FAILED');
  }
  const settled = scenario.kernel.settleSourceIntegration(recoveredPermit, reconciled.witness);
  assert.equal(settled.disposition, 'DONE');
  assert.equal(settled.verified, true);

  return {
    first_outcome: uncertain.state,
    first_reason:
      uncertain.state === 'RECOVERY_REQUIRED' ? uncertain.reason : 'unexpected-success',
    mutation_count: mutations,
    recovery_disposition: recovery.disposition,
    reconciliation_outcome: reconciled.state,
    reconciliation_mutation_count: replayMutations,
    final_disposition: settled.disposition,
    final_verified: settled.verified,
    integration_commit: reconciled.commit_sha,
    target_ref: scenario.targetRef,
    target_head: remoteHead(scenario.targetRef),
    authority_ref: scenario.authorityRef,
    authority_head: scenario.kernel.head(),
    candidate_sha: scenario.candidateSha,
    verification: scenario.observation,
  };
}

git('config', 'user.name', 'Overcenter Core Demo');
git('config', 'user.email', 'overcenter-core-demo@local');

const scenarios = [
  createScenario('clean'),
  createScenario('stale'),
  createScenario('ambiguous'),
] as const;

await Promise.all(scenarios.map(observeVerification));

const clean = integrateClean(scenarios[0]);
const stale = integrateStale(scenarios[1]);
const ambiguous = integrateAmbiguous(scenarios[2]);

for (const scenario of scenarios) deleteRemoteRef(scenario.candidateRef);

const report: DemoReport = {
  schema: 'overcenter-core-architecture-demo/v1',
  repository,
  runtime_sha: runtimeSha,
  workflow_run_id: workflowRunId,
  workflow_run_attempt: workflowRunAttempt,
  scope_violation: scopeViolation,
  clean,
  stale,
  ambiguous,
};

writeFileSync('core-architecture-demo.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(
    summaryPath,
    [
      '## Hosted core architecture proof',
      '',
      `Runtime: \`${runtimeSha}\``,
      '',
      '| Case | Result | Mutation count |',
      '| --- | --- | ---: |',
      `| out-of-scope proposal | ${scopeViolation.rejected ? 'REJECTED' : 'FAILED'} | 0 |`,
      `| exact verified integration | ${String(clean.outcome)} / ${String(clean.disposition)} | ${String(clean.mutation_count)} |`,
      `| replay | ${String(clean.replay_outcome)} | ${String(clean.replay_mutation_count)} |`,
      `| source moved after verification | ${String(stale.outcome)} | ${String(stale.mutation_count)} |`,
      `| uncertain transport | ${String(ambiguous.first_outcome)} → ${String(ambiguous.reconciliation_outcome)} → ${String(ambiguous.final_disposition)} | ${String(ambiguous.mutation_count)} + ${String(ambiguous.reconciliation_mutation_count)} |`,
      '',
      '### Retained real refs',
      '',
      `- clean target: \`${String(clean.target_ref)}\` at \`${String(clean.target_head)}\``,
      `- stale target: \`${String(stale.target_ref)}\` at \`${String(stale.target_head)}\``,
      `- ambiguous target: \`${String(ambiguous.target_ref)}\` at \`${String(ambiguous.target_head)}\``,
      '',
      'Each source candidate was admitted from the existing hosted `agent-candidate-signal` workflow. Candidate refs were deleted after proof admission; exact workflow/run/job identities remain in the JSON artifact.',
      '',
    ].join('\n'),
    'utf8',
  );
}

console.log(JSON.stringify(report, null, 2));
