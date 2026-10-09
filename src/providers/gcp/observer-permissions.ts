/**
 * Pure, deny-by-default permission projection for the read-only GCP observer.
 * A permission plan is NOT an IAM grant or an execution authorization.
 */
export const GCP_OBSERVER_OPERATIONS = {
  'compute.instanceGroupManagers.get': 'compute.instanceGroupManagers.get',
  'compute.autoscalers.get': 'compute.autoscalers.get',
  'compute.instanceGroupManagers.listManagedInstances': 'compute.instanceGroupManagers.get',
  'pubsub.projects.subscriptions.get': 'pubsub.subscriptions.get',
  'cloudscheduler.projects.locations.jobs.get': 'cloudscheduler.jobs.get',
  'run.projects.locations.services.revisions.get': 'run.revisions.get',
  'cloudbuild.projects.locations.builds.get': 'cloudbuild.builds.get',
  'storage.objects.get': 'storage.objects.get',
  'artifactregistry.projects.locations.repositories.get': 'artifactregistry.repositories.get',
} as const;

export type GcpObserverOperation = keyof typeof GCP_OBSERVER_OPERATIONS;

export interface GcpObserverScope {
  project: string;
  principal: string;
  operations: readonly GcpObserverOperation[];
}

export interface GcpObserverPermissionPlan {
  readonly project: string;
  readonly principal: string;
  readonly permissions: readonly string[];
  readonly read_only: true;
  readonly authority_granted: false;
}

export function planGcpObserverPermissions(scope: GcpObserverScope): GcpObserverPermissionPlan {
  if (
    !scope ||
    typeof scope !== 'object' ||
    !/^[a-z][a-z0-9-]{4,62}$/.test(scope.project) ||
    typeof scope.principal !== 'string' ||
    !/^[a-zA-Z0-9@._:/-]+$/.test(scope.principal)
  ) {
    throw new Error('GCP_OBSERVER_SCOPE_INVALID');
  }
  if (!Array.isArray(scope.operations) || scope.operations.length === 0) {
    throw new Error('GCP_OBSERVER_OPERATIONS_REQUIRED');
  }
  const permissions = new Set<string>();
  for (const operation of scope.operations as readonly GcpObserverOperation[]) {
    if (!Object.hasOwn(GCP_OBSERVER_OPERATIONS, operation)) {
      throw new Error('GCP_OBSERVER_OPERATION_NOT_ALLOWED');
    }
    permissions.add(GCP_OBSERVER_OPERATIONS[operation]);
  }
  return Object.freeze({
    project: scope.project,
    principal: scope.principal,
    permissions: Object.freeze([...permissions].sort()),
    read_only: true,
    authority_granted: false,
  });
}
