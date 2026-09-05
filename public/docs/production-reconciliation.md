# Production reconciliation

Use `production.reconcile({ repo })` as the normal dev-to-production operation.

The command accepts repository identity only. Overcenter derives the declared development and production branches, exact Git heads, exact-revision verification evidence, promotion bookkeeping, production materialization state, recovery identity, and final convergence evidence.

## Convergence

`production.reconcile` observes current authority and advances only the first unmet deterministic production invariant:

1. the current development revision is exactly verified;
2. production Git points at that verified revision;
3. a freshly tracked production-materialization run proves the current immutable runtime is the same exact revision, materializing it first when necessary;
4. a fresh final Git read still identifies the selected revision.

If production Git is stale, Overcenter uses the existing exact-SHA non-force promotion primitive and rereads Git before runtime work is allowed. If production Git is already current, promotion is skipped.

A manual reconciliation run first checks the current Hatchable version, source-materialization receipt, and that exact immutable deployment. When those already bind the selected Git revision, no production Git or Hatchable mutation occurs. When they prove the runtime stale, the same serialized workflow builds and invokes the existing deterministic materializer. Push-triggered production updates continue to materialize directly.

If the exact workflow run is still queued or executing when the bounded command call ends, the command returns `materialization_pending` with that exact run reference. It never converts an older completed workflow run into current-runtime truth.

## Evidence and recovery

Historical successful materialization runs are telemetry, not current production evidence. `production.reconcile` either follows an exact matching run that is still active when reconciliation begins or dispatches a new exact-revision reconciliation run and tracks the run ID returned by GitHub.

The tracked run fences the declared production head before any Hatchable mutation. A completed successful run is accepted only for the exact selected revision and production branch. A failed run fails closed. An indeterminate dispatch is not blindly retried because the external workflow effect may already exist.

After fresh runtime proof, Overcenter rereads the development and production Git heads before reporting convergence. Final success therefore binds one selected exact Git revision to a freshly verified immutable runtime observation within the limits of the underlying platforms.

## Lower-level primitive

`production.promote({ repo })` remains available for the narrower operation of promoting verified development source into the production Git branch. Normal callers should prefer `production.reconcile` because production is not considered current until the runtime projection is freshly verified too.

## Residual platform boundary

This convergence operator does not eliminate Hatchable issue #161's mutable draft-to-deploy atomicity limitation. The materializer continues to reduce that race through exact-version fencing, staged and immutable readback, and deterministic rematerialization, but it does not claim an atomic publish primitive that Hatchable does not provide.