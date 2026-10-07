import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface VerificationIdentity {
  event: string;
  candidateSha: string;
  candidateTree: string;
  baseSha: string;
  testedSha: string;
  testedTree: string;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`VERIFICATION_IDENTITY_ENV_REQUIRED:${name}`);
  return value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function pullRequestIdentity(eventPath: string): { headSha: string; baseSha: string } {
  const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (typeof event !== 'object' || event === null || !('pull_request' in event)) {
    throw new Error('VERIFICATION_IDENTITY_PULL_REQUEST_MISSING');
  }
  const pullRequest = (event as { pull_request?: unknown }).pull_request;
  if (typeof pullRequest !== 'object' || pullRequest === null) {
    throw new Error('VERIFICATION_IDENTITY_PULL_REQUEST_INVALID');
  }
  const head = (pullRequest as { head?: unknown }).head;
  const base = (pullRequest as { base?: unknown }).base;
  if (typeof head !== 'object' || head === null || typeof base !== 'object' || base === null) {
    throw new Error('VERIFICATION_IDENTITY_PULL_REQUEST_REFS_INVALID');
  }
  const headSha = (head as { sha?: unknown }).sha;
  const baseSha = (base as { sha?: unknown }).sha;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('VERIFICATION_IDENTITY_HEAD_SHA_INVALID');
  }
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error('VERIFICATION_IDENTITY_BASE_SHA_INVALID');
  }
  return { headSha, baseSha };
}

export function deriveVerificationIdentity(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): VerificationIdentity {
  const event = requiredEnv(env, 'GITHUB_EVENT_NAME');
  const eventSha = requiredEnv(env, 'GITHUB_SHA');
  const testedSha = git(cwd, 'rev-parse', 'HEAD');
  const testedTree = git(cwd, 'rev-parse', 'HEAD^{tree}');

  if (testedSha !== eventSha) {
    throw new Error(`VERIFICATION_IDENTITY_EVENT_SHA_MISMATCH:${testedSha}:${eventSha}`);
  }

  if (event !== 'pull_request') {
    return {
      event,
      candidateSha: eventSha,
      candidateTree: testedTree,
      baseSha: '',
      testedSha,
      testedTree,
    };
  }

  const { headSha, baseSha } = pullRequestIdentity(requiredEnv(env, 'GITHUB_EVENT_PATH'));
  const parents = git(cwd, 'show', '--no-patch', '--format=%P', 'HEAD')
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2) {
    throw new Error(`VERIFICATION_IDENTITY_MERGE_PARENT_COUNT:${parents.length}`);
  }
  if (parents[0] !== baseSha) {
    throw new Error(`VERIFICATION_IDENTITY_BASE_MISMATCH:${parents[0]}:${baseSha}`);
  }
  if (parents[1] !== headSha) {
    throw new Error(`VERIFICATION_IDENTITY_HEAD_MISMATCH:${parents[1]}:${headSha}`);
  }

  return {
    event,
    candidateSha: headSha,
    candidateTree: git(cwd, 'rev-parse', `${headSha}^{tree}`),
    baseSha,
    testedSha,
    testedTree,
  };
}

function keyValues(identity: VerificationIdentity): Array<[string, string]> {
  return [
    ['verification_event', identity.event],
    ['candidate_sha', identity.candidateSha],
    ['candidate_tree', identity.candidateTree],
    ['base_sha', identity.baseSha],
    ['tested_sha', identity.testedSha],
    ['tested_tree', identity.testedTree],
  ];
}

function appendOutputs(path: string | undefined, identity: VerificationIdentity): void {
  if (!path) return;
  appendFileSync(
    path,
    `${keyValues(identity)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    'utf8',
  );
}

function appendSummary(path: string | undefined, identity: VerificationIdentity): void {
  if (!path) return;
  const lines = [
    '### Verification identity',
    '',
    `- event: \`${identity.event}\``,
    `- candidate SHA: \`${identity.candidateSha}\``,
    `- candidate tree: \`${identity.candidateTree}\``,
  ];
  if (identity.baseSha) lines.push(`- base SHA: \`${identity.baseSha}\``);
  lines.push(
    `- tested SHA: \`${identity.testedSha}\``,
    `- tested tree: \`${identity.testedTree}\``,
    '',
  );
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function main(): void {
  const identity = deriveVerificationIdentity();
  for (const [key, value] of keyValues(identity)) console.log(`${key}=${value}`);
  appendOutputs(process.env.GITHUB_OUTPUT, identity);
  appendSummary(process.env.GITHUB_STEP_SUMMARY, identity);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) main();
