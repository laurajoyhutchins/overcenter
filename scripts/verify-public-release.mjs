import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detectSecretPatterns } from './public-release-rules.mjs';

export { detectSecretPatterns } from './public-release-rules.mjs';

const REQUIRED_FILES = Object.freeze(['README.md', 'LICENSE', 'SECURITY.md']);
const DEVELOPMENT_JOURNAL_PREFIXES = Object.freeze(['docs/superpowers/', 'public/docs/superpowers/']);

const CURRENT_SOURCE_RULES = Object.freeze([
  ['hatchable_project_id', /\bproj_[A-Za-z0-9]{12}\b/],
  ['obsolete_product_coordinate', /\bportfolio-control-plane-github-app\b/],
]);

const HISTORY_SECRET_ALLOWLIST = Object.freeze(new Set([
  '12322a0a45cc06bd043aeba63609f64dc17054a3:api/diagnostics/github-app-crypto-selftest.js:private_key',
  '3a54eb7172a5a8fbcd0530ae38cebf793caf3810:api/diagnostics/github-app-crypto-selftest.js:private_key',
]));

function isProductionRuntimeSource(path) {
  return /^(?:api|lib|mcp)\//.test(path)
    && path.endsWith('.js')
    && !path.endsWith('.test.js');
}

function materializesInstallationCredentialsInGit(text) {
  return /\bcreateEncryptedGitHubInstallationLease\s*\(/.test(text)
    && /\/git\/(?:blobs|trees|commits|ref|refs)\b/.test(text);
}

export function findCurrentSourceViolations(pathInput, textInput) {
  const path = String(pathInput || '');
  const text = String(textInput ?? '');
  return [
    ...CURRENT_SOURCE_RULES
      .filter(([, pattern]) => pattern.test(text))
      .map(([rule]) => ({ path, rule })),
    ...(isProductionRuntimeSource(path) && materializesInstallationCredentialsInGit(text)
      ? [{ path, rule: 'managed_repository_credential_transport' }]
      : []),
    ...detectSecretPatterns(text).map(({ rule }) => ({ path, rule })),
  ];
}

export function verifyTrackedPaths(pathsInput) {
  const paths = [...new Set((Array.isArray(pathsInput) ? pathsInput : []).map(String))].sort();
  const present = new Set(paths);
  const findings = [];

  for (const path of REQUIRED_FILES) {
    if (!present.has(path)) findings.push({ path, rule: 'required_file_missing' });
  }
  for (const path of paths) {
    if (DEVELOPMENT_JOURNAL_PREFIXES.some(prefix => path.startsWith(prefix))) {
      findings.push({ path, rule: 'development_journal_tracked' });
    }
  }
  return findings;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function trackedPaths() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function currentSourceFindings(paths) {
  const findings = [];
  for (const path of paths) {
    let buffer;
    try { buffer = readFileSync(path); }
    catch { findings.push({ path, rule: 'tracked_file_unreadable' }); continue; }
    if (buffer.includes(0)) continue;
    findings.push(...findCurrentSourceViolations(path, buffer.toString('utf8')));
  }
  return findings;
}

export function findHistorySecretFindings(historyInput, historyRef = '--all') {
  const findings = [];
  const seen = new Set();
  let commitSha = null;
  let path = '<commit-metadata>';

  for (const line of String(historyInput ?? '').split('\n')) {
    const commitMatch = /^commit ([0-9a-f]{40})$/.exec(line);
    if (commitMatch) {
      commitSha = commitMatch[1];
      path = '<commit-metadata>';
      continue;
    }
    const diffMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffMatch) {
      path = diffMatch[2];
      continue;
    }
    if (!commitSha) continue;

    for (const { rule } of detectSecretPatterns(line)) {
      const allowlistKey = `${commitSha}:${path}:${rule}`;
      if (HISTORY_SECRET_ALLOWLIST.has(allowlistKey)) continue;
      const findingKey = `${allowlistKey}:${historyRef}`;
      if (seen.has(findingKey)) continue;
      seen.add(findingKey);
      findings.push({ scope: 'git_history', history_ref: historyRef, commit_sha: commitSha, path, rule });
    }
  }
  return findings;
}

function historySecretFindings(historyRef) {
  const refArgs = historyRef === '--all' ? ['--all'] : [historyRef];
  const history = git([
    'log', ...refArgs, '-p', '--no-ext-diff', '--text',
    '--format=commit %H%nAuthor: %an <%ae>%nDate: %aI%n',
  ]);
  return findHistorySecretFindings(history, historyRef);
}

export function verifyPublicRelease({ historyRef = process.env.PUBLIC_RELEASE_HISTORY_REF || '--all' } = {}) {
  const paths = trackedPaths();
  const findings = [
    ...verifyTrackedPaths(paths),
    ...currentSourceFindings(paths),
    ...historySecretFindings(historyRef),
  ];
  return {
    ok: findings.length === 0,
    tracked_files: paths.length,
    history_ref: historyRef,
    findings,
  };
}

async function main() {
  let result;
  try {
    result = verifyPublicRelease();

    if (result.ok && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY) {
      const { verifyPublicGithubMetadata } = await import('./verify-public-github-metadata.mjs');
      const metadata = await verifyPublicGithubMetadata({ repository: process.env.GITHUB_REPOSITORY });
      result = {
        ...result,
        ok: metadata.ok,
        metadata: {
          repository: metadata.repository,
          records_scanned: metadata.records_scanned,
        },
        findings: [...result.findings, ...metadata.findings],
      };
    }
  } catch (error) {
    result = {
      ok: false,
      findings: [{ rule: 'verification_execution_failed', message: String(error?.message || error) }],
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) await main();
