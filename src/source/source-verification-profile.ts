import { execFileSync } from 'node:child_process';
import { canonicalDigest, canonicalJson } from '../digest.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const SOURCE_VERIFICATION_PROFILE_PATH =
  '.overcenter/source-verification-profile.json' as const;
export const SOURCE_VERIFICATION_PROFILE_SCHEMA =
  'overcenter-source-verification-profile/v1' as const;

export type SourceVerificationCommand =
  | { kind: 'package-script'; script: string }
  | { kind: 'process-argv'; argv: string[] };

const COMMAND_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function parseSourceVerificationCommand(value: unknown): SourceVerificationCommand {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('SOURCE_VERIFICATION_PROFILE_COMMANDS_INVALID');
  }
  const packageScript = /^npm run ([A-Za-z0-9:_-]+)$/.exec(value);
  if (packageScript) return { kind: 'package-script', script: packageScript[1]! };

  const argv = value.split(' ');
  if (
    argv.length === 0 ||
    argv.some((token) => !token || !COMMAND_TOKEN.test(token)) ||
    argv[0] === 'npm'
  ) {
    throw new Error('SOURCE_VERIFICATION_PROFILE_COMMANDS_INVALID');
  }
  return { kind: 'process-argv', argv };
}

export function sourceVerificationRecipeStep(command: string): string {
  const parsed = parseSourceVerificationCommand(command);
  return parsed.kind === 'package-script'
    ? parsed.script
    : `argv:${canonicalJson(parsed.argv)}`;
}

export interface SourceVerificationProfile {
  schema: typeof SOURCE_VERIFICATION_PROFILE_SCHEMA;
  id: string;
  workflow_path: string;
  required_evidence_jobs: string[];
  record_job: string;
  commands: string[];
  protected_paths: string[];
  baseline_test_roots: string[];
}

export interface SourceVerificationProfileBinding {
  id: string;
  sha256: string;
}

export interface LoadedSourceVerificationProfile {
  profile: SourceVerificationProfile;
  sha256: string;
}

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
}

function stringList(value: unknown, error: string, paths = false): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string'))
    throw new Error(error);
  const values = value as string[];
  if (
    values.some(
      (item) =>
        item.length === 0 ||
        [...item].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        (paths && !repositoryPath(item)),
    )
  )
    throw new Error(error);
  if (new Set(values).size !== values.length) throw new Error(error);
  return [...values];
}

export function validateSourceVerificationProfile(value: unknown): SourceVerificationProfile {
  if (!isData(value)) throw new Error('SOURCE_VERIFICATION_PROFILE_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'id',
      'workflow_path',
      'required_evidence_jobs',
      'record_job',
      'commands',
      'protected_paths',
      'baseline_test_roots',
    ],
    [],
    'SOURCE_VERIFICATION_PROFILE_INVALID',
  );
  if (value.schema !== SOURCE_VERIFICATION_PROFILE_SCHEMA)
    throw new Error('SOURCE_VERIFICATION_PROFILE_SCHEMA_MISMATCH');
  assertNonEmptyString(value.id, 'SOURCE_VERIFICATION_PROFILE_ID_INVALID');
  assertNonEmptyString(value.workflow_path, 'SOURCE_VERIFICATION_PROFILE_WORKFLOW_INVALID');
  if (!repositoryPath(value.workflow_path) || !value.workflow_path.startsWith('.github/workflows/'))
    throw new Error('SOURCE_VERIFICATION_PROFILE_WORKFLOW_INVALID');
  assertNonEmptyString(value.record_job, 'SOURCE_VERIFICATION_PROFILE_JOB_INVALID');
  const requiredJobs = stringList(
    value.required_evidence_jobs,
    'SOURCE_VERIFICATION_PROFILE_JOBS_INVALID',
  ).sort();
  const commands = stringList(value.commands, 'SOURCE_VERIFICATION_PROFILE_COMMANDS_INVALID');
  for (const command of commands) parseSourceVerificationCommand(command);
  const protectedPaths = stringList(
    value.protected_paths,
    'SOURCE_VERIFICATION_PROFILE_PROTECTED_PATHS_INVALID',
    true,
  ).sort();
  const baselineTestRoots = stringList(
    value.baseline_test_roots,
    'SOURCE_VERIFICATION_PROFILE_TEST_ROOTS_INVALID',
    true,
  ).sort();
  if (!protectedPaths.includes('.overcenter') || !protectedPaths.includes('.github'))
    throw new Error('SOURCE_VERIFICATION_PROFILE_PROTECTED_PATHS_INVALID');
  return {
    schema: SOURCE_VERIFICATION_PROFILE_SCHEMA,
    id: value.id,
    workflow_path: value.workflow_path,
    required_evidence_jobs: requiredJobs,
    record_job: value.record_job,
    commands,
    protected_paths: protectedPaths,
    baseline_test_roots: baselineTestRoots,
  };
}

export function sourceVerificationProfileBinding(
  profileValue: unknown,
): SourceVerificationProfileBinding {
  const profile = validateSourceVerificationProfile(profileValue);
  return {
    id: profile.id,
    sha256: canonicalDigest({ domain: 'overcenter-source-verification-profile/v1', profile }),
  };
}

export function readSourceVerificationProfile(
  repo: string,
  revision: string,
): LoadedSourceVerificationProfile {
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error('SOURCE_VERIFICATION_PROFILE_REVISION_INVALID');
  try {
    if (
      execFileSync('git', ['-C', repo, 'cat-file', '-t', revision], { encoding: 'utf8' }).trim() !==
      'commit'
    )
      throw new Error('SOURCE_VERIFICATION_PROFILE_REVISION_INVALID');
  } catch {
    throw new Error('SOURCE_VERIFICATION_PROFILE_REVISION_INVALID');
  }
  let raw: Buffer;
  try {
    raw = execFileSync(
      'git',
      ['-C', repo, 'show', `${revision}:${SOURCE_VERIFICATION_PROFILE_PATH}`],
      {
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error('SOURCE_VERIFICATION_PROFILE_MISSING');
  }
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw))
    throw new Error('SOURCE_VERIFICATION_PROFILE_ENCODING_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('SOURCE_VERIFICATION_PROFILE_JSON_INVALID');
  }
  const profile = validateSourceVerificationProfile(parsed);
  return { profile, sha256: sourceVerificationProfileBinding(profile).sha256 };
}
