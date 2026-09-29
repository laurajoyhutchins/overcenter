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
verified tree
        |
exact-base integration
        |
integration evidence
```

If the source base has moved, the work returns for a new realization. If the integration outcome is ambiguous, the run moves to recovery instead of retrying the mutation blindly.

Verification binds the candidate to an exact base and tree. Integration uses that verified tree and an exact-base Git compare-and-swap; it does not trust a mutable worker branch.

## Proposal refs

A worker may prepare a revision descended from the claimed source SHA. `source-broker-ref` reads the final changed bytes from that revision, validates them against the task and claim, and publishes a canonical candidate.

The ref is only transport. The brokered candidate is the object that enters verification.

## Verification and integration evidence

`src/source/source-integration.ts` defines two additional records:

- `overcenter-source-verification/v1` records whether a specific candidate was verified against a specific base and, on success, the resulting tree.
- `overcenter-source-integration-evidence/v1` records the run, obligation key, source SHA, candidate SHA, verified tree, integration commit, and whether the commit was newly integrated or already present.

These records support settlement. They do not allow the worker to mark its own work complete.

See [operator commands](./operator-commands.md) for the `project.advance` and `project.submit` interface.
