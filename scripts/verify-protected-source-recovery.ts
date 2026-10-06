import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../src/validation.ts';

const AUTHORIZATION_SCHEMA = 'overcenter-protected-source-recovery-authorization/v1' as const;
const STRUCTURAL_RECEIPT_SCHEMA =
  'overcenter-protected-source-recovery-structural-receipt/v1' as const;

interface RecoveryAuthorization {
  schema: typeof AUTHORIZATION_SCHEMA;
  repository_full_name: string;
  base_sha: string;
  candidate_sha: string;
  candidate_tree_sha: string;
  writable_paths: string[];
  reason: string;
  authorized_by: string;
}

const recoveryRootPaths = [
  '.github',
  '.overcenter',
  '.node-version',
  '.go-version',
  'biome.json',
  'package.json',
  'tsconfig.json',
  'tcb-policy.json',
  'scripts/lint.sh',
  'scripts/run-unit-tests.ts',
  'scripts/report-tcb.ts',
  'scripts/verify-source-profile.ts',
  'scripts/verify-protected-source-recovery.ts',
  'src/analysis',
  'src/architecture',
  'src/source/source-verification-profile.ts',
] as const;

function fail(code: string): never {
  throw new Error(code);
}

function sha40(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
}

function readAuthorization(path: string): RecoveryAuthorization {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('PROTECTED_SOURCE_RECOVERY_AUTHORIZATION_INVALID');
  }
  if (!isData(value)) fail('PROTECTED_SOURCE_RECOVERY_AUTHORIZATION_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'repository_full_name',
      'base_sha',
      'candidate_sha',
      'candidate_tree_sha',
      'writable_paths',
      'reason',
      'authorized_by',
    ],
    [],
    'PROTECTED_SOURCE_RECOVERY_AUTHORIZATION_INVALID',
  );
  if (value.schema !== AUTHORIZATION_SCHEMA) fail('PROTECTED_SOURCE_RECOVERY_SCHEMA_MISMATCH');
  assertNonEmptyString(value.repository_full_name, 'PROTECTED_SOURCE_RECOVERY_REPOSITORY_INVALID');
  assertNonEmptyString(value.reason, 'PROTECTED_SOURCE_RECOVERY_REASON_REQUIRED');
  assertNonEmptyString(value.authorized_by, 'PROTECTED_SOURCE_RECOVERY_AUTHORIZER_REQUIRED');
  if (!sha40(value.base_sha) || !sha40(value.candidate_sha) || !sha40(value.candidate_tree_sha)) {
    fail('PROTECTED_SOURCE_RECOVERY_REVISION_INVALID');
  }
  if (
    !Array.isArray(value.writable_paths) ||
    value.writable_paths.length === 0 ||
    value.writable_paths.some((path) => !repositoryPath(path))
  ) {
    fail('PROTECTED_SOURCE_RECOVERY_WRITE_SET_INVALID');
  }
  const writablePaths = value.writable_paths as string[];
  const canonicalPaths = [...new Set(writablePaths)].sort();
  if (
    canonicalPaths.length !== writablePaths.length ||
    canonicalPaths.some((path, index) => path !== writablePaths[index])
  ) {
    fail('PROTECTED_SOURCE_RECOVERY_WRITE_SET_NONCANONICAL');
  }
  return {
    schema: AUTHORIZATION_SCHEMA,
    repository_full_name: value.repository_full_name,
    base_sha: value.base_sha,
    candidate_sha: value.candidate_sha,
    candidate_tree_sha: value.candidate_tree_sha,
    writable_paths: canonicalPaths,
    reason: value.reason,
    authorized_by: value.authorized_by,
  };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function changedPaths(repo: string, base: string, candidate: string): string[] {
  return execFileSync(
    'git',
    ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', base, candidate, '--'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function main(): void {
  const authorizationPath = process.argv[2];
  const candidateRepoArgument = process.argv[3];
  if (!authorizationPath || !candidateRepoArgument) {
    fail('PROTECTED_SOURCE_RECOVERY_ARGUMENTS_REQUIRED');
  }

  const authorization = readAuthorization(authorizationPath);
  const candidateRepo = resolve(candidateRepoArgument);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? '';
  const actor = process.env.GITHUB_ACTOR ?? '';
  const acceptedBase = process.env.ACCEPTED_BASE_SHA ?? '';

  if (authorization.repository_full_name !== repository) {
    fail('PROTECTED_SOURCE_RECOVERY_REPOSITORY_MISMATCH');
  }
  if (!owner || actor !== owner || authorization.authorized_by !== actor) {
    fail('PROTECTED_SOURCE_RECOVERY_OWNER_AUTHORIZATION_REQUIRED');
  }
  if (!sha40(acceptedBase) || authorization.base_sha !== acceptedBase) {
    fail('PROTECTED_SOURCE_RECOVERY_ACCEPTED_BASE_MISMATCH');
  }
  if (git(candidateRepo, 'rev-parse', 'HEAD') !== authorization.candidate_sha) {
    fail('PROTECTED_SOURCE_RECOVERY_CANDIDATE_MISMATCH');
  }

  const ancestry = git(
    candidateRepo,
    'rev-list',
    '--parents',
    '-n',
    '1',
    authorization.candidate_sha,
  ).split(/\s+/);
  if (ancestry.length !== 2 || ancestry[1] !== authorization.base_sha) {
    fail('PROTECTED_SOURCE_RECOVERY_DIRECT_CHILD_REQUIRED');
  }
  if (
    git(candidateRepo, 'rev-parse', `${authorization.candidate_sha}^{tree}`) !==
    authorization.candidate_tree_sha
  ) {
    fail('PROTECTED_SOURCE_RECOVERY_TREE_MISMATCH');
  }

  const observedPaths = changedPaths(
    candidateRepo,
    authorization.base_sha,
    authorization.candidate_sha,
  );
  if (
    observedPaths.length !== authorization.writable_paths.length ||
    observedPaths.some((path, index) => path !== authorization.writable_paths[index])
  ) {
    fail('PROTECTED_SOURCE_RECOVERY_WRITE_SET_MISMATCH');
  }

  const protectedPaths = readSourceVerificationProfile(candidateRepo, authorization.base_sha)
    .profile.protected_paths;
  for (const path of observedPaths) {
    if (!protectedPaths.some((root) => within(root, path))) {
      fail(`PROTECTED_SOURCE_RECOVERY_UNPROTECTED_PATH:${path}`);
    }
    if (recoveryRootPaths.some((root) => within(root, path))) {
      fail(`PROTECTED_SOURCE_RECOVERY_ROOT_PATH:${path}`);
    }
  }

  const authorizationSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        schema: authorization.schema,
        repository_full_name: authorization.repository_full_name,
        base_sha: authorization.base_sha,
        candidate_sha: authorization.candidate_sha,
        candidate_tree_sha: authorization.candidate_tree_sha,
        writable_paths: authorization.writable_paths,
        reason: authorization.reason,
        authorized_by: authorization.authorized_by,
      }),
    )
    .digest('hex');

  process.stdout.write(
    `${JSON.stringify({
      schema: STRUCTURAL_RECEIPT_SCHEMA,
      authorization_sha256: authorizationSha256,
      repository_full_name: authorization.repository_full_name,
      base_sha: authorization.base_sha,
      candidate_sha: authorization.candidate_sha,
      candidate_tree_sha: authorization.candidate_tree_sha,
      writable_paths: authorization.writable_paths,
      authorized_by: authorization.authorized_by,
    })}\n`,
  );
}

main();
