import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSecretPatterns,
  findCurrentSourceViolations,
  findHistorySecretFindings,
  verifyTrackedPaths,
} from './verify-public-release.mjs';

test('high-confidence secret patterns are detected without flagging token plumbing', () => {
  const githubToken = ['ghp_', '1234567890abcdefghijklmnopqrstuv'].join('');
  const openAiKey = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const findings = detectSecretPatterns([
    'Authorization: Bearer ${token}',
    githubToken,
    openAiKey,
    privateKey,
  ].join('\n'));
  assert.deepEqual(findings.map(finding => finding.rule), [
    'github_token',
    'openai_key',
    'private_key',
  ]);
  assert.equal(detectSecretPatterns('Authorization: Bearer ${token}').length, 0);
});

test('current source rejects installation ids, obsolete coordinates, and credentials', () => {
  const projectId = ['proj_', 'I6FSm85xrY7T'].join('');
  const obsoleteCoordinate = ['portfolio-control-plane-', 'github-app'].join('');
  const githubToken = ['ghp_', '1234567890abcdefghijklmnopqrstuv'].join('');
  assert.deepEqual(
    findCurrentSourceViolations('lib/source-sync.js', `const project = '${projectId}';`),
    [{ path: 'lib/source-sync.js', rule: 'hatchable_project_id' }],
  );
  assert.deepEqual(
    findCurrentSourceViolations('README.md', obsoleteCoordinate),
    [{ path: 'README.md', rule: 'obsolete_product_coordinate' }],
  );
  assert.deepEqual(
    findCurrentSourceViolations('lib/config.js', `const token = '${githubToken}';`),
    [{ path: 'lib/config.js', rule: 'github_token' }],
  );
  assert.deepEqual(findCurrentSourceViolations('README.md', 'laurajoyhutchins/busbar'), []);
});

test('production source rejects repository-backed installation credential transport', () => {
  const source = [
    "const lease = await createEncryptedGitHubInstallationLease(repository, 'changeset', encrypt);",
    "await api.call('github', { path: `${repoPath}/git/blobs`, method: 'POST' });",
    "await api.call('github', { path: `${repoPath}/git/refs`, method: 'POST' });",
  ].join('\n');
  assert.deepEqual(
    findCurrentSourceViolations('lib/delegated-capability.js', source),
    [{ path: 'lib/delegated-capability.js', rule: 'managed_repository_credential_transport' }],
  );
  assert.deepEqual(findCurrentSourceViolations('lib/delegated-capability.test.js', source), []);
  assert.deepEqual(
    findCurrentSourceViolations('lib/github-app-auth.js', 'export async function createEncryptedGitHubInstallationLease() {}'),
    [],
  );
});

test('tracked-path policy requires public boundary files and excludes development journals', () => {
  const clean = verifyTrackedPaths([
    'README.md',
    'LICENSE',
    'SECURITY.md',
    'lib/source-sync.js',
  ]);
  assert.deepEqual(clean, []);

  const findings = verifyTrackedPaths([
    'README.md',
    'docs/superpowers/plans/old.md',
  ]);
  assert.deepEqual(findings, [
    { path: 'LICENSE', rule: 'required_file_missing' },
    { path: 'SECURITY.md', rule: 'required_file_missing' },
    { path: 'docs/superpowers/plans/old.md', rule: 'development_journal_tracked' },
  ]);
});

test('history scan allowlists only the known crypto self-test fixture commits', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const fixturePath = 'api/diagnostics/github-app-crypto-selftest.js';
  const allowedHistory = [
    'commit 12322a0a45cc06bd043aeba63609f64dc17054a3',
    `diff --git a/${fixturePath} b/${fixturePath}`,
    `+const fixture = '${privateKey}';`,
    'commit 3a54eb7172a5a8fbcd0530ae38cebf793caf3810',
    `diff --git a/${fixturePath} b/${fixturePath}`,
    `-const fixture = '${privateKey}';`,
  ].join('\n');
  assert.deepEqual(findHistorySecretFindings(allowedHistory, 'origin/main'), []);

  const unexpectedCommit = '0000000000000000000000000000000000000000';
  const unexpectedHistory = [
    `commit ${unexpectedCommit}`,
    `diff --git a/${fixturePath} b/${fixturePath}`,
    `+const fixture = '${privateKey}';`,
  ].join('\n');
  assert.deepEqual(findHistorySecretFindings(unexpectedHistory, 'origin/main'), [
    {
      scope: 'git_history',
      history_ref: 'origin/main',
      commit_sha: unexpectedCommit,
      path: fixturePath,
      rule: 'private_key',
    },
  ]);
});
