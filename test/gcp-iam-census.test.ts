import assert from 'node:assert/strict';
import test from 'node:test';

import { collectGcpIamCensus, GCP_IAM_CENSUS_TARGETS } from '../src/providers/gcp/iam-census.ts';

test('all IAM census operations are fixed, read-only and bound to expected project', () => {
  assert.equal(GCP_IAM_CENSUS_TARGETS.length, 7);
  for (const item of GCP_IAM_CENSUS_TARGETS) {
    assert.match(item.command.join(' '), /project-6b810532-a302-48dc-b56/);
    assert.ok(item.command.includes('--format=json'));
    assert.ok(
      ['get-iam-policy', 'get-ancestors', 'list', 'describe'].some((verb) =>
        item.command.includes(verb),
      ),
    );
    assert.doesNotMatch(item.command.join(' '), /\b(?:create|update|delete|set|add|remove)\b/);
  }
});

test('successful raw census never authorizes IAM or claims effective privilege', () => {
  const calls: string[] = [];
  const receipt = collectGcpIamCensus(
    (args) => {
      calls.push(args.join(' '));
      const isList = args.includes('list') || args.includes('get-ancestors');
      return JSON.stringify(isList ? [] : { name: 'observed-readback' });
    },
    () => '2026-10-10T13:00:00.000Z',
  );
  assert.equal(calls.length, GCP_IAM_CENSUS_TARGETS.length);
  assert.equal(receipt.direct_readbacks_complete, true);
  assert.equal(receipt.authority_granted, false);
  assert.equal(receipt.independently_verified, false);
  assert.equal(receipt.effective_permissions_established, false);
  assert.equal(
    receipt.observations.every((entry) => entry.outcome.state === 'read'),
    true,
  );
});

test('unavailable observer readback and malformed responses remain indeterminate', () => {
  const receipt = collectGcpIamCensus((args) => {
    if (args.includes('get-ancestors')) throw new Error('HTTP_403');
    if (args.includes('get-iam-policy')) return 'null';
    return '{}';
  });
  assert.equal(receipt.direct_readbacks_complete, false);
  assert.equal(
    receipt.observations.find((entry) => entry.id === 'project-ancestry')?.outcome.state,
    'indeterminate',
  );
  assert.equal(
    receipt.observations.find((entry) => entry.id === 'project-iam-allow')?.outcome.state,
    'indeterminate',
  );
  assert.equal(receipt.authority_granted, false);
});

test('caller cannot inject additional IAM targets or commands', () => {
  const invoked: string[] = [];
  collectGcpIamCensus((args) => {
    invoked.push(args[0] ?? '');
    return '{}';
  });
  assert.equal(invoked.length, 7);
  assert.equal(
    invoked.every((command) => ['projects', 'iam'].includes(command)),
    true,
  );
});
