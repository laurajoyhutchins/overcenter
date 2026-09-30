# Source-change protocol

Overcenter treats a source change as a controlled repository transaction. A worker may propose file contents, but it does not choose its own write scope or decide that the change has been integrated successfully.

## Versioned records

`src/source/source-obligation.ts` defines four versioned records:

| Record | Purpose |
| --- | --- |
| `overcenter-source-task/v1` | Objective, writable paths, effect contract, optional acceptance predicate, and task context. |
| `overcenter-source-assignment/v1` | Binds a source task to one obligation and one claim. |
| `overcenter-source-proposal/v1` | Contains the file contents or deletions proposed by the worker. |
| `overcenter-source-candidate/v1` | Records the canonical candidate produced by the trusted broker. |

Source tasks are persisted in authority history, so these schemas are part of the replay contract. Incompatible changes require either a migration or a new versioned discriminator.

## Write scope

Each source task lists the exact repository-relative paths that may change.

The broker rejects malformed or absolute paths, duplicates, files outside the declared write set, `.git`, `.overcenter/**`, and `.github/**`.

The worker can choose the contents of an allowed change. It cannot enlarge the allowed change itself.

## Lifecycle

```text
authoritative source SHA
        |
source task + claim
        |
worker proposal
        |
trusted source broker
        |
canonical candidate
        |
read-only verification
        |
verified tree + source effect identity
        |
generic effect reservation
        |
exact-base integration adapter
        |
authoritative source readback
        |
generic observation settlement
```

If the source base has moved, the work returns for a new realization. If the integration outcome is ambiguous, the run moves to recovery instead of retrying the mutation blindly.

Verification binds the candidate to an exact base and tree. Integration uses that verified tree and an exact-base Git compare-and-swap; it does not trust a mutable worker branch.

## Proposal transport

A worker returns a bounded `SourceProposal` containing the final bytes for the task's declared writable paths and bound to the exact run, claim, and source SHA. The broker validates that proposal and materializes a canonical one-parent candidate. Arbitrary worker Git revisions are not an accepted broker ingress.

The proposal is only transport. The brokered candidate is the object that enters verification.

## Verification and settlement evidence

`src/source/source-integration.ts` defines the source-specific data consumed by the generic effect lifecycle:

- `overcenter-source-verification/v1` records whether a specific candidate was verified against a specific base and, on success, the resulting tree.
- `overcenter-source-integration-effect/v1` binds the run, obligation key, source SHA, candidate SHA, verification base, verified tree, exact integration commit, and target ref as the identity of one repository effect attempt.

The generic effect reservation durably stores that identity before mutation. Source integration then performs only the exact-base ref CAS. Authoritative readback emits an ordinary `source-integration/v1` observation bound to the reservation's identity digest, and the generic observation receipt decides DONE versus RECOVERY_REQUIRED. There is no separate source settlement or source-retry receipt protocol.

A pre-effect verification or stale-base rejection may return the work to READY only while no unresolved effect exists. Once a reservation exists, replay is forbidden until authoritative observation resolves that exact reserved identity.

See [operator commands](./operator-commands.md) for the `project.advance` and `project.submit` interface.
