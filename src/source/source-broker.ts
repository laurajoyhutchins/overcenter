import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../digest.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import {
  inspectSourceCandidate,
  type SourceCandidatePublicationResult,
} from './source-integration.ts';
import {
  assertSourceWriteEnvelope,
  validateSourceAssignment,
  validateSourceProposal,
  type SourceCandidate,
  type SourceClaimBinding,
} from './source-obligation.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import { readSourceVerificationProfile } from './source-verification-profile.ts';

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
    candidateGit(candidateTree.root, [
      'add',
      '-A',
      '--',
      ...proposal.files.map((file) => file.path),
    ]);
    if (candidateGitStatus(candidateTree.root, ['diff', '--cached', '--quiet']) === 0) {
      throw new Error('SOURCE_PROPOSAL_EMPTY');
    }
    candidateGit(candidateTree.root, [
      '-c',
      'user.name=Overcenter Source Broker',
      '-c',
      'user.email=overcenter@local',
      'commit',
      '-m',
      sourceCandidateMessage(obligationId, claim),
    ]);
    candidateSha = candidateGit(candidateTree.root, ['rev-parse', 'HEAD']);
  } finally {
    candidateTree.dispose();
  }

  const inspected = inspectSourceCandidate(repo, taskValue, claim, candidateSha, obligationId);
  const delta = observeRepositoryDelta(repo, claim.source_sha, candidateSha);
  assertSupportedSourceDelta(delta);
  const profile = readSourceVerificationProfile(repo, claim.source_sha).profile;
  assertSourceWriteEnvelope(
    taskValue,
    delta.entries.map((entry) => {
      const size = (objectId: string | undefined) =>
        objectId ? Number(candidateGit(repo, ['cat-file', '-s', objectId])) : 0;
      return {
        path: entry.path,
        changed_bytes: size(entry.before?.object_id) + size(entry.after?.object_id),
      };
    }),
    profile.protected_paths,
  );
  return inspected.candidate;
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
