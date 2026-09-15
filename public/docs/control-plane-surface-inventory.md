# Overcenter surface inventory

This document describes the current authority and exposure boundaries of Overcenter. It is a product surface inventory, not a historical implementation ledger.

## Authority model

Overcenter keeps authority deliberately narrow:

- **GitHub repositories** are authoritative for repository content, repository identity, exact revisions, pull requests, checks, and other repository facts.
- **Overcenter on GCP** owns execution semantics and durable execution truth: orchestration runs, work leases, claim/settlement, idempotency, deterministic recovery, command journaling, exact-revision mutation contracts, compact receipts, and recovery decisions.
- **Cloud SQL** is the authoritative runtime database for Overcenter state.
- **Linear** is a thin projection of currently executable work. It may reflect readiness, dependencies, acceptance boundaries, and current execution stage, but it is not repository authority and it is not a second execution/evidence store.
- **Hatchable** is legacy transport/integration and derived-projection context. It is not an authoritative writer, execution fallback, or source of Overcenter orchestration truth.

No compatibility or fallback control plane is part of the current architecture.

## Public runtime surface

The intentionally public runtime surface is the lightweight Overcenter preview. It reports aggregate system condition only.

The preview may expose bounded aggregate facts such as active run count, active lease count, and overall health/recovery condition. It must not expose:

- run IDs;
- lease references or capabilities;
- command receipts;
- raw errors;
- repository topology;
- Linear issue identifiers;
- credentials or provider tokens.

The operator dashboard and mutation surfaces are privileged.

## Privileged execution surfaces

Overcenter's privileged runtime is organized around semantic operations rather than arbitrary provider access.

### Semantic command ingress

Ordinary callers use the primary MCP commands. When a first-class MCP invocation is unavailable, the GitHub-native bounded semantic ingress authenticates through GitHub and GCP, verifies the exact source revision, and reaches the same authoritative GCP command boundary.

Transport does not change semantic ownership. A failed transport is not permission to reconstruct leases, settlement, retries, or recovery in the caller.

### Orchestration

Current orchestration surfaces cover run lifecycle, resume context, diagnosis, maintenance/recovery, health/status, and bounded horizon state.

### Work lifecycle

The productive supervisory lifecycle is:

```text
ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM
```

Work admission, exclusive ownership, progress, settlement, and terminalization remain governed by deterministic state and evidence. Workers report facts and perform judgment-heavy work; they do not own the durable bookkeeping protocol.

### GitHub operations

Higher-level GitHub commands exist only where atomicity, idempotency, conditional mutation, permission isolation, authoritative verification, or durable evidence justify them. Examples include exact-head changesets, review packets, safe branch deletion, required-check reconciliation, repository policy reconciliation, pull-request transitions, and repository lifecycle operations.

Each retained GitHub App capability has a fixed command-owned permission profile. Callers cannot request arbitrary GitHub App permissions.

### Work-surface reconciliation

`portfolio.reconcile_work_surface` derives the Linear executable-work projection from authoritative GitHub source facts and current Overcenter policy. Reconciliation does not make Linear authoritative and does not create a second repository model.

### Verification

`POST /api/verification/regressions` is the admin-only runtime regression entry point. Repository-static checks live under `scripts/` and do not replace runtime verification.

## Internal transport surfaces

Low-level HTTP routes and provider adapters are transport or implementation seams for callers and workflows that cannot use the primary semantic MCP surface directly. They are not a second orchestration authority.

Current authoritative execution terminates in the GCP runtime. Legacy Hatchable adapters and source-projection machinery may remain for compatibility or derived deployment projections; their presence does not restore Hatchable authority and must not be treated as an execution fallback.

## Source and runtime materialization

GitHub-authoritative source materialization is one-way: repository source flows from an exact GitHub revision into derived runtime artifacts. The authoritative Overcenter service is deployed to GCP through exact-revision GitHub Actions workflows authenticated with GCP Workload Identity/OIDC.

Some retained compatibility workflows still materialize a non-authoritative Hatchable projection. Those workflows are derived-state compatibility machinery, not the authority for runs, leases, settlement, receipts, or recovery. See [`source-sync.md`](source-sync.md) for the legacy projection contract and [`production-reconciliation.md`](production-reconciliation.md) for the current command boundary.

## Repository publication boundary

A public Overcenter repository should contain reusable product source, current product documentation, tests, migrations, and bounded examples. It should not contain:

- secret values;
- installation-specific project IDs;
- private operational evidence;
- development-session plans or agent journals;
- obsolete control-plane authority claims.

`node scripts/verify-public-release.mjs` enforces the mechanically checkable portion of this boundary from a complete Git checkout.
