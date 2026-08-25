# Busbar surface inventory

This document describes the current authority and exposure boundaries of Busbar. It is a product surface inventory, not a historical implementation ledger.

## Authority model

Busbar keeps authority deliberately narrow:

- **GitHub repositories** are authoritative for repository content, repository identity, exact revisions, pull requests, checks, and other repository facts.
- **Busbar** owns execution semantics and durable execution evidence: orchestration runs, work leases, claim/settlement, idempotency, deterministic recovery, command journaling, exact-revision mutation contracts, and receipts.
- **Linear** is a thin projection of currently executable work. It may reflect readiness, dependencies, acceptance boundaries, and current execution stage, but it is not repository authority and it is not a second execution/evidence store.
- **Hatchable** is the current hosting/runtime layer. Runtime source and runtime deployment metadata are derived state, not repository authority.

No compatibility or fallback control plane is part of the current architecture.

## Public runtime surface

The intentionally public runtime surface is the lightweight Busbar preview. It reports aggregate system condition only.

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

Busbar's privileged runtime is organized around semantic operations rather than arbitrary provider access.

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

`portfolio.reconcile_work_surface` derives the Linear executable-work projection from authoritative GitHub source facts and current Busbar policy. Reconciliation does not make Linear authoritative and does not create a second repository model.

### Verification

`POST /api/verification/regressions` is the admin-only runtime regression entry point. It returns machine-readable suite and case results. Repository-static checks live under `scripts/` and do not replace runtime verification.

## Internal transport surfaces

Low-level HTTP work routes remain internal transport for callers that cannot use the semantic MCP/worker boundary directly. They are not a second orchestration authority. Canonical semantics remain owned by the same work and orchestration services underneath them.

Transport adapters may authenticate to GitHub, Linear, or Hatchable, but credentials remain adapter/runtime concerns. Core deterministic policy modules should consume verified facts rather than credentials.

## Source materialization

GitHub-authoritative source materialization is one-way. Deployment coordinates are supplied by the installation adapter. Busbar source does not hard-code a production Hatchable project identifier.

See [`source-sync.md`](source-sync.md).

## Repository publication boundary

A public Busbar repository should contain reusable product source, current product documentation, tests, migrations, and bounded examples. It should not contain:

- secret values;
- installation-specific project IDs;
- private operational evidence;
- development-session plans or agent journals;
- obsolete control-plane authority claims.

`node scripts/verify-public-release.mjs` enforces the mechanically checkable portion of this boundary from a complete Git checkout.
