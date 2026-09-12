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
