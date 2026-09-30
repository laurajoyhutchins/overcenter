import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalDigest } from '../digest.ts';
import type { Observation } from '../model.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import {
  SOURCE_CANDIDATE_SCHEMA,
  validateSourceCandidate,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceClaimBinding,
  type SourceTaskPacket,
} from './source-obligation.ts';

export const SOURCE_VERIFICATION_SCHEMA = 'overcenter-source-verification/v1' as const;
export const SOURCE_INTEGRATION_EFFECT_IDENTITY_SCHEMA =
  'overcenter-source-integration-effect/v1' as const;

export type SourceCandidatePublicationResult =
  | { state: 'PUBLISHED' | 'ALREADY_PUBLISHED'; ref: string; candidate_sha: string }
  | { state: 'CONFLICT'; ref: string; observed_sha: string };

export interface SourceVerification {
  schema: typeof SOURCE_VERIFICATION_SCHEMA;
  state: 'verified' | 'rejected';
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string | null;
  reason: string | null;
}

export interface SourceIntegrationEffectIdentity {
  schema: typeof SOURCE_INTEGRATION_EFFECT_IDENTITY_SCHEMA;
  run_id: string;
  obligation_key: string;
  source_sha: string;
  candidate_sha: string;
  verification_base_sha: string;
  verified_tree_sha: string;
  integration_commit: string;
  ref: string;
}

export type PreparedSourceIntegration =
  | {
      state: 'READY';
      effect_identity: SourceIntegrationEffectIdentity;
      integration_commit: string;
      expected_head: string;
      already_integrated: boolean;
    }
  | { state: 'REREALIZE_REQUIRED'; reason: string }
  | { state: 'REJECTED'; reason: string }
  | { state: 'RECOVERY_REQUIRED'; reason: string };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitStatus(repo: string, args: string[]): number {
  return spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status ?? 1;
}

function remoteRefHead(repo: string, remote: string, ref: string): string | null {
  const listed = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!listed) return null;
  const sha = listed.split(/\s+/)[0] ?? '';
  exactSha(sha, 'SOURCE_AUTHORITY_HEAD_INVALID');
  execFileSync(
    'git',
    ['-C', repo, 'fetch', '--no-tags', remote, `+${ref}:refs/overcenter/source-main-observed`],
    { stdio: 'ignore' },
  );
  return sha;
}

function remoteRefCas(
  repo: string,
  remote: string,
  ref: string,
  next: string,
  expected: string,
): boolean {
  return (
    gitStatus(repo, [
      'push',
      '--porcelain',
      `--force-with-lease=${ref}:${expected}`,
      remote,
      `${next}:${ref}`,
    ]) === 0
  );
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

function sourceControlPath(path: string): boolean {
  return (
    path === '.overcenter' ||
    path.startsWith('.overcenter/') ||
    path === '.github' ||
    path.startsWith('.github/')
  );
}

export function validateSourceVerification(value: unknown): SourceVerification {
  if (!isData(value)) throw new Error('SOURCE_VERIFICATION_INVALID');
  assertExactKeys(
    value,
    ['schema', 'state', 'run_id', 'candidate_sha', 'base_sha', 'tree_sha', 'reason'],
    [],
    'SOURCE_VERIFICATION_INVALID',
  );
  if (value.schema !== SOURCE_VERIFICATION_SCHEMA) {
    throw new Error('SOURCE_VERIFICATION_SCHEMA_MISMATCH');
  }
  if (value.state !== 'verified' && value.state !== 'rejected') {
    throw new Error('SOURCE_VERIFICATION_STATE_INVALID');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_VERIFICATION_RUN_ID_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_VERIFICATION_CANDIDATE_SHA_INVALID');
  exactSha(value.base_sha, 'SOURCE_VERIFICATION_BASE_SHA_INVALID');
  if (value.state === 'verified') {
    exactSha(value.tree_sha, 'SOURCE_VERIFICATION_TREE_SHA_INVALID');
    if (value.reason !== null) throw new Error('SOURCE_VERIFICATION_REASON_INVALID');
  } else {
    if (value.tree_sha !== null) throw new Error('SOURCE_VERIFICATION_TREE_INVALID');
    assertNonEmptyString(value.reason, 'SOURCE_VERIFICATION_REASON_INVALID');
  }
  return {
    schema: SOURCE_VERIFICATION_SCHEMA,
    state: value.state,
    run_id: value.run_id,
    candidate_sha: value.candidate_sha,
    base_sha: value.base_sha,
    tree_sha: value.tree_sha,
    reason: value.reason,
  };
}

export function validateSourceIntegrationEffectIdentity(
  value: unknown,
): SourceIntegrationEffectIdentity {
  if (!isData(value)) throw new Error('SOURCE_INTEGRATION_EFFECT_IDENTITY_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'run_id',
      'obligation_key',
      'source_sha',
      'candidate_sha',
      'verification_base_sha',
      'verified_tree_sha',
      'integration_commit',
      'ref',
    ],
    [],
    'SOURCE_INTEGRATION_EFFECT_IDENTITY_INVALID',
  );
  if (value.schema !== SOURCE_INTEGRATION_EFFECT_IDENTITY_SCHEMA) {
    throw new Error('SOURCE_INTEGRATION_EFFECT_IDENTITY_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_INTEGRATION_EFFECT_RUN_INVALID');
  assertNonEmptyString(value.obligation_key, 'SOURCE_INTEGRATION_EFFECT_KEY_INVALID');
  exactSha(value.source_sha, 'SOURCE_INTEGRATION_EFFECT_SOURCE_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_INTEGRATION_EFFECT_CANDIDATE_INVALID');
  exactSha(value.verification_base_sha, 'SOURCE_INTEGRATION_EFFECT_BASE_INVALID');
  exactSha(value.verified_tree_sha, 'SOURCE_INTEGRATION_EFFECT_TREE_INVALID');
  exactSha(value.integration_commit, 'SOURCE_INTEGRATION_EFFECT_COMMIT_INVALID');
  assertNonEmptyString(value.ref, 'SOURCE_INTEGRATION_EFFECT_REF_INVALID');
  return structuredClone(value) as unknown as SourceIntegrationEffectIdentity;
}

export function inspectSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
  expectedObligationId?: string,
): { task: SourceTaskPacket; candidate: SourceCandidate; changed_paths: string[] } {
  const task = validateSourceTaskPacket(taskValue);
  exactSha(candidateSha, 'SOURCE_CANDIDATE_COMMIT_SHA_INVALID');

  const parents = git(repo, ['rev-list', '--parents', '-n', '1', candidateSha])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2 || parents[1] !== claim.source_sha) {
    throw new Error('SOURCE_CANDIDATE_PARENT_MISMATCH');
  }

  if (expectedObligationId !== undefined) {
    assertNonEmptyString(expectedObligationId, 'SOURCE_CANDIDATE_OBLIGATION_INVALID');
    const body = git(repo, ['show', '-s', '--format=%B', candidateSha]);
    if (!body.split('\n').includes(`Overcenter-Obligation-Id: ${expectedObligationId}`)) {
      throw new Error('SOURCE_CANDIDATE_OBLIGATION_MISMATCH');
    }
  }

  const candidate = validateSourceCandidate(
    {
      schema: SOURCE_CANDIDATE_SCHEMA,
      obligation_key: claim.obligation_key,
      run_id: claim.run_id,
      claimed_revision: claim.claimed_revision,
      claimed_source_sha: claim.source_sha,
      commit_sha: candidateSha,
    },
    claim,
  );

  const delta = observeRepositoryDelta(repo, claim.source_sha, candidateSha);
  assertSupportedSourceDelta(delta);
  const changedPaths = delta.entries.map((entry) => entry.path);
  if (changedPaths.length === 0) throw new Error('SOURCE_CANDIDATE_EMPTY');
  if (changedPaths.some(sourceControlPath)) {
    throw new Error('SOURCE_CONTROL_PLANE_MUTATION_FORBIDDEN');
  }
  if (changedPaths.some((path) => !task.writable_paths.includes(path))) {
    throw new Error('SOURCE_SCOPE_VIOLATION');
  }

  return { task, candidate, changed_paths: changedPaths };
}

function worktree(repo: string, revision: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-integrate-'));
  try {
    git(repo, ['worktree', 'add', '--detach', root, revision]);
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    dispose: () => {
      gitStatus(repo, ['worktree', 'remove', '--force', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function integrationMessage(
  claim: SourceClaimBinding,
  candidateSha: string,
  treeSha: string,
): string {
  return [
    `integrate source work ${claim.run_id}`,
    '',
    `Overcenter-Obligation-Key: ${claim.obligation_key}`,
    `Overcenter-Source-Candidate: ${candidateSha}`,
    `Overcenter-Verified-Tree: ${treeSha}`,
  ].join('\n');
}

function validExistingIntegration(
  repo: string,
  head: string,
  identity: Pick<
    SourceIntegrationEffectIdentity,
    'obligation_key' | 'candidate_sha' | 'verification_base_sha' | 'verified_tree_sha'
  >,
  exactCommit?: string,
): string | null {
  const commits = git(repo, ['rev-list', head]).split('\n').filter(Boolean);
  const candidates = exactCommit === undefined ? commits : commits.includes(exactCommit) ? [exactCommit] : [];
  for (const commit of candidates) {
    const body = git(repo, ['show', '-s', '--format=%B', commit]);
    if (!body.includes(`Overcenter-Obligation-Key: ${identity.obligation_key}`)) continue;
    if (!body.includes(`Overcenter-Source-Candidate: ${identity.candidate_sha}`)) continue;
    if (!body.includes(`Overcenter-Verified-Tree: ${identity.verified_tree_sha}`)) continue;

    const parents = git(repo, ['show', '-s', '--format=%P', commit]).split(/\s+/).filter(Boolean);
    if (parents.length !== 1 || parents[0] !== identity.verification_base_sha) continue;
    const tree = git(repo, ['show', '-s', '--format=%T', commit]);
    if (tree !== identity.verified_tree_sha) continue;
    return commit;
  }
  return null;
}

export function prepareVerifiedSourceIntegration(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  obligationId: string,
  candidateSha: string,
  verificationValue: unknown,
  {
    remote = 'origin',
    ref = 'refs/heads/main',
  }: {
    remote?: string;
    ref?: string;
  } = {},
): PreparedSourceIntegration {
  try {
    inspectSourceCandidate(repo, taskValue, claim, candidateSha, obligationId);
  } catch (error: unknown) {
    return {
      state: 'REJECTED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let verification: SourceVerification;
  try {
    verification = validateSourceVerification(verificationValue);
  } catch (error: unknown) {
    return {
      state: 'REJECTED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (verification.run_id !== claim.run_id) {
    return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_RUN_MISMATCH' };
  }
  if (verification.candidate_sha !== candidateSha) {
    return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_CANDIDATE_MISMATCH' };
  }
  if (verification.state !== 'verified' || !verification.tree_sha) {
    return {
      state: 'REREALIZE_REQUIRED',
      reason: verification.reason ?? 'SOURCE_VERIFICATION_REJECTED',
    };
  }

  const identityBase = {
    schema: SOURCE_INTEGRATION_EFFECT_IDENTITY_SCHEMA,
    run_id: claim.run_id,
    obligation_key: claim.obligation_key,
    source_sha: claim.source_sha,
    candidate_sha: candidateSha,
    verification_base_sha: verification.base_sha,
    verified_tree_sha: verification.tree_sha,
    ref,
  } as const;

  let current: string;
  try {
    current = remoteRefHead(repo, remote, ref) ?? '';
  } catch {
    return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_AUTHORITY_UNREACHABLE' };
  }
  if (!current) return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_AUTHORITY_MISSING' };

  const replay = validExistingIntegration(repo, current, identityBase);
  if (replay) {
    return {
      state: 'READY',
      effect_identity: validateSourceIntegrationEffectIdentity({
        ...identityBase,
        integration_commit: replay,
      }),
      integration_commit: replay,
      expected_head: current,
      already_integrated: true,
    };
  }

  if (current !== verification.base_sha) {
    return { state: 'REREALIZE_REQUIRED', reason: 'SOURCE_MAIN_MOVED_AFTER_VERIFICATION' };
  }

  const candidateTree = worktree(repo, current);
  let integrated = '';
  try {
    if (gitStatus(candidateTree.root, ['cherry-pick', '--no-commit', candidateSha]) !== 0) {
      return { state: 'REREALIZE_REQUIRED', reason: 'SOURCE_APPLY_CONFLICT' };
    }
    const task = validateSourceTaskPacket(taskValue);
    if (task.acceptance?.verifier === 'tcb-finding-absent/v1') {
      const verifier = resolve(repo, 'scripts/verify-tcb-remediation.ts');
      const verified = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          verifier,
          '--root',
          candidateTree.root,
          '--finding',
          task.acceptance.finding_id,
          '--baseline',
          claim.source_sha,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (verified.status !== 0) {
        return {
          state: 'REJECTED',
          reason: `SOURCE_TCB_ACCEPTANCE_FAILED:${(verified.stderr || verified.stdout || '').trim()}`,
        };
      }
    }
    const tree = git(candidateTree.root, ['write-tree']);
    if (tree !== verification.tree_sha) {
      return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_TREE_MISMATCH' };
    }

    git(candidateTree.root, [
      '-c',
      'user.name=Overcenter Source Integrator',
      '-c',
      'user.email=overcenter@local',
      'commit',
      '-m',
      integrationMessage(claim, candidateSha, verification.tree_sha),
    ]);
    integrated = git(candidateTree.root, ['rev-parse', 'HEAD']);
  } finally {
    candidateTree.dispose();
  }

  return {
    state: 'READY',
    effect_identity: validateSourceIntegrationEffectIdentity({
      ...identityBase,
      integration_commit: integrated,
    }),
    integration_commit: integrated,
    expected_head: current,
    already_integrated: false,
  };
}

export function performPreparedSourceIntegration(
  repo: string,
  prepared: Extract<PreparedSourceIntegration, { state: 'READY' }>,
  { remote = 'origin' }: { remote?: string } = {},
): boolean {
  if (prepared.already_integrated) return false;
  return remoteRefCas(
    repo,
    remote,
    prepared.effect_identity.ref,
    prepared.integration_commit,
    prepared.expected_head,
  );
}

function sourceObservationCommon(identity: SourceIntegrationEffectIdentity) {
  return {
    verifier: 'source-integration/v1' as const,
    provider: 'github' as const,
    ref: identity.ref,
    source_sha: identity.source_sha,
    candidate_sha: identity.candidate_sha,
    verified_tree_sha: identity.verified_tree_sha,
    effect_identity_sha256: canonicalDigest(identity),
  };
}

export function observeSourceIntegration(
  repo: string,
  identityValue: unknown,
  { remote = 'origin' }: { remote?: string } = {},
): Observation {
  const identity = validateSourceIntegrationEffectIdentity(identityValue);
  const common = sourceObservationCommon(identity);
  let current: string;
  try {
    current = remoteRefHead(repo, remote, identity.ref) ?? '';
  } catch (error: unknown) {
    return {
      ...common,
      mutation_certainty: 'uncertain',
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!current) {
    return {
      ...common,
      mutation_certainty: 'uncertain',
      observation_error: 'SOURCE_AUTHORITY_MISSING',
    };
  }

  const integration = validExistingIntegration(
    repo,
    current,
    identity,
    identity.integration_commit,
  );
  if (!integration) {
    return {
      ...common,
      actual_head_sha: current,
      mutation_certainty: 'absent',
    };
  }
  return {
    ...common,
    actual_head_sha: current,
    integration_commit: integration,
    mutation_certainty: 'present',
  };
}
