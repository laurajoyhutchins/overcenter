import {
  baselineSourceTransactionPlan,
  validateSourceTransactionContext,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../digest.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import {
  inspectSourceCandidate,
  type SourceCandidatePublicationResult,
} from './source-integration.ts';
import {
  validateSourceAssignment,
  validateSourceProposal,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceClaimBinding,
} from './source-obligation.ts';
import { buildSourceTransactionPlan, type SourceTransactionPlan } from './transaction.ts';

function candidateGit(repo: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
}

function candidateGitStatus(repo: string, args: string[]): number {
  return spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status ?? 1;
}

function candidateWorktree(repo: string, revision: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-candidate-'));
  try {
    candidateGit(repo, ['worktree', 'add', '--detach', root, revision]);
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    dispose: () => {
      candidateGitStatus(repo, ['worktree', 'remove', '--force', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sourceCandidateMessage(obligationId: string, claim: SourceClaimBinding, runtimeSha?: string): string {
  return [
    `source candidate ${claim.run_id}`, '',
    `Overcenter-Obligation-Id: ${obligationId}`,
    `Overcenter-Obligation-Key: ${claim.obligation_key}`,
    `Overcenter-Claimed-Revision: ${claim.claimed_revision}`,
    `Overcenter-Claimed-Source: ${claim.source_sha}`,
    ...(runtimeSha ? [`Overcenter-Runtime-Sha: ${runtimeSha}`] : []),
  ].join('\n');
}

function materializeSourceProposal(
  repo: string,
  obligationId: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
  runtimeSha?: string,
): SourceCandidate {
  const proposal = validateSourceProposal(proposalValue, taskValue, claim);
  const candidateTree = candidateWorktree(repo, claim.source_sha);
  let candidateSha = '';
  try {
    for (const file of proposal.files) {
      const parts = file.path.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        const path = parts.slice(0, index).join('/');
        const entry = execFileSync(
          'git',
          ['-C', repo, '--literal-pathspecs', 'ls-tree', '-z', claim.source_sha, '--', path],
          { encoding: 'utf8' },
        );
        if (!entry) continue;
        const mode = entry.slice(0, 6);
        const allowed = index === parts.length ? ['100644', '100755'] : ['040000'];
        if (!allowed.includes(mode))
          throw new Error(`SOURCE_PROPOSAL_MODE_UNSUPPORTED:${path}:${mode}`);
      }
    }
    for (const file of proposal.files) {
      const target = join(candidateTree.root, file.path);
      if (file.content_base64 === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(file.content_base64, 'base64'));
      }
    }
    candidateGit(candidateTree.root, [
      '--literal-pathspecs',
      'add',
      '-A',
      '--',
      ...proposal.files.map((file) => file.path),
    ]);
    if (candidateGitStatus(candidateTree.root, ['diff', '--cached', '--quiet']) === 0) {
      throw new Error('SOURCE_PROPOSAL_EMPTY');
    }
    const sourceDate = candidateGit(repo, ['show', '-s', '--format=%cI', claim.source_sha]);
    candidateGit(
      candidateTree.root,
      [
        '-c',
        'user.name=Overcenter Source Broker',
        '-c',
        'user.email=overcenter@local',
        'commit',
        '-m',
        sourceCandidateMessage(obligationId, claim, runtimeSha),
      ],
      { ...process.env, GIT_AUTHOR_DATE: sourceDate, GIT_COMMITTER_DATE: sourceDate },
    );
    candidateSha = candidateGit(candidateTree.root, ['rev-parse', 'HEAD']);
  } finally {
    candidateTree.dispose();
  }

  return inspectSourceCandidate(repo, taskValue, claim, candidateSha, obligationId).candidate;
}

function publishSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
  { remote = 'origin' }: { remote?: string } = {},
): SourceCandidatePublicationResult {
  inspectSourceCandidate(repo, taskValue, claim, candidateSha);
  const ref = `refs/heads/overcenter/candidate/${claim.run_id}`;
  const listed = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (listed) {
    const observed = listed.split(/\s+/)[0] ?? '';
    exactSha(observed, 'SOURCE_CANDIDATE_REF_INVALID');
    if (observed === candidateSha) {
      return { state: 'ALREADY_PUBLISHED', ref, candidate_sha: candidateSha };
    }
    return { state: 'CONFLICT', ref, observed_sha: observed };
  }

  if (candidateGitStatus(repo, ['push', '--porcelain', remote, `${candidateSha}:${ref}`]) === 0) {
    return { state: 'PUBLISHED', ref, candidate_sha: candidateSha };
  }

  const after = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!after) throw new Error('SOURCE_CANDIDATE_PUBLICATION_UNCERTAIN');
  const observed = after.split(/\s+/)[0] ?? '';
  exactSha(observed, 'SOURCE_CANDIDATE_REF_INVALID');
  if (observed === candidateSha) {
    return { state: 'ALREADY_PUBLISHED', ref, candidate_sha: candidateSha };
  }
  return { state: 'CONFLICT', ref, observed_sha: observed };
}

export function brokerSourceProposal(
  repo: string,
  obligationId: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
  {
    remote = 'origin',
    beforePublish,
    runtimeSha,
  }: { remote?: string; beforePublish?: (candidate: SourceCandidate) => void; runtimeSha?: string } = {},
): {
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
} {
  const candidate = materializeSourceProposal(repo, obligationId, taskValue, claim, proposalValue, runtimeSha);
  beforePublish?.(candidate);
  const publication = publishSourceCandidate(repo, taskValue, claim, candidate.commit_sha, {
    remote,
  });
  return { candidate, publication };
}

export interface BrokeredAssignedSourceProposal {
  authority_head: string;
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
  transaction_plan?: SourceTransactionPlan;
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

  let transactionPlan: SourceTransactionPlan | undefined;
  const brokered = brokerSourceProposal(repo, assignment.obligation_id, current.packet, claim, proposalValue, {
    remote,
    ...(transactionContext ? { runtimeSha: transactionContext.runtime_sha } : {}),
    beforePublish: transactionContext
      ? (candidate) => {
          transactionPlan = buildSourceTransactionPlan({ repo, taskValue: current.packet, claim, candidateSha: candidate.commit_sha, context: transactionContext });
        }
      : undefined,
  });
  return {
    authority_head: authorityHead,
    candidate: brokered.candidate,
    publication: brokered.publication,
    ...(transactionPlan ? { transaction_plan: transactionPlan } : {}),
  };
}

function exactSha(value: string, error: string): string {
  const sha = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(error);
  return sha;
}
