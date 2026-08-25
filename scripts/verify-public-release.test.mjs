import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSecretPatterns,
  findCurrentSourceViolations,
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
