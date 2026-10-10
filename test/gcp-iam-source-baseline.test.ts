import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectGcpIamDirectBindings } from '../src/providers/gcp/iam-source-baseline.ts';

const project = 'projects/project-6b810532-a302-48dc-b56';
const serviceAccount =
  'projects/project-6b810532-a302-48dc-b56/serviceAccounts/overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com';
const restricted = {
  state: 'observed' as const,
  resource: project,
  evidence_ref: 'gcp-observation:sha256:abc123',
  policy: {
    version: 3,
    etag: 'BwY=',
    bindings: [
      {
        role: 'projects/project-6b810532-a302-48dc-b56/roles/overcenterObserver',
        members: [
          'serviceAccount:overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
        ],
        condition: { title: 'bounded', expression: "resource.name.startsWith('projects/')" },
      },
    ],
  },
};

test('preserves exact conditional bindings without asserting effective permission', () => {
  const result = inspectGcpIamDirectBindings([project], [restricted]);
  assert.equal(result.state, 'observed');
  assert.equal(result.authorization_established, false);
  assert.equal(result.effective_permissions_established, false);
  assert.deepEqual(result.directly_observed_bindings, [
    {
      resource: project,
      role: 'projects/project-6b810532-a302-48dc-b56/roles/overcenterObserver',
      member:
        'serviceAccount:overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
      condition_expression: "resource.name.startsWith('projects/')",
    },
  ]);
});

test('missing, denied and malformed provider readbacks HOLD', () => {
  assert.equal(inspectGcpIamDirectBindings([project, serviceAccount], [restricted]).state, 'hold');
  assert.equal(
    inspectGcpIamDirectBindings(
      [project],
      [{ state: 'indeterminate', resource: project, reason: 'HTTP_403' }],
    ).state,
    'hold',
  );
  for (const policy of [
    { version: 1, etag: 'x', bindings: [] },
    { version: 3, bindings: [] },
    { version: 3, etag: 'x' },
    { version: 3, etag: 'x', bindings: [{ role: 'roles/owner', members: ['attacker'] }] },
    {
      version: 3,
      etag: 'x',
      bindings: [{ role: 'roles/viewer', members: ['user:a@example.com'], condition: {} }],
    },
  ]) {
    assert.equal(inspectGcpIamDirectBindings([project], [{ ...restricted, policy }]).state, 'hold');
  }
});

test('refuses unknown target, duplicate readback and malformed required scope', () => {
  assert.throws(() => inspectGcpIamDirectBindings([], []), /REQUIRED_RESOURCES_INVALID/);
  assert.throws(
    () => inspectGcpIamDirectBindings([project, project], []),
    /REQUIRED_RESOURCES_INVALID/,
  );
  assert.throws(
    () => inspectGcpIamDirectBindings([project], [restricted, restricted]),
    /UNEXPECTED_OR_DUPLICATE/,
  );
  assert.throws(
    () => inspectGcpIamDirectBindings([serviceAccount], [restricted]),
    /UNEXPECTED_OR_DUPLICATE/,
  );
});

test('does not hide extra or broad direct grants while withholding effective-permission claims', () => {
  const result = inspectGcpIamDirectBindings(
    [project],
    [
      {
        ...restricted,
        policy: {
          version: 3,
          etag: 'x',
          bindings: [{ role: 'roles/owner', members: ['user:admin@example.com', 'allUsers'] }],
        },
      },
    ],
  );
  assert.equal(result.state, 'observed');
  assert.equal(result.directly_observed_bindings.length, 2);
  assert.equal(result.effective_permissions_established, false);
});
