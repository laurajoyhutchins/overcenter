# GitHub Integration Convergence

## Objective

Make `github.integration.reconcile` a durable convergence operation rather than a one-shot command that requires an agent to notice each deterministic state change and invoke it again.

The invariant is:

> Once an exact-head integration intent is accepted, deterministic software owns refresh, waiting, recomputation, exact-head merge submission, and merge confirmation until the operation either settles or reaches a condition that requires judgment.

## Existing machinery to reuse

- `reconcileGithubIntegration` remains the semantic GitHub integration decision engine.
- `operation_state` remains the durable transaction/recovery store through `createCompactProviderOperationPostgresStore`.
- `orchestration.maintain` remains the bounded deterministic reconciliation loop through its existing `compactRecoveries` hook.
- `github-branch-role-runtime` remains the repository branch-role fence.
- The GCP worker-command surface remains the authoritative execution path.

No second scheduler, integration table, or agent-managed retry protocol is introduced.

## Durable intent

Starting `github.integration.reconcile` with an exact head creates or resumes an internal compact operation keyed by repository, pull request, and the initially accepted exact head. The recovery payload records:

- initial accepted head
- current accepted head
- latest observed base coordinate
- merge request UUID when one exists
- current waiting reasons
- last reconciliation result
- whether Overcenter has already attempted an external mutation

A head produced by Overcenter's own exact-head `update-branch` action becomes the next accepted head. An unexpected head change that is not the result of that transaction is not silently adopted.

## Reconciliation state machine

Each convergence pass runs as far as safely possible:

1. Re-read the exact pull request and branch-policy evidence.
2. If the base moved and the standalone branch is safely refreshable, call exact-head `update-branch`, authoritatively re-read the new head/base coordinate, persist the new accepted head, and return to waiting.
3. If required checks or mergeability are still pending, persist waiting state without mutation.
4. If a required check has failed, the PR has changes requested, a conflict exists, a stacked PR requires cascading rebase, policy is ambiguous, or the head changed unexpectedly, settle as `requires_judgment` rather than retrying blindly.
5. If all deterministic gates pass, submit the exact-head squash merge.
6. If GitHub reports an asynchronous merge request, persist its UUID and reconcile it on later maintenance passes.
7. Once GitHub authoritatively reports the PR merged, settle the compact operation with a durable resolution.

Mutation uncertainty continues to fail closed through the existing GitHub integration semantics. The convergence layer does not reinterpret an indeterminate external effect as safe to retry.

## Wake-up model

`orchestration.maintain` discovers pending integration convergence operations through the existing compact-recovery interface and advances them. GitHub events may later be added as latency optimizations, but correctness does not depend on receiving a webhook or on an agent polling the PR.

## Semantic surface

`github.integration.reconcile` is admitted through the worker-command/GCP semantic ingress with these caller fields:

- `repo`
- `pull_request`
- `expected_head`
- optional `run_id`

The caller supplies the initial exact head but does not supply refreshed heads, check lists, base SHAs, retry counters, merge UUIDs, or recovery recipes. Those are deterministic runtime state.

The existing direct API route remains a compatibility surface; new authoritative execution is through the GCP worker command.

## Testing

Tests must prove:

- exact-head intent creation is replay-safe;
- a safe branch refresh advances the accepted head and remains pending;
- pending checks do not mutate;
- a second base movement is refreshed without caller intervention;
- failed required checks, changes requested, conflicts, stacked rebase requirements, and unexpected head movement become `requires_judgment`;
- merge submission stores the async merge UUID and later maintenance confirms settlement;
- `orchestration.maintain` discovers and advances pending integration operations;
- GCP semantic ingress admits and validates the command;
- no caller-provided continuation/recovery bookkeeping is added.
