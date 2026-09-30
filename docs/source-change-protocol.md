# Source-change protocol

Overcenter treats a source change as a controlled repository transaction. A worker may propose file contents, but it does not choose its own write scope or decide that the change has been integrated successfully.

## Versioned records

`src/source/source-obligation.ts` defines the source records; transaction metadata uses stable names with explicit schema versions:

| Record | Purpose |
| --- | --- |
| `overcenter-source-task/v1` | Objective, exact writable paths for this source transaction, effect contract, optional acceptance predicate, and task context. |
| `overcenter-source-transaction` (version 1) | Repository/runtime identity, exact claim and execution authorization, observed candidate tree/delta, expected writes and assurance plan. |
| `overcenter-source-assignment/v1` | Binds a source task to one obligation and one claim. |
| `overcenter-source-proposal/v1` | Contains the file contents or deletions proposed by the worker. |
| `overcenter-source-candidate/v1` | Records the canonical candidate produced by the trusted broker. |

Source tasks are persisted in authority history, so these schemas are part of the replay contract. Incompatible changes require either a migration or a new versioned discriminator.

## Write scope

For the MVP, each source task's `writable_paths` is both the authorized set and the exact expected write set. A candidate that omits one of those paths or changes any additional path is rejected before proof admission.

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

## Proposal transport

A worker returns a bounded `SourceProposal` containing the final bytes for the task's declared writable paths and bound to the exact run, claim, and source SHA. The broker validates that proposal and materializes a canonical one-parent candidate. Arbitrary worker Git revisions are not an accepted broker ingress.

The proposal is only transport. The brokered candidate is the object that enters verification.

## Verification and integration evidence

`src/source/source-integration.ts` defines two additional records:

- `overcenter-source-verification` version 2 is the external proof record. It binds the candidate/base/tree, runtime, transaction digest, baseline and exact provider workflow attempt, and is admitted only after independent provider observation.
- `overcenter-source-verification/v1` is the internal integration verification minted only from an admitted positive proof.
- `overcenter-source-integration-evidence/v1` remains the settlement witness consumed by the existing source-integration kernel.

These records support settlement. They do not allow the worker to mark its own work complete.

See [operator commands](./operator-commands.md) for the `project.advance` and `project.submit` interface.
