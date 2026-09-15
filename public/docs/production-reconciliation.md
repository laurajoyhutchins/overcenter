# Production reconciliation

Use `production.reconcile({ repo })` as the semantic command for converging verified development source into declared production state.

The command accepts repository identity only. Overcenter derives the declared development and production branches, exact Git heads, exact-revision verification evidence, promotion bookkeeping, runtime-projection verification, recovery identity, and final convergence evidence.

## Authority boundary

`production.reconcile` does **not** redefine the control-plane authority model:

- GitHub remains authoritative for repository source and branch revisions.
- Overcenter on GCP remains authoritative for runs, leases, claims, settlement, receipts, recovery, and orchestration state.
- Cloud SQL remains the authoritative runtime database.
- Hatchable is not an authoritative writer or execution fallback.

The current implementation still contains a retained Hatchable-backed **derived production projection** step. That projection is compatibility/deployment evidence only. Its presence does not make Hatchable the authoritative Overcenter runtime and must not be used to route around the GCP control plane.

## Convergence

`production.reconcile` observes current authority and advances only the first unmet deterministic production invariant:

1. the current development revision is exactly verified;
2. production Git points at that verified revision;
3. the derived production projection is freshly verified for the same exact revision, materializing it through the retained compatibility workflow when necessary;
4. a fresh final Git read still identifies the selected revision on both development and production branches.

If production Git is stale, Overcenter uses the existing exact-SHA non-force promotion primitive and rereads Git before projection work is allowed. If production Git is already current, promotion is skipped.

The narrower `production.promote` path is GCP-native: GitHub Actions authenticates to the authoritative GCP service through Workload Identity/OIDC and invokes the semantic production-promotion command there. Promotion success is accepted only when the returned source and production revisions match the exact requested development revision and a fresh Git read agrees.

## Derived projection compatibility stage

After Git promotion is current, `production.reconcile` currently observes and, when needed, materializes a non-authoritative Hatchable projection through exact-revision GitHub Actions workflows.

This is intentionally a derived-state compatibility boundary:

- the workflow is fenced to the exact production Git revision;
- a successful observation or materialization is evidence only for that derived projection;
- historical successful runs are telemetry, not current proof;
- an active exact-revision materialization run may be resumed by identity;
- an indeterminate dispatch is not blindly retried because the external effect may already exist;
- no Hatchable result can create run, lease, settlement, recovery, or repository authority.

If the exact materialization run is still queued or executing when the bounded command call ends, the command returns `materialization_pending` with that exact run reference. It never converts an older completed run into current projection truth.

## Evidence and recovery

The command distinguishes source verification, production promotion, derived projection verification, and final Git readback. A successful call therefore binds one selected exact Git revision across those checks without collapsing their authority domains.

If promotion or projection dispatch may have happened but the outcome is uncertain, the command preserves `may_have_mutated` and fails closed or returns the exact pending run identity. Callers must not translate transport uncertainty into a blind retry.

After fresh projection proof, Overcenter rereads the development and production Git heads before reporting convergence. If either moved, reconciliation fails with final drift rather than claiming success from stale evidence.

## Lower-level primitive

`production.promote({ repo })` remains the narrower operation for promoting verified development source into the production Git branch through the authoritative GCP semantic boundary.

`production.reconcile` adds the current derived-projection compatibility check and final convergence proof. Do not interpret that extra check as making Hatchable part of Overcenter's authoritative execution state.

## Current migration boundary

The retained Hatchable projection machinery is a compatibility residue, not a second control plane. The authoritative Overcenter service is deployed on GCP by the exact-revision GCP deployment workflows, while this command still verifies a separate derived projection for compatibility.

Until that compatibility stage is retired or replaced, documentation and callers must keep these facts separate:

```text
GitHub source authority
        |
        +--> GCP authoritative Overcenter runtime / Cloud SQL execution truth
        |
        +--> legacy derived Hatchable projection (compatibility evidence only)
```

A failure of the derived projection path is not permission to execute Overcenter state transitions in Hatchable.
