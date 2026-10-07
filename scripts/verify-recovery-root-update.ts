import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

const AUTHORIZATION_SCHEMA = 'overcenter-recovery-root-update-authorization/v1';
export const ROOT_UPDATE_PATHS = [
  'biome.json',
  'scripts/report-tcb.ts',
  'src/analysis/tcb-semantic-loc.ts',
] as const;
export const ROOT_EVIDENCE_PATH = 'test/tcb-semantic-loc.test.ts';
const keys = [
  'schema',
  'repository_full_name',
  'base_sha',
  'candidate_sha',
  'candidate_tree_sha',
  'writable_paths',
  'reason',
  'authorized_by',
  'evidence_sha',
  'evidence_path',
  'evidence_blob_sha',
];

export interface RootAuthorization {
  schema: typeof AUTHORIZATION_SCHEMA;
  repository_full_name: string;
  base_sha: string;
  candidate_sha: string;
  candidate_tree_sha: string;
  writable_paths: string[];
  reason: string;
  authorized_by: string;
  evidence_sha: string;
  evidence_path: string;
  evidence_blob_sha: string;
}

export function rootGit(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function rootDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function guardOrdinaryRootAuthority(repo: string, base: string, candidate: string): void {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(candidate))
    throw new Error('RECOVERY_ROOT_UPDATE_REVISION_INVALID');
  const changed = rootGit(
    repo,
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    base,
    candidate,
    '--',
  ).split('\0');
  if (
    changed.some(
      (path) =>
        path === 'scripts/verify-recovery-root-update.ts' ||
        path === 'scripts/check-recovery-root-update.ts',
    )
  ) {
    throw new Error('RECOVERY_ROOT_UPDATE_ORDINARY_ROOT_AUTHORITY');
  }
}

function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`RECOVERY_ROOT_UPDATE_${code}`);
}

export function readRootAuthorization(value: unknown): RootAuthorization {
  requireCheck(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'AUTHORIZATION_INVALID',
  );
  const data = value as Record<string, unknown>;
  requireCheck(
    JSON.stringify(Object.keys(data).sort()) === JSON.stringify([...keys].sort()),
    'AUTHORIZATION_KEYS_INVALID',
  );
  requireCheck(data.schema === AUTHORIZATION_SCHEMA, 'SCHEMA_MISMATCH');
  for (const key of [
    'base_sha',
    'candidate_sha',
    'candidate_tree_sha',
    'evidence_sha',
    'evidence_blob_sha',
  ]) {
    requireCheck(
      typeof data[key] === 'string' && /^[0-9a-f]{40}$/.test(data[key]),
      'REVISION_INVALID',
    );
  }
  for (const key of ['repository_full_name', 'authorized_by', 'reason']) {
    requireCheck(typeof data[key] === 'string' && data[key].trim().length > 0, 'STRING_INVALID');
  }
  requireCheck(data.evidence_path === ROOT_EVIDENCE_PATH, 'EVIDENCE_PATH_INVALID');
  const paths = data.writable_paths;
  requireCheck(
    Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every(
        (p) => typeof p === 'string' && ROOT_UPDATE_PATHS.some((allowed) => p === allowed),
      ),
    'CAPABILITY_EXCEEDED',
  );
  requireCheck(
    JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort()),
    'WRITE_SET_NONCANONICAL',
  );
  return data as unknown as RootAuthorization;
}

export function verifyRootUpdate(
  value: unknown,
  candidateRepo: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const authorization = readRootAuthorization(value);
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_OWNER: owner,
    GITHUB_ACTOR: actor,
  } = env;
  requireCheck(
    repository === authorization.repository_full_name && repository?.split('/')[0] === owner,
    'REPOSITORY_MISMATCH',
  );
  requireCheck(
    owner && actor === owner && actor === authorization.authorized_by,
    'OWNER_AUTHORIZATION_REQUIRED',
  );
  requireCheck(env.GITHUB_REF === 'refs/heads/main', 'MAIN_REF_REQUIRED');
  requireCheck(env.GITHUB_SHA === authorization.base_sha, 'ACCEPTED_BASE_MISMATCH');
  requireCheck(
    rootGit(candidateRepo, 'rev-parse', 'HEAD') === authorization.candidate_sha,
    'CANDIDATE_MISMATCH',
  );
  const parents = rootGit(
    candidateRepo,
    'rev-list',
    '--parents',
    '-n',
    '1',
    authorization.candidate_sha,
  ).split(/\s+/);
  requireCheck(
    parents.length === 2 && parents[1] === authorization.base_sha,
    'DIRECT_CHILD_REQUIRED',
  );
  requireCheck(
    rootGit(candidateRepo, 'rev-parse', 'HEAD^{tree}') === authorization.candidate_tree_sha,
    'TREE_MISMATCH',
  );
  const changed = rootGit(
    candidateRepo,
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    authorization.base_sha,
    authorization.candidate_sha,
    '--',
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  requireCheck(
    JSON.stringify(changed) === JSON.stringify(authorization.writable_paths),
    'WRITE_SET_MISMATCH',
  );
  const profile = readSourceVerificationProfile(candidateRepo, authorization.base_sha);
  for (const path of changed) {
    requireCheck(
      profile.profile.protected_paths.some((root) => path === root || path.startsWith(`${root}/`)),
      'UNPROTECTED_PATH',
    );
    requireCheck(
      rootGit(candidateRepo, 'ls-tree', authorization.candidate_sha, '--', path).startsWith(
        '100644 blob ',
      ),
      'REGULAR_SOURCE_REQUIRED',
    );
  }
  requireCheck(
    rootGit(candidateRepo, 'cat-file', '-t', authorization.evidence_sha) === 'commit',
    'EVIDENCE_COMMIT_REQUIRED',
  );
  requireCheck(
    rootGit(candidateRepo, 'ls-tree', authorization.evidence_sha, '--', ROOT_EVIDENCE_PATH) ===
      `100644 blob ${authorization.evidence_blob_sha}\t${ROOT_EVIDENCE_PATH}`,
    'EVIDENCE_BLOB_MISMATCH',
  );
  const evidence = execFileSync('git', [
    '-C',
    candidateRepo,
    'cat-file',
    'blob',
    authorization.evidence_blob_sha,
  ]);
  // Canonical field order makes authorization digests independent of JSON key ordering.
  const canonical = Object.fromEntries(
    keys.map((key) => [key, authorization[key as keyof RootAuthorization]]),
  );
  return {
    ...authorization,
    schema: 'overcenter-recovery-root-update-structural-receipt/v1' as const,
    authorization_sha256: rootDigest(JSON.stringify(canonical)),
    evidence_sha256: rootDigest(evidence),
    accepted_profile_sha256: profile.sha256,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--guard-ordinary') {
    const [repo, base, candidate] = process.argv.slice(3);
    requireCheck(repo && base && candidate, 'ARGUMENTS_REQUIRED');
    guardOrdinaryRootAuthority(resolve(repo), base, candidate);
    process.exit(0);
  }
  const [authorizationPath, candidateRepo] = process.argv.slice(2);
  requireCheck(authorizationPath && candidateRepo, 'ARGUMENTS_REQUIRED');
  const receipt = verifyRootUpdate(
    JSON.parse(readFileSync(authorizationPath, 'utf8')),
    resolve(candidateRepo),
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
