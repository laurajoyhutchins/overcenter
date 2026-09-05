# Work-surface convergence

**Status:** Accepted design decision. The project graph tracks implementation work for this contract; current runtime behavior remains defined by executable command contracts and source.

## Purpose

Overcenter must keep external work surfaces aligned with authoritative project truth without turning those surfaces into project authority.

GitHub issues and pull requests are useful projections, candidates, and provider-owned objects. They may represent or carry work, but they do not define project transitions, completion, execution authority, or settlement truth. Conversely, a completed project transition is not sufficient by itself to mutate an arbitrary GitHub issue or pull request. Overcenter needs an explicit, mechanically provable relationship between project truth and the exact provider object before it may retire that object.

The required invariant is:

> Every Overcenter-managed work artifact that is no longer actionable must become either mechanically retired from exact authoritative evidence or explicitly classified as requiring judgment. Stale open artifacts must not silently accumulate outside project health.

This is a convergence problem, not a second planner.

## Authority model

- **GitHub** remains authoritative for GitHub-native object identity and current state: repository, issue number, pull-request number, refs, exact heads/bases, open/closed state, merge state, checks, and provider readback.
- **Repository-owned project definition** remains authoritative for transition identity, dependency structure, executor intent, and desired verified state.
- **Overcenter** remains authoritative for runs, leases, semantic command/operation identity, settlements, receipts, mutation certainty, recovery state, and any durable relationship it creates between an Overcenter semantic operation and a provider artifact.
- **Issue and pull-request prose is never authority** for project definition, transition completion, or artifact retirement. Prose may provide context for a reasoning agent only after the deterministic layer has exhausted mechanically provable relationships.

Projection repair must flow from authority to projection, never the reverse.

## Artifact relationship

Overcenter must be able to reconstruct, without chat history, which semantic work produced or is represented by an Overcenter-managed GitHub artifact.

For artifacts created by Overcenter, the relationship should be derivable from existing durable facts wherever possible. Relevant coordinates include:

- `project_ref`;
- `transition_id` when the artifact represents one transition;
- semantic command/operation identity and idempotency identity;
- repository identity;
- provider object kind and numeric identity;
- exact candidate head and base identity where applicable;
- exact authority revision against which the candidate was produced;
- settlement or integration evidence that establishes later completion or supersession.

Do not create a parallel artifact database merely for convenience. Add new durable relationship state only when the relationship cannot be safely reconstructed from existing operation, integration, receipt, branch, idempotency, project-definition, and settlement facts.

## Canonical classifications

Every observed artifact in the bounded project work surface is classified into exactly one of these states.

| Classification | Meaning | Automatic retirement |
| --- | --- | --- |
| `active` | The artifact still represents current incomplete work, a current candidate, or unresolved judgment. | No |
| `satisfied` | An explicitly bound semantic obligation is durably completed and the artifact has no remaining independent action. | Yes, only when the binding is exact and policy allows it |
| `superseded` | A newer exact artifact or authoritative candidate has replaced this artifact for the same semantic obligation or idempotent operation. | Yes, when supersession identity is mechanically proven |
| `orphaned` | An Overcenter-created artifact is no longer referenced by current authoritative project truth or live execution authority and no valid continuation can still use it. | Yes, only for Overcenter-owned artifacts with exact provenance |
| `ambiguous` | Overcenter cannot mechanically prove whether the artifact is still actionable, satisfied, or superseded. | No; surface as judgment-required |

Unknown or unavailable provider observations produce `ambiguous`, never optimistic retirement.

## Safe-retirement rules

Automatic retirement is allowed only when all required identity and authority checks succeed at the effect boundary.

At minimum, Overcenter must prove:

1. the exact repository and provider object identity;
2. the artifact's current authoritative provider state;
3. the artifact's exact semantic relationship to the project or operation;
4. the evidence that makes the artifact `satisfied`, `superseded`, or `orphaned`;
5. absence of conflicting live execution authority;
6. that the intended close applies to the same identity that was classified;
7. fresh authoritative readback after the close.

If any identity, authority observation, or mutation result is ambiguous, fail closed. Do not blind-retry an indeterminate close.

Human-authored issues are intentionally more conservative than Overcenter-created candidates. An issue may be automatically closed only when it carries an explicit machine-readable binding that proves the entire issue corresponds to the completed obligation. Similar prose, matching titles, labels, or inferred intent are insufficient.

## Diagnosis belongs in project health

`project.inspect` should expose a bounded work-surface convergence summary alongside project execution truth. This does not change READY/DONE semantics; it reports projection drift.

The diagnostic should include at least:

```text
work_surface:
  active: [...]
  safely_retirable: [...]
  ambiguous: [...]
  counts: {...}
```

Each item should include the exact provider ref and the classification evidence needed to understand why it is active, safe to retire, or ambiguous. Large repositories may return bounded details plus counts/cursors rather than an unbounded object dump.

A healthy graph with many safely-retirable open artifacts is not fully converged. Project health should make that visible.

## Intent-first convergence operator

The preferred project-level interface is an intent-only semantic command such as:

```text
project.reconcile_work_surface({ project_ref })
```

The caller does not choose issue numbers, pull-request numbers, branches, candidate SHAs, close reasons, or other mechanical coordinates. Overcenter derives them from current authoritative project truth and exact provider observations.

The operator should:

1. read the current authoritative project graph and completed transition evidence;
2. reconstruct Overcenter-managed artifact relationships and current provider state;
3. classify artifacts deterministically;
4. execute exact retirement primitives only for mechanically safe artifacts;
5. preserve mutation certainty and reconcile indeterminate provider effects by authoritative readback;
6. leave ambiguous artifacts untouched and return them as judgment-required;
7. reread provider and project state and return a bounded convergence receipt.

Repeated execution is idempotent. An already-converged project is a confirmed no-op.

## Provider-effect primitives

Project-level convergence should compose narrow provider-effect commands rather than teach agents to mutate GitHub directly. The command surface should include exact, idempotent retirement operations for pull requests and issues, for example:

- `github.pull_request.close`
- `github.issue.close`

The exact names may follow established command naming conventions, but the primitives must remain narrow. They are not generic issue editors. The project-level operator decides whether closure is semantically authorized; the provider primitive owns exact provider identity, mutation certainty, and authoritative readback.

## Candidate lifecycle

Project authoring and other Overcenter operations that create pull-request candidates must treat candidate lifecycle as a complete state machine, not only a creation path.

A candidate may become:

- current and active;
- integrated;
- superseded by a newer exact candidate;
- orphaned after authority changes or an abandoned attempt;
- ambiguous after an indeterminate provider effect.

Supersession must be explicit or mechanically derivable. A newer candidate for the same semantic obligation is not enough by title alone.

A semantic no-op must not create a candidate at all. In particular, `project.amend` must return a confirmed no-op when the canonical candidate definition equals the current authoritative definition. Creating a zero-change branch or pull request is a contract failure because it manufactures projection residue without changing desired state.

## Historical backfill

Existing Overcenter repositories may contain stale artifacts created before this contract.

Backfill may infer relationships only from durable facts that were already authoritative or mechanically bound at the time, including exact branch/head/base identities, Overcenter operation/idempotency records, integration receipts, project definitions, and settlements. Do not infer semantic ownership from prose similarity.

Historical objects that cannot be proven safe become `ambiguous` and remain open until a reasoning agent or operator resolves them.

## Acceptance examples

The implementation must cover at least these cases:

- an empty or idempotent `project.amend` produces no branch, commit, or pull request;
- an older project-authoring PR is classified `superseded` by an exact newer candidate for the same semantic operation and may be closed safely;
- an explicitly machine-bound issue whose entire transition is durably completed is `satisfied`;
- a human-authored issue that merely appears related to completed work is `ambiguous` and is not closed;
- a temporary Overcenter verification PR with exact provenance and no live/authoritative continuation is `orphaned`;
- provider state changes after classification cause the retirement attempt to fail closed or recompute;
- transport loss after a close is reconciled by authoritative provider readback rather than blind retry;
- `project.inspect` reports remaining safe residue and ambiguity even when the transition graph itself is healthy;
- `project.reconcile_work_surface({ project_ref })` converges safe residue and leaves only genuinely active or judgment-required artifacts.

## Non-goals

This contract does not:

- make GitHub issues or pull requests project authority;
- require every human issue to map one-to-one to a project transition;
- introduce a second backlog or planner inside Overcenter;
- allow heuristics to close ambiguous human work;
- make projection cleanliness a prerequisite for transition settlement;
- duplicate GitHub object state in Overcenter when fresh provider observation is available.

The goal is narrower: authoritative project truth should have a deterministic, safe path to a converged external work surface, and any residue that cannot be repaired automatically must be visible rather than forgotten.
