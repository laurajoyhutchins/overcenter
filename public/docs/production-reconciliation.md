# Production reconciliation

Use `production.reconcile({ repo })` as the normal dev-to-production operation.

The command accepts repository identity only. Overcenter derives the declared development and production branches, exact Git heads, exact-revision verification evidence, promotion bookkeeping, production materialization state, and recovery identity.

## Convergence

`production.reconcile` observes current authority and advances only the first unmet deterministic production invariant:

1. current development revision is exactly verified;
2. production Git points at that verified revision;
3. the serialized production-materialization workflow has successfully verified the same exact revision in the immutable runtime;
4. a fresh final Git read still identifies the selected revision.

If everything is already current, the command returns `already_converged` without mutation. If Git promotion is complete but materialization is queued or running, it returns `materialization_pending`. Reinvoking the same repo intent resumes from current authority rather than replaying completed phases.

## Recovery

The existing `Production materialization` workflow remains the only Hatchable production writer. It runs on production-branch pushes and also exposes a recovery dispatch for one exact production revision. Both paths fence that revision against the current production branch before any Hatchable mutation.

Overcenter reuses an exact matching active or successful workflow run when one exists. A completed failed run may be deterministically retried through the same materialization boundary. An indeterminate dispatch is not blindly retried.

## Lower-level primitive

`production.promote({ repo })` remains available for the narrower operation of promoting verified development source into the production Git branch. Normal callers should prefer `production.reconcile` because production is not considered current until the runtime projection is verified too.

## Residual platform boundary

This convergence operator does not eliminate Hatchable issue #161's mutable draft-to-deploy atomicity limitation. The materializer continues to recover by authoritative observation and deterministic rematerialization when necessary.