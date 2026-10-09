import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GCP_OBSERVER_OPERATIONS,
  planGcpObserverPermissions,
} from '../src/providers/gcp/observer-permissions.ts';

test('observer plan produces only exact read permissions and does not grant authority', () => {
  const plan = planGcpObserverPermissions({
    project: 'demo-project',
    principal: 'observer@demo-project.iam.gserviceaccount.com',
    operations: [
      'compute.autoscalers.get',
      'compute.instanceGroupManagers.get',
      'compute.instanceGroupManagers.listManagedInstances',
      'compute.autoscalers.get',
    ],
  });
  assert.deepEqual(plan.permissions, [
    'compute.autoscalers.get',
    'compute.instanceGroupManagers.get',
  ]);
  assert.equal(plan.authority_granted, false);
  assert.equal(plan.read_only, true);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.permissions), true);
});

test('observer registry contains only read/list operation identifiers and permissions', () => {
  for (const [operation, permission] of Object.entries(GCP_OBSERVER_OPERATIONS)) {
    assert.match(operation, /\.(get|listManagedInstances)$/);
    assert.match(permission, /\.(get|list)$/);
  }
});

test('observer planner rejects caller-supplied write privileges and malicious coordinates', () => {
  for (const operation of [
    'compute.instances.insert',
    'compute.instanceGroupManagers.resize',
    'cloudbuild.builds.create',
    'resourcemanager.projects.setIamPolicy',
    '__proto__',
  ]) {
    assert.throws(
      () =>
        planGcpObserverPermissions({
          project: 'demo-project',
          principal: 'observer@demo-project.iam.gserviceaccount.com',
          operations: [operation as 'compute.autoscalers.get'],
        }),
      /GCP_OBSERVER_OPERATION_NOT_ALLOWED/,
    );
  }
  for (const project of ['', 'other/project', 'UPPER-PROJECT', 'a']) {
    assert.throws(
      () =>
        planGcpObserverPermissions({
          project,
          principal: 'observer@example.invalid',
          operations: ['compute.autoscalers.get'],
        }),
      /GCP_OBSERVER_SCOPE_INVALID/,
    );
  }
  assert.throws(
    () =>
      planGcpObserverPermissions({
        project: 'demo-project',
        principal: 'observer@example.invalid',
        operations: [],
      }),
    /GCP_OBSERVER_OPERATIONS_REQUIRED/,
  );
});
