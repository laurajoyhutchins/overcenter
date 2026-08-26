import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMetadataTextViolations as canonicalDetectMetadataTextViolations } from '../lib/public-github-metadata-policy.js';

import {
  detectMetadataTextViolations,
  extractOwnerRepositoryCoordinates,
  listAll,
} from './verify-public-github-metadata.mjs';

test('repository scanner reuses the canonical metadata detector', () => { assert.equal(detectMetadataTextViolations, canonicalDetectMetadataTextViolations); });

test('metadata policy rejects installation coordinates and work identifiers', () => {
  const projectId = ['proj_', 'abcdefghijkl'].join('');
  const clientId = ['Iv23', 'abcdefghijklmnop'].join('');
  const workId = ['LJH', '-391'].join('');
  const findings = detectMetadataTextViolations([
    `deployment: ${projectId}`,
    `GitHub App ID 1234567`,
    `client ID ${clientId}`,
    `repository ID 123456789`,
    `work ${workId}`,
  ].join('\n'));

  assert.deepEqual(findings.map(finding => finding.rule), [
    'hatchable_project_id',
    'github_app_client_id',
    'github_app_registration_id',
    'repository_numeric_id',
    'linear_work_id',
  ]);
});

test('metadata policy reuses high-confidence secret detection', () => {
  const token = ['ghp_', '1234567890abcdefghijklmnopqrstuv'].join('');
  assert.deepEqual(
    detectMetadataTextViolations(`token=${token}`).map(finding => finding.rule),
    ['github_token'],
  );
});

test('owner repository coordinates are extracted without duplication', () => {
  assert.deepEqual(
    extractOwnerRepositoryCoordinates([
      'laurajoyhutchins/overcenter',
      'laurajoyhutchins/private-example',
      'laurajoyhutchins/private-example',
    ].join('\n')),
    ['laurajoyhutchins/overcenter', 'laurajoyhutchins/private-example'],
  );
});

test('collection pagination stops on a short page', async () => {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const body = page === 1
      ? Array.from({ length: 100 }, (_, id) => ({ id }))
      : [{ id: 100 }];
    return {
      ok: true,
      status: 200,
      async json() { return body; },
    };
  };

  const items = await listAll('/repos/example/repo/issues', fetchImpl);
  assert.equal(items.length, 101);
  assert.equal(requests.length, 2);
});
