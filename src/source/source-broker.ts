import {
  baselineSourceTransactionPlan,
  validateSourceTransactionContext,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { canonicalDigest } from '../digest.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import {
  brokerSourceProposal,
  type SourceCandidatePublicationResult,
} from './source-integration.ts';
import {
  SOURCE_PROPOSAL_SCHEMA,
  validateSourceAssignment,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceProposal,
} from './source-obligation.ts';

export interface BrokeredAssignedSourceProposal {
  authority_head: string;
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
}

export function brokerAssignedSourceProposal(
  repo: string,
  assignmentValue: unknown,
  proposalValue: unknown,
  {
    authorityRef = 'refs/overcenter/state',
    remote = 'origin',
    githubToken = null,
    transactionContext,
  }: {
    authorityRef?: string;
    remote?: string;
    githubToken?: string | null;
    transactionContext?: SourceTransactionContext;
  } = {},
): BrokeredAssignedSourceProposal {
  const assignment = validateSourceAssignment(assignmentValue);
  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  const authorityHead = kernel.head();
  if (!authorityHead) throw new Error('SOURCE_BROKER_AUTHORITY_MISSING');

  const current = kernel
    .inspect()
    .find(
      (work) => work.id === assignment.obligation_id && work.run_id === assignment.claim.run_id,
    );
  if (!current || current.status !== 'EXECUTING') {
    throw new Error('SOURCE_BROKER_RUN_NOT_EXECUTING');
  }
  if (
    current.packet.kind !== 'source-change' ||
    current.postcondition.verifier !== 'source-integration/v1'
  ) {
    throw new Error('SOURCE_BROKER_WORK_INVALID');
  }

  const claim = kernel.sourceClaimBinding(assignment.claim.run_id);
  if (
    claim.obligation_key !== assignment.claim.obligation_key ||
    claim.run_id !== assignment.claim.run_id ||
    claim.claimed_revision !== assignment.claim.claimed_revision ||
    claim.source_sha !== assignment.claim.source_sha
  ) {
    throw new Error('SOURCE_BROKER_ASSIGNMENT_STALE');
  }
  if (canonicalDigest(current.packet) !== canonicalDigest(assignment.task)) {
    throw new Error('SOURCE_BROKER_TASK_MISMATCH');
  }

  const brokered = brokerSourceProposal(
    repo,
    assignment.obligation_id,
    current.packet,
    claim,
    proposalValue,
    {
      remote,
      beforePublish: bindCandidate(kernel, repo, assignment.claim.run_id, transactionContext),
    },
  );
  return {
    authority_head: kernel.head()!,
    candidate: brokered.candidate,
    publication: brokered.publication,
  };
}

function exactSha(value: string, error: string): string {
  const sha = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(error);
  return sha;
}

function proposalFromRevision(
  repo: string,
  runId: string,
  sourceSha: string,
  proposalShaValue: string,
): SourceProposal {
  const proposalSha = exactSha(proposalShaValue, 'SOURCE_PROPOSAL_REVISION_INVALID');
  if (
    (spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sourceSha, proposalSha], {
      stdio: 'ignore',
    }).status ?? 1) !== 0
  ) {
    throw new Error('SOURCE_PROPOSAL_REVISION_NOT_DESCENDANT');
  }

  const delta = observeRepositoryDelta(repo, sourceSha, proposalSha);
  assertSupportedSourceDelta(delta);
  for (const entry of delta.entries)
    if (entry.after && entry.after.mode !== (entry.before?.mode ?? '100644'))
      throw new Error(`SOURCE_PROPOSAL_MODE_UNREPRESENTABLE:${entry.path}`);
  const paths = delta.entries.map((entry) => entry.path);
  if (paths.length === 0) throw new Error('SOURCE_PROPOSAL_REVISION_EMPTY');

  return {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: runId,
    claimed_revision: '',
    claimed_source_sha: sourceSha,
    files: paths.map((path) => {
      const exists =
        (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${proposalSha}:${path}`], {
          stdio: 'ignore',
        }).status ?? 1) === 0;
      return {
        path,
        content_base64: exists
          ? execFileSync('git', ['-C', repo, 'show', `${proposalSha}:${path}`]).toString('base64')
          : null,
      };
    }),
  };
}

export function brokerSourceProposalRevision(
  repo: string,
  runIdValue: string,
  proposalSha: string,
  {
    authorityRef = 'refs/overcenter/state',
    remote = 'origin',
    githubToken = null,
    transactionContext,
  }: {
    authorityRef?: string;
    remote?: string;
    githubToken?: string | null;
    transactionContext?: SourceTransactionContext;
  } = {},
): BrokeredAssignedSourceProposal {
  const runId = runIdValue.trim();
  if (!runId) throw new Error('SOURCE_BROKER_RUN_ID_INVALID');
  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  const authorityHead = kernel.head();
  if (!authorityHead) throw new Error('SOURCE_BROKER_AUTHORITY_MISSING');

  const current = kernel.inspect().find((work) => work.run_id === runId);
  if (!current || current.status !== 'EXECUTING') {
    throw new Error('SOURCE_BROKER_RUN_NOT_EXECUTING');
  }
  if (
    current.packet.kind !== 'source-change' ||
    current.postcondition.verifier !== 'source-integration/v1'
  ) {
    throw new Error('SOURCE_BROKER_WORK_INVALID');
  }
  const task = validateSourceTaskPacket(current.packet);
  const claim = kernel.sourceClaimBinding(runId);
  const proposal = proposalFromRevision(repo, runId, claim.source_sha, proposalSha);
  proposal.claimed_revision = claim.claimed_revision;

  const brokered = brokerSourceProposal(repo, current.id, task, claim, proposal, {
    remote,
    beforePublish: bindCandidate(kernel, repo, runId, transactionContext),
  });
  return {
    authority_head: kernel.head()!,
    candidate: brokered.candidate,
    publication: brokered.publication,
  };
}

function bindCandidate(
  kernel: GitOvercenterKernel,
  repo: string,
  runId: string,
  context: SourceTransactionContext | undefined,
) {
  return (candidate: SourceCandidate): void => {
    if (!context) throw new Error('SOURCE_TRANSACTION_CONTEXT_MISSING');
    validateSourceTransactionContext(context);
    const claim = kernel.sourceClaimBinding(runId);
    const task = validateSourceTaskPacket(kernel.claimedWork(runId).packet);
    const delta = observeRepositoryDelta(repo, claim.source_sha, candidate.commit_sha);
    assertSupportedSourceDelta(delta);
    const assurance = baselineSourceTransactionPlan(repo, delta, context);
    if (assurance.validation_mode === 'unsupported')
      throw new Error('SOURCE_TRANSACTION_RECONCILIATION_REQUIRED');
    const prior = kernel.sourceTransaction(runId);
    if (prior) {
      if (
        prior.plan.candidate_sha !== candidate.commit_sha ||
        prior.plan.repository_id !== context.repository_id ||
        prior.plan.repository_full_name !== context.repository_full_name ||
        prior.plan.runtime_sha !== context.runtime_sha ||
        canonicalDigest(prior.plan.assurance) !== canonicalDigest(assurance)
      )
        throw new Error('SOURCE_TRANSACTION_ALREADY_BOUND');
      return;
    }
    const permit = kernel.acquireExecution(runId);
    kernel.bindSourceTransaction(permit, {
      schema: 'overcenter-source-transaction',
      schema_version: 1,
      repository_id: context.repository_id,
      repository_full_name: context.repository_full_name,
      runtime_sha: context.runtime_sha,
      claim,
      execution_generation: permit.execution_generation,
      execution_authority_commit: permit.execution_authority_commit,
      candidate_sha: candidate.commit_sha,
      candidate_tree: delta.candidate_tree,
      authorized_write_set: task.writable_paths,
      expected_write_set: task.expected_write_set ?? delta.entries.map((entry) => entry.path),
      observed_write_set: delta.entries.map((entry) => entry.path),
      assurance,
    });
  };
}
