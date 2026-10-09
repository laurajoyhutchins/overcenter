import { canonicalDigest } from '../../digest.ts';
import type { KernelCore } from '../../authority/engine.ts';
import type { Work, WorkStatus } from '../../model.ts';
import { isData } from '../../validation.ts';

export const GCP_RUNNER_DEMAND_POLICY_SCHEMA = 'overcenter-gcp-runner-demand-policy/v1' as const;

export interface GcpRunnerDemandPolicy {
  schema: typeof GCP_RUNNER_DEMAND_POLICY_SCHEMA;
  pool: string;
  project: string;
  zone: string;
  managed_instance_group: string;
  maximum_instances: 1;
  eligible_obligation_ids: string[];
}

export interface GcpRunnerDemandBinding {
  pool: string;
  project: string;
  zone: string;
  managed_instance_group: string;
  policy_sha256: string;
}

export type GcpRunnerDemandProjection =
  | {
      state: 'projected';
      authority_head: string;
      binding: GcpRunnerDemandBinding;
      capacity_needed: 0 | 1;
      eligible_ready: readonly string[];
      eligible_executing: readonly string[];
      active_run_ids: readonly string[];
      // A desired capacity is not an admitted GCP effect or a claim that GCE is idle.
      effect_authorized: false;
    }
  | {
      state: 'hold';
      reason:
        | 'INVALID_POLICY'
        | 'AUTHORITY_UNAVAILABLE'
        | 'AUTHORITY_HEAD_MOVED'
        | 'INVALID_AUTHORITY_STATE'
        | 'TRACKED_OBLIGATION_MISSING'
        | 'RECOVERY_REQUIRED'
        | 'INVALID_EXECUTION_CLAIM';
      authority_head?: string;
      blocked_obligation_ids: readonly string[];
      effect_authorized: false;
    };

export type GcpRunnerAuthorityReader = Pick<KernelCore, 'head' | 'inspect'>;

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value) && value.length <= 128
  );
}

function validatePolicy(input: unknown): GcpRunnerDemandPolicy | null {
  if (!isData(input)) return null;
  const expected = [
    'schema',
    'pool',
    'project',
    'zone',
    'managed_instance_group',
    'maximum_instances',
    'eligible_obligation_ids',
  ];
  if (
    Object.keys(input).sort().join(',') !== [...expected].sort().join(',') ||
    input.schema !== GCP_RUNNER_DEMAND_POLICY_SCHEMA ||
    !validIdentity(input.pool) ||
    !validIdentity(input.project) ||
    !validIdentity(input.zone) ||
    !validIdentity(input.managed_instance_group) ||
    input.maximum_instances !== 1 ||
    !Array.isArray(input.eligible_obligation_ids) ||
    input.eligible_obligation_ids.length === 0 ||
    !input.eligible_obligation_ids.every(
      (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256,
    ) ||
    new Set(input.eligible_obligation_ids).size !== input.eligible_obligation_ids.length
  ) {
    return null;
  }
  return {
    schema: GCP_RUNNER_DEMAND_POLICY_SCHEMA,
    pool: input.pool,
    project: input.project,
    zone: input.zone,
    managed_instance_group: input.managed_instance_group,
    maximum_instances: 1,
    eligible_obligation_ids: [...input.eligible_obligation_ids].sort(),
  };
}

function hold(
  reason: Extract<GcpRunnerDemandProjection, { state: 'hold' }>['reason'],
  blocked: readonly string[] = [],
  authorityHead?: string,
): GcpRunnerDemandProjection {
  return {
    state: 'hold',
    reason,
    ...(authorityHead === undefined ? {} : { authority_head: authorityHead }),
    blocked_obligation_ids: Object.freeze([...blocked].sort()),
    effect_authorized: false,
  };
}

function validWork(value: Work): boolean {
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    ['READY', 'EXECUTING', 'WAITING', 'RECOVERY_REQUIRED', 'DONE', 'BLOCKED'].includes(
      value.status satisfies WorkStatus,
    )
  );
}

/**
 * Derive runner demand solely from a stable, reconstructed Overcenter authority
 * head and a separately approved pool/obligation policy.
 *
 * This is pure demand calculation. It does not publish Pub/Sub leases, create
 * GitHub JIT workers, change GCE autoscaling policy, or grant effect authority.
 * The caller must bind the policy to its trusted origin before using this result.
 */
export function projectGcpRunnerDemand(
  authority: GcpRunnerAuthorityReader,
  policyInput: unknown,
): GcpRunnerDemandProjection {
  const policy = validatePolicy(policyInput);
  if (!policy) return hold('INVALID_POLICY');

  let before: string | null;
  let after: string | null;
  let work: Work[];
  try {
    before = authority.head();
    if (!before || !/^[0-9a-f]{40}$/.test(before)) return hold('AUTHORITY_UNAVAILABLE');
    work = authority.inspect();
    after = authority.head();
  } catch {
    return hold('AUTHORITY_UNAVAILABLE');
  }
  if (after !== before) return hold('AUTHORITY_HEAD_MOVED', [], before);
  if (!Array.isArray(work)) return hold('INVALID_AUTHORITY_STATE', [], before);

  const indexed = new Map<string, Work>();
  for (const item of work) {
    if (!item || !validWork(item) || indexed.has(item.id)) {
      return hold('INVALID_AUTHORITY_STATE', [], before);
    }
    indexed.set(item.id, item);
  }

  const missing = policy.eligible_obligation_ids.filter((id) => !indexed.has(id));
  if (missing.length > 0) return hold('TRACKED_OBLIGATION_MISSING', missing, before);

  const selected = policy.eligible_obligation_ids.map((id) => indexed.get(id)!);
  const recovery = selected.filter((item) => item.status === 'RECOVERY_REQUIRED');
  if (recovery.length > 0) {
    return hold(
      'RECOVERY_REQUIRED',
      recovery.map((item) => item.id),
      before,
    );
  }
  const executing = selected.filter((item) => item.status === 'EXECUTING');
  const invalid = executing.filter(
    (item) =>
      !item.run_id ||
      !item.claimed_revision ||
      !/^[0-9a-f]{40}$/.test(item.claimed_revision) ||
      !Number.isSafeInteger(item.execution_generation) ||
      (item.execution_generation ?? 0) < 1,
  );
  if (invalid.length > 0) {
    return hold(
      'INVALID_EXECUTION_CLAIM',
      invalid.map((item) => item.id),
      before,
    );
  }
  const ready = selected.filter((item) => item.status === 'READY');

  const binding: GcpRunnerDemandBinding = {
    pool: policy.pool,
    project: policy.project,
    zone: policy.zone,
    managed_instance_group: policy.managed_instance_group,
    policy_sha256: canonicalDigest(policy),
  };
  return {
    state: 'projected',
    authority_head: before,
    binding,
    capacity_needed: ready.length + executing.length > 0 ? 1 : 0,
    eligible_ready: Object.freeze(ready.map((item) => item.id)),
    eligible_executing: Object.freeze(executing.map((item) => item.id)),
    active_run_ids: Object.freeze(executing.map((item) => item.run_id!)),
    effect_authorized: false,
  };
}
