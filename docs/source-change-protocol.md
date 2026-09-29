# Source-change protocol

Source modification is an authority-bearing transaction, not a worker-owned checkout operation.

The protocol keeps reasoning about what to change separate from deterministic control of what may be written, what candidate was verified, and what exact source revision may be integrated.

## Durable shapes

`src/source/source-obligation.ts` defines four versioned shapes:

| Shape | Purpose |
| --- | --- |
| `overcenter-source-task/v1` | Trusted objective, exact writable paths, effect contract, optional acceptance predicate, and bounded context. |
| `overcenter-source-assignment/v1` | Binds one task to an authoritative obligation and claim. |
| `overcenter-source-proposal/v1` | Worker proposal containing only the requested file bytes or deletions. |
| `overcenter-source-candidate/v1` | Trusted broker result bound to obligation key, run, claimed revision, claimed source SHA, and candidate commit. |

Source task definitions are persisted inside authority history. Their schema identifiers and semantics are replay protocol. Refactors may replace implementation machinery, but incompatible changes require an explicit migration or a new discriminator.

## Writable scope

A source task declares exact repository-relative writable paths.

The source broker rejects:

- absolute or malformed paths;
- duplicate paths;
- paths outside the task's writable set;
- `.git`;
- the Overcenter control plane under `.overcenter/**`;
- GitHub control-plane files under `.github/**`.

A reasoning worker therefore proposes content. It does not widen its own write authority.

## Transaction lifecycle

```text
authoritative source SHA
        |
        v
source task + claim
        |
        v
worker proposal
        |
        v
trusted source broker
  validate scope + exact claim
  materialize canonical candidate
        |
        v
read-only candidate verification
        |
        v
verified tree
        |
        v
fresh authority reconstruction
        |
        v
exact-base source integration CAS
        |
        +-- base moved --> REREALIZE_REQUIRED
        +-- ambiguous --> RECOVERY_REQUIRED
        |
        v
trusted integration evidence
```

The candidate commit is not project truth merely because it exists. Verification binds the candidate, base, and resulting tree. Integration reconstructs the verified tree and attempts an exact-base Git update rather than trusting a mutable worker branch.

## Proposal refs

A worker may prepare a revision descended from the claimed source SHA. `source-broker-ref` reads that revision, derives its final changed file bytes, validates those bytes against the authoritative task and claim, and publishes a canonical candidate owned by the trusted broker.

The proposal ref is transport. It is not authority.

## Verification and integration evidence

`src/source/source-integration.ts` defines:

- `overcenter-source-verification/v1`, which records whether one exact candidate was verified against one exact base and, when verified, the resulting tree;
- `overcenter-source-integration-evidence/v1`, which binds the run, obligation key, source SHA, candidate SHA, verified tree, integration commit, and whether integration was newly performed or already present.

These records support settlement, but they do not let a worker declare success. The ordinary authority and observation rules still determine whether the corresponding obligation becomes `DONE`.

See [operator commands](./operator-commands.md) for the agent-facing `project.advance` / `project.submit` surface.
