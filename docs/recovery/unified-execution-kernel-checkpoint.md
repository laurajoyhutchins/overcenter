# Unified execution correctness kernel checkpoint

Date: 2026-09-12
Repository: `laurajoyhutchins/overcenter`
Branch: `codex/unified-execution-correctness-kernel-design`
Last durable source revision: `ce0d3bf7f5a9146f7b98efac757d40c39ef1e656`

## Checkpoint status

The prior implementation pass was performed in an ephemeral scratch worktree and was not committed. That worktree was later removed. This file is the durable reconstruction checkpoint; it records what was completed and what must be rebuilt before continuing.

Do not treat the lost implementation as present in this branch. Rebuild from the source revision above, using this checkpoint as the acceptance record, and commit each coherent slice before starting the next.

## Completed design and intended implementation

The target survivor is one TypeScript execution transaction kernel for uncertain external effects:

`ExecutionIntent -> durable identity -> authority/lease fence -> provider effect -> mutation certainty -> exact proof -> settlement receipt`

The kernel must own:

- stable execution identity and idempotency;
- exact authority revision and epoch fencing;
- lease ownership and stale-worker rejection;
- effect attempt protocol;
- `definitely_not_mutated`, `may_have_mutated`, and `confirmed_mutated`;
- exact execution/revision-bound structured evidence;
- durable settlement receipts;
- deterministic confirm-only recovery after uncertainty.

Provider adapters may retain provider-specific SHA comparison, conditional mutation, and readback, but must not implement generic retries, lease semantics, recovery, evidence binding, or settlement.

## Files and records intended to survive

TypeScript semantic source:

- `src/semantic/execution-transaction.ts`
- `src/semantic/execution-transaction-runtime.ts`
- `src/semantic/execution-transaction-store.ts`
- `src/adapters/postgres/execution-transaction-store.ts`
- `src/semantic/canonical-json.ts`

Provider wrappers:

- `src/semantic/deterministic-work-settlement-execution.ts`
- `src/semantic/github-changeset-execution.ts`
- `src/semantic/github-release-execution.ts`
- `src/semantic/portfolio-reconcile-execution.ts`
- `src/semantic/production-materialization-execution.ts`
- `src/semantic/project-authoring-execution.ts`

Durable schema:

- `migrations/060_execution_transaction_identity.sql`
- `migrations/061_execution_transaction_cleanup.sql`
- canonical records: `execution_state`, `operation_state`, `proof_state`.

Generated JavaScript mirrors are build output, not independent authority.

## Provider migrations completed in the lost pass

The following semantic paths were intended to invoke the kernel:

- GitHub changesets and text replacements;
- GitHub releases;
- production promotion and materialization;
- portfolio reconciliation;
- deterministic work settlement;
- project authoring;
- the uncertain authoritative project-transition GitHub effect.

Retired compatibility/provider ledgers:

- compact execution/proof/provider-operation stores;
- provider receipt stores;
- compatibility transition bindings and confirmation paths;
- legacy GitHub production-promotion receipt implementation;
- GCP semantic project-amend relay;
- project-authoring recovery compatibility path;
- obsolete compatibility APIs.

## Required conformance scenarios

The focused kernel tests must prove:

1. worker dies before effect;
2. worker dies after provider mutation and before settlement;
3. provider timeout leaves mutation uncertain;
4. duplicate delivery with the same idempotency identity;
5. stale worker cannot settle after replacement;
6. source revision changes after intent creation;
7. evidence refers to another revision;
8. two workers race to claim;
9. provider confirms an already-applied effect;
10. database failure after provider mutation;
11. recovery with `may_have_mutated = true` is confirm-only;
12. authority epoch boundary rejects the old worker.

## Verification recorded before the worktree disappeared

- full maintained suite: 460 passed, 0 failed;
- focused kernel/provider/authoring suites: 35 passed;
- TypeScript typecheck passed;
- portable build passed;
- runtime build passed;
- `git diff --check` passed;
- PostgreSQL conformance reached the expected local database boundary but no PostgreSQL server was available;
- public-release verification hit environment/tooling `git ENOBUFS` while scanning full history.

## Metrics recorded before loss

Heuristic measurement script results:

| metric | before | after |
|---|---:|---:|
| production LoC | 22929 | 22261 |
| test LoC | 14105 | 12923 |
| lease implementations | 15 | 14 |
| recovery implementations | 22 | 22 |
| settlement implementations | 8 | 5 |
| mutation-certainty implementations | 51 | 43 |
| generic provider protocol implementations | 29 | 24 |
| compatibility modules | 3 | 1 |
| lifecycle models | 59 | 55 |

The lost tracked patch deleted 39 files and approximately 4,401 lines.

## Explicit remaining deletion ratchet

The provider-effect protocol was unified, but project.advance still had a separate long-lived `project_transition` lease and orchestration-owned requeue/settlement lifecycle.

Next work:

1. write failing tests for project-transition lease/settlement behavior;
2. bind project-transition execution identity, lease epoch, checkpoint, and settlement to the canonical transaction records;
3. retain authoritative graph projection as a projection, not a second effect-correctness protocol;
4. migrate orchestration finish/recovery to consume the canonical receipt;
5. delete duplicated `work_leases`, project-transition lease settlement, and obsolete execution-authority compatibility paths only after conformance passes;
6. commit each slice durably to this branch.

Do not add a permanent kernel-v2 facade beside the old lifecycle.

## Reconstruction status — 2026-09-13

The lost ephemeral implementation has been reconstructed on the durable branch. The source head immediately before this checkpoint refresh is `ccdf9fb09435c6a83a3d73eda87688ad5673ef55`; this document update is committed as the next durable slice.

Canonical source now present:

- `src/semantic/execution-transaction.ts`;
- `src/semantic/execution-transaction-runtime.ts`;
- `src/semantic/execution-transaction-store.ts`;
- `src/adapters/postgres/execution-transaction-store.ts`;
- `src/semantic/canonical-json.ts`;
- provider wrappers for deterministic work settlement, GitHub changesets, GitHub releases, portfolio reconciliation, production materialization/promotion, and project authoring;
- JavaScript runtime mirrors used by the maintained application.

Durable schema now includes migrations `060` through `064). Migrations `063` and `064` close two correctness gaps found during reconstruction: valid certainty resolution after provider readback, and exact settlement-request binding for project-transition receipts.

The project-transition ratchet has been partially migrated. Canonical `execution_state`, `operation_state`, and `proof_state` own transition identity, authority revision/epoch, lease epoch, heartbeat/checkpoint state, settlement receipt, and expiry classification. The legacy `work_leases` row and orchestration graph state remain projections/fallbacks in several paths. Canonical transition settlement is replayed before the legacy settlement ledger, and legacy settlement replay excludes project-transition projection rows. Expired uncertain transitions now produce confirm-only authority-reconciliation metadata.

The following remain intentionally retained until the conformance gates are demonstrated:

- `lib/work-leases.js` generic claim/settle/checkpoint/heartbeat/requeue lifecycle;
- the transition API and projection code in `lib/project-transition-leases.js`, `lib/project-transition-lease-store.js`, and stale reconciliation;
- orchestration finish and maintenance fallbacks in `lib/orchestration-finish-runtime.js` and `lib/orchestration-runs.js`;
- execution-authority and evidence readers that still fall back to legacy projection rows;
- provider-specific readback and conditional mutation in `lib/project-transition-authoritative-effect-github-runtime.js`;
- specialized journal resolution for release/template commands.

An explicit unresolved ratchet is expired `effect_uncertain` project-transition recovery: the canonical recovery record is produced and marked confirm-only, but the authoritative provider-confirmation path still requires an active executing child lease. This must be wired through canonical operation identity before deleting transition leases or any `work_leases` fallback.

Conformance coverage is present for all twelve required scenarios, including canonical settlement replay and transition settlement request binding. Current execution evidence is intentionally limited: the local exec server failed its initialization handshake, so no current-head test, typecheck, build, or PostgreSQL run is claimed. GitHub reported no workflow runs and no status checks for `ccdf9fb09435c6a83a3d73eda87688ad5673ef55`. The verification numbers in the earlier section are historical results from before the ephemeral worktree disappeared and must not be read as verification of this reconstructed head.

Next deletion opportunity: make canonical operation recovery resolve expired uncertain transition effects through a confirm-only provider readback transaction; then run the twelve scenarios against PostgreSQL and delete the transition `work_leases` projection/settlement and obsolete authority compatibility paths only when zero stale-worker settlement, zero ambiguous writers, exact revision/epoch fencing, deterministic expiry/recovery, durable receipt replay, safe requeue, and no blind retry after uncertainty are all proven.
