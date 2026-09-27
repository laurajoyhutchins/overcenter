import { execFileSync, spawnSync } from 'node:child_process';
import { canonicalDigest } from '../digest.ts';
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
  }: {
    authorityRef?: string;
    remote?: string;
    githubToken?: string | null;
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
    { remote },
  );
  return {
    authority_head: authorityHead,
    candidate: brokered.candidate,
    publication: brokered.publication,
  };
}


function exactSha(value: string, error: string): string {
  const sha = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(error);
  return sha;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
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

  const changed = execFileSync(
    'git',
    ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', sourceSha, proposalSha],
    { encoding: 'buffer' },
  );
  const paths = changed
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
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
          ? execFileSync('git', ['-C', repo, 'show', `${proposalSha}:${path}`]).toString(
              'base64',
            )
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
  }: {
    authorityRef?: string;
    remote?: string;
    githubToken?: string | null;
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

  const brokered = brokerSourceProposal(repo, current.id, task, claim, proposal, { remote });
  return {
    authority_head: authorityHead,
    candidate: brokered.candidate,
    publication: brokered.publication,
  };
}
