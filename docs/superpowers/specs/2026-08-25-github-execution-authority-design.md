# GitHub Execution Authority Design

## Goal

Make Busbar's existing work lease the required execution capability for work-scoped GitHub mutations. A worker that has not acquired the current Busbar lease must be unable to create a new GitHub external effect through the managed mutation surface.

## Authority model

No new authorization state is introduced. `work_leases`, `work_lease_slots`, and `orchestration_runs` remain authoritative for execution ownership. The GitHub command receives the opaque lease token, resolves it to the existing lease, and derives non-secret authority evidence from the lease receipt.

For `github.apply_changeset`, new or unfinished mutation requires all of the following: the lease exists; its status is active; it is unexpired; its `(work_ref, gate)` slot still points to that lease; its orchestration run is active and within deadline; the lease execution projection names the requested repository; and the gate is `lane:repo-implementation`.

A fully succeeded exact idempotent replay may return its stored receipt after lease expiry because it performs no new external effect. A prepared or otherwise unfinished replay must re-prove live authority before continuing.

## Secret handling

`lease_token` is capability material. It must not appear in orchestration journal request projections, durable GitHub receipts, logs, or returned authority evidence. Durable evidence may include `work_ref`, `lease_id`, `run_id`, `gate`, repository, and the execution fingerprint.

## First slice

Add one shared execution-authority assertion and wire only `github.apply_changeset`. Keep read-only GitHub commands unchanged. Do not add warning-only compatibility behavior. Follow-on work will migrate other work-scoped mutations and then use GitHub rulesets to prevent direct credential bypass outside Busbar.

## Verification

Regression coverage must prove missing/invalid authority rejects before GitHub mutation, stale slot ownership rejects, expired or non-active leases reject, inactive runs reject, wrong repository and wrong gate reject, valid authority succeeds, secrets stay out of safe projections/receipts, and succeeded idempotent replay is non-mutating after authority expiry.