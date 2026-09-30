import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../digest.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { inspectSourceCandidate } from './source-integration.ts';
import {
  SOURCE_PROPOSAL_SCHEMA,
  validateSourceAssignment,
  validateSourceProposal,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceClaimBinding,
  type SourceProposal,
} from './source-obligation.ts';

function candidateWorktree(repo: string, revision: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-candidate-'));
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', root, revision], {
      stdio: 'ignore',
    });
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    dispose: () => {
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', root], { stdio: 'ignore' });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type SourceCandidatePublicationResult =
  | { state: 'PUBLISHED' | 'ALREADY_PUBLISHED'; ref: string; candidate_sha: string }
  | { state: 'CONFLICT'; ref: string; observed_sha: string };

function sourceCandidateMessage(obligationId: string, claim: SourceClaimBinding): string {
  return [
    `source candidate ${claim.run_id}`,
    '',
    `Overcenter-Obligation-Id: ${obligationId}`,
    `Overcenter-Obligation-Key: ${claim.obligation_key}`,
    `Overcenter-Claimed-Revision: ${claim.claimed_revision}`,
    `Overcenter-Claimed-Source: ${claim.source_sha}`,
  ].join('\n');
}

function materializeSourceProposal(
  repo: string,
  obligationId: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
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
    git(candidateTree.root, ['add', '-A', '--', ...proposal.files.map((file) => file.path)]);
    if (gitStatus(candidateTree.root, ['diff', '--cached', '--quiet']) === 0) {
      throw new Error('SOURCE_PROPOSAL_EMPTY');
    }
    git(candidateTree.root, [
      '-c',
      'user.name=Overcenter Source Broker',
      '-c',
      'user.email=overcenter@local',
      'commit',
      '-m',
      sourceCandidateMessage(obligationId, claim),
    ]);
    candidateSha = git(candidateTree.root, ['rev-parse', 'HEAD']);
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

  if (gitStatus(repo, ['push', '--porcelain', remote, `${candidateSha}:${ref}`]) === 0) {
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
  { remote = 'origin' }: { remote?: string } = {},
): {
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
} {
  const candidate = materializeSourceProposal(repo, obligationId, taskValue, claim, proposalValue);
  const publication = publishSourceCandidate(repo, taskValue, claim, candidate.commit_sha, {
    remote,
  });
  return { candidate, publication };
}

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
