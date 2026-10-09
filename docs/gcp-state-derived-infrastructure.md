# State-derived GCP runner demand

Overcenter should not accept an agent request to start or stop a VM. The
system's authoritative lifecycle state determines required runner demand
under a separate, previously approved resource policy.

This is a staged capability. The pure projection in
`src/providers/gcp/state-derived-runner-demand.ts` is **read-only** and cannot
mint effect authority, publish a Pub/Sub lease, authenticate to GCP, start a
GitHub worker, or change the size of a managed instance group (MIG).

## Input authority

The trusted operator supplies:

1. A `KernelCore` reader reconstructing `head()` and `inspect()` from durable
   Overcenter history. A changed head or unreadable authority returns HOLD.
2. An approved, exact pool policy mapping obligation identities to one GCP
   worker pool, project, zone, and MIG. The projection validates the closed
   policy shape and computes its canonical digest. **A digest does not by
   itself prove that the policy was approved**; the future operator must
   retrieve and bind it from trusted policy authority.
3. No user-reported activity, clock-hour assumptions, arbitrary shell
   commands, or caller-selected provider endpoints.

`READY` eligible work or `EXECUTING` work requires one worker.
`BLOCKED` and `DONE` eligible work requires no new worker.
The cap is exactly one, even if multiple obligations are ready. An
`EXECUTING` obligation must carry a claim identity. Missing entries,
contradictory state, `WAITING`, or `RECOVERY_REQUIRED` cause HOLD rather than a
speculative scale-down. Overcenter treats `WAITING` as an in-flight lifecycle;
the projection may only release capacity once separate provider evidence
establishes that the runner and outstanding leases are no longer active.

Only explicitly mapped obligations contribute to this pool. This does not
automatically turn every Overcenter `READY` obligation into a GCP Actions
job; source-change reasoning, system evidence, and other substrates are not
interchangeable.

## The capacity actuator stays singular

The deployed warm runner is controlled by a GCE autoscaler driven by its
`overcenter-gce-runners` Pub/Sub subscription. Implementing another loop that
directly resizes the MIG from this projection would introduce competing
controllers and might strand leases.

The subsequent integration must bind this state-derived demand to
**already admitted GitHub job/lease identities**, using the existing
publisher/JIT/host protocol. It must:

- preserve immutable repository/job identity and source admission;
- deduplicate exact leases, with provider readback before ambiguous retries;
- refrain from publishing a new lease when the job is no longer queued;
- retain existing one-host policy and service-account privilege ceilings;
- collect certified MIG, autoscaler, Pub/Sub, worker cleanup, and lease
  acknowledgement observations before asserting convergence.

Desired capacity zero is only an intent. It does not prove actual VM
absence, zero provider backlog, a settled GitHub job, or Docker/workspace
teardown. The GCE autoscaler may still need its stabilization interval and
the wake mechanism must remain available when the MIG is at zero.

## Admission and remaining verification

Projection result `effect_authorized: false` is unconditional. A future
controller must use Overcenter's existing permit/reservation/release
mechanism; an operator cannot turn this projection directly into a GCP
mutation. New resource families, costs, project/zone scope, or privileges
require a separately owner-approved policy/identity change (see #702).

GCP provider observation work is in #727. The read-only observer identity
and the real cold-wake/ACK/cleanup/return-to-zero experiment remain
unfinished in #686. Neither this module nor fixture tests establish
production actuation or live GCP cost reductions.

Tracking: #726.

## Operator and GitHub queue integration

The existing `project.advance` command now **observes** demand automatically
when the exact trusted project source contains
`.overcenter/gcp-runner-demand-policy.json`. This is the closed
`overcenter-gcp-runner-demand-policy/v1` shape. Its
`eligible_obligation_ids` identify only those obligations authorized for the
specified GCP pool. The operator reopens the durable project authority through
`GitOvercenterKernel` and prints an exact-head JSON observation along with
machine-readable GitHub step outputs. An invalid policy or unknown state is
not permission to dispatch.

`planGcpRunnerLeases` then joins this projection with complete, independently
read GitHub repository/job observations. Each `EXECUTING` obligation must
carry an exact, immutable `packet.gcp_runner_job` binding:
`repository`, numeric `repository_id`, numeric `owner_id`, numeric
`job_id`, and `runner_label`. Both the configured repository identity and
the queued job's scheduling label must match. `READY` work contributes to
desired capacity but has no publishable lease without a durable claim.

Both observation and lease-candidate results explicitly set
`effect_authorized: false`. The original production Cloud Run autoscaler
still publishes leases based on its existing GitHub queue policy, not this
new Overcenter authority join. Making this join the live dispatch admission
boundary requires a trusted observer for the same durable project state in
the autoscaler, a registered GCP lease-publication effect contract and
reservation, provider-side ambiguity/duplicate reconciliation, and independent
Pub/Sub ACK/host teardown observations. That is tracked by #729 and #686.
It must not be simulated by merely converting a lease candidate into an
HTTP request.
