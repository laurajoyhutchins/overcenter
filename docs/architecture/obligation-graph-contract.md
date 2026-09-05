# Obligation graph contract

Status: architecture contract, v1

Overcenter's project graph is a finite acyclic graph of **obligations**, not a mutable task-state database. The existing public term **transition** remains valid: a transition is the logical project obligation and the bounded verified state change that satisfies it. This contract makes the underlying semantics explicit so graph identity, evidence reuse, amendments, and concurrent execution can evolve without mixing desired state with runtime bookkeeping.

## Decision

The canonical model has four layers:

```text
repository-owned obligation graph
            |
            v
realizations + verification evidence
            |
            v
live execution authority / coordination
            |
            v
derived READY / EXECUTING / WAITING / BLOCKED / SATISFIED view
```

Only the first layer defines project intent. Evidence records historical facts about exact coordinates. Leases and fencing control who may act now. Current lifecycle labels are deterministic projections over those facts and current authority.

This follows four research results:

- Petri/workflow-net theory: retain the current finite acyclic `all-of` dependency model. Fan-out is AND-split, fan-in is AND-join, independent obligations are concurrent, and completion grows monotonically. Do not introduce general token accounting, implicit XOR/OR routing, or loops merely because general Petri nets support them.
- Bazel/Nix: model a node as an immutable obligation over exact inputs, required outcomes, and verification rather than trusting remembered execution history. A realization can come from an agent, deterministic operator, human action, or already-correct authoritative state.
- CALM: preserve coordinate-scoped historical facts monotonically and derive "current" state. READY, current DONE/SATISFIED, lease validity, and current head are projections or coordination decisions, not timeless facts.
- FoundationDB: bind execution to the exact semantic facts it depended on and validate those dependencies at settlement. A global repository revision change is not by itself evidence that unrelated in-flight work became invalid.

Research source documents:

- `laurajoyhutchins/overcenter-research/research/petri-nets-workflow-correctness.md`
- `laurajoyhutchins/overcenter-research/research/bazel-nix-graph-derivation.md`
- `laurajoyhutchins/overcenter-research/research/calm-monotonic-state.md`
- `laurajoyhutchins/overcenter-research/research/foundationdb-transaction-semantics.md`

## Identity model

Three identities must not be conflated.

### Logical key

`transition.id` is the stable project-level key used to refer to an obligation across graph versions.

It answers: **which project obligation are we talking about?**

It is intentionally separate from content identity. An amendment may preserve the logical key while changing what that obligation means.

### Obligation semantic content

`projectObligationSemanticInput()` selects the current v1 fields that determine the obligation's semantic contract:

- `requires`: causal prerequisites, with pure `all-of` meaning;
- `executor`: the declared execution contract;
- `version_impact`: the repository-owned effect classification consumed by release semantics;
- `phase_bindings`: the deterministic acquire/commit/confirm bindings, including evidence semantics.

The logical key is not part of this content payload. Two logical obligations may currently have identical semantic content. The next identity layer binds content to logical keys when constructing graph identity.

`priority` is deliberately not obligation semantic content. It is a selection preference among simultaneously executable obligations. Changing priority changes the repository definition revision and may change which READY obligation a dispatcher prefers, but it does not change the obligation, its prerequisites, or the evidence required to satisfy it.

### Graph semantic content

`projectObligationGraphSemanticInput()` binds every stable logical key to its obligation semantic content and sorts the resulting set deterministically.

It deliberately excludes:

- repository/project location;
- exact Git revision;
- derivation provenance;
- transition ordering in JSON;
- dependency ordering;
- priority;
- lifecycle and current status;
- leases, run IDs, timestamps, evidence instances, and receipts.

The content-addressing workstream may hash this semantic input. Git authority remains separate provenance. Therefore the same semantic graph derived at two different Git revisions can have the same semantic fingerprint while still being two different authority observations.

## Runtime fields are not graph identity

The following classes of data must never enter obligation semantic identity:

- `lifecycle`, current `state`, and `unmet_requirements`;
- `lease_ref`, lease expiry, fencing epoch, run/session identity;
- evidence instances and receipts;
- observation timestamps;
- mutable provider status.

They answer what is happening or known **now**, not what the obligation **means**.

Putting them into semantic identity would create a self-invalidating graph where executing an obligation changes the identity of the obligation being executed.

## Satisfaction invariant

For the current all-of DAG, a valid satisfied set `D` is predecessor closed:

```text
x in D  =>  requires*(x) is a subset of D
```

The executable contract checks the direct form for every satisfied obligation. Because every satisfied predecessor is checked by the same rule, direct predecessor closure implies transitive predecessor closure.

A state such as:

```text
A -> B -> C
satisfied = {A, C}
```

is impossible under the authoritative graph and must fail closed rather than be reconciled heuristically.

This is the Overcenter-specialized reachability invariant identified by the Petri-net research.

## Historical truth and current projection

A historical completion claim must be attributable to an exact authority coordinate:

```text
kind = github
repository = owner/repo
revision = exact 40-character Git commit
derivation = named graph derivation contract
```

A later amendment does not erase that historical claim. Instead, the current graph projection decides whether the old realization/evidence still satisfies the obligation semantics now in force.

This preserves the CALM distinction:

```text
monotonic fact:
  evidence E proved obligation semantics O at authority coordinate A

non-monotonic projection:
  logical obligation B is SATISFIED in the current graph
```

## Execution authority is separate

A lease authorizes an execution attempt against an exact observed obligation/dependency contract. It is not stored in the graph definition and does not mutate obligation identity.

This separation is necessary for concurrent `project.amend`: publishing a new graph meaning cannot retroactively rewrite the contract under which another worker was validly authorized. Later work in this workstream will classify whether an in-flight authority is unaffected, semantically compatible, or conflicting with the amendment.

## Outcome Integrity is a separate contract

The term **semantic content** in this document is identity terminology. It does not mean that a structurally valid obligation graph is sufficient to accomplish the intended project outcome.

A finite acyclic all-of DAG may execute every obligation correctly and still omit required work, depend on a hidden assumption, use evidence that does not establish the intended claim, or compose locally correct obligations into an insufficient plan.

Outcome Integrity is the separate revision-bound, read-only assurance layer defined in `docs/architecture/outcome-integrity.md`. It asks whether authoritative obligations, assumptions, argument steps, and evidence collectively establish the intended outcome.

Outcome Integrity does not:

- enter obligation semantic identity merely because a review mentions a claim;
- replace exact Git authority or graph provenance;
- create a new transition lifecycle state;
- authorize repository or provider mutation;
- create a shadow plan database or duplicate evidence store.

Reasoning-agent findings and defeaters are non-authoritative analysis. An accepted repair becomes project truth only through the existing project-authoring boundary and fresh authoritative readback.

## Compatibility with existing Overcenter contracts

This is an additive semantic clarification, not a wholesale storage migration.

- Repository-owned project definitions remain authoritative desired state.
- `transition.id` remains the stable logical key used by current commands and graph APIs.
- Existing transition revision/dependency fingerprint machinery remains the implementation substrate to extend rather than replace.
- `ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM` remains the execution lifecycle, but lifecycle state is not obligation identity.
- Git repository + exact revision + derivation remain source provenance and authority fencing even when a future semantic fingerprint is unchanged across revisions.

The next implementation slice may content-address the graph and obligation semantic inputs defined here. It must not weaken the exact-authority or lease/fencing contracts in order to do so.
