import type { Work } from '../../model.ts';
import {
  projectGcpRunnerDemand,
  type GcpRunnerAuthorityReader,
} from '../gcp/state-derived-runner-demand.ts';
import {
  parseRunnerLaunchRequest,
  type RunnerLaunchRequest,
} from '../../transport/gcp-runner-launcher.ts';
import {
  runnerSchedulingLabel,
  type RepositoryBinding,
  type RunnerAutoscalerConfig,
  type WorkflowJob,
} from '../../transport/gcp-runner-autoscaler.ts';

/** Independently observed, complete jobs for a numerically bound GitHub repository. */
export interface GcpRunnerJobObservation {
  repository: RepositoryBinding;
  jobs: readonly WorkflowJob[];
  complete: true;
}

export interface GcpRunnerLeaseProposal {
  obligation_id: string;
  run_id: string;
  authority_head: string;
  policy_sha256: string;
  launch: RunnerLaunchRequest;
}

export type GcpRunnerLeaseReconciliation =
  | {
      state: 'hold';
      reason: string;
      authority_head?: string;
      effect_authorized: false;
    }
  | {
      state: 'ready';
      authority_head: string;
      capacity_needed: 0 | 1;
      candidates: readonly GcpRunnerLeaseProposal[];
      effect_authorized: false;
    };

/**
 * Join a reconstructed Overcenter execution claim to an independently observed
 * queued GitHub job, without performing or admitting a provider effect.
 *
 * The trusted caller must bind the policy to independently approved source
 * authority and obtain complete fresh GitHub observations before invoking this.
 * Proposals cannot be sent directly to the Cloud Run launcher as authority.
 */
export function planGcpRunnerLeases(
  authority: GcpRunnerAuthorityReader,
  approvedPolicy: unknown,
  config: RunnerAutoscalerConfig,
  observations: readonly GcpRunnerJobObservation[],
): GcpRunnerLeaseReconciliation {
  const projection = projectGcpRunnerDemand(authority, approvedPolicy);
  if (projection.state === 'hold') {
    return {
      state: 'hold',
      reason: projection.reason,
      ...(projection.authority_head ? { authority_head: projection.authority_head } : {}),
      effect_authorized: false,
    };
  }

  // A projected capacity requirement is not an authorization to publish. Even
  // a successful join below is only an exact-source lease candidate.
  const hold = (reason: string): GcpRunnerLeaseReconciliation => ({
    state: 'hold',
    reason,
    authority_head: projection.authority_head,
    effect_authorized: false,
  });

  if (observations.length !== config.repositories.length) {
    return hold('INCOMPLETE_GITHUB_OBSERVATION');
  }
  const seenRepositories = new Set<number>();
  const queuedJobs = new Map<string, { repository: RepositoryBinding; job: WorkflowJob }>();
  for (const observed of observations) {
    if (observed.complete !== true) return hold('INCOMPLETE_GITHUB_OBSERVATION');
    const repository = config.repositories.find(
      (entry) =>
        entry.repository_id === observed.repository.repository_id &&
        entry.owner_id === observed.repository.owner_id &&
        entry.full_name.toLowerCase() === observed.repository.full_name.toLowerCase(),
    );
    if (!repository || seenRepositories.has(repository.repository_id)) {
      return hold('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
    }
    seenRepositories.add(repository.repository_id);
    for (const job of observed.jobs) {
      if (!Number.isSafeInteger(job.id) || job.id < 1) {
        return hold('INVALID_GITHUB_JOB_OBSERVATION');
      }
      if (runnerSchedulingLabel(job, config.runner_label) === null) continue;
      const key = `${repository.repository_id}:${job.id}`;
      if (queuedJobs.has(key)) return hold('DUPLICATE_GITHUB_JOB_OBSERVATION');
      queuedJobs.set(key, { repository, job });
    }
  }

  let work: Work[];
  try {
    if (authority.head() !== projection.authority_head) return hold('AUTHORITY_HEAD_MOVED');
    work = authority.inspect();
    if (authority.head() !== projection.authority_head) return hold('AUTHORITY_HEAD_MOVED');
  } catch {
    return hold('AUTHORITY_UNAVAILABLE');
  }

  if (!Array.isArray(work)) return hold('INVALID_AUTHORITY_STATE');
  const indexed = new Map(work.map((entry) => [entry.id, entry] as const));
  if (indexed.size !== work.length) return hold('INVALID_AUTHORITY_STATE');
  const proposals: GcpRunnerLeaseProposal[] = [];
  const matched = new Set<string>();

  for (const obligationId of projection.eligible_executing) {
    const obligation = indexed.get(obligationId);
    if (
      !obligation ||
      obligation.status !== 'EXECUTING' ||
      !obligation.run_id ||
      !projection.active_run_ids.includes(obligation.run_id)
    ) {
      return hold('EXECUTION_CLAIM_MOVED');
    }
    const raw = obligation.packet.gcp_runner_job;
    let launch: RunnerLaunchRequest;
    try {
      launch = parseRunnerLaunchRequest(raw);
    } catch {
      return hold('EXECUTION_JOB_BINDING_MISSING');
    }

    const boundRepository = config.repositories.find(
      (repository) =>
        repository.repository_id === launch.repository_id &&
        repository.owner_id === launch.owner_id &&
        repository.full_name.toLowerCase() === launch.repository.toLowerCase(),
    );
    const key = `${launch.repository_id}:${launch.job_id}`;
    const observed = queuedJobs.get(key);
    if (!boundRepository || !observed) return hold('EXECUTION_JOB_NOT_QUEUED');
    const label = runnerSchedulingLabel(observed.job, config.runner_label);
    if (!label || label !== launch.runner_label) return hold('EXECUTION_JOB_LABEL_MISMATCH');
    if (matched.has(key)) return hold('DUPLICATE_EXECUTION_JOB_BINDING');
    matched.add(key);

    proposals.push({
      obligation_id: obligationId,
      run_id: obligation.run_id,
      authority_head: projection.authority_head,
      policy_sha256: projection.binding.policy_sha256,
      launch,
    });
  }

  if (authority.head() !== projection.authority_head) return hold('AUTHORITY_HEAD_MOVED');
  return {
    state: 'ready',
    authority_head: projection.authority_head,
    capacity_needed: projection.capacity_needed,
    candidates: Object.freeze(proposals),
    effect_authorized: false,
  };
}
