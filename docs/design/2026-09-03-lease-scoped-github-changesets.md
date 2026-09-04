# Lease-Scoped GitHub Changesets Design

> **Document status: Proposed design for review.** This document defines the intended authority boundary for repository mutation performed under a graph-native project-transition lease. Current runtime source remains authoritative until implementation and verification complete.

Trigger: issue #274 dogfood exposed an executor-authority gap while implementing `ignore-stale-historical-project-transition-leases` at exact repository authority `9c33d90c0a9229ecef6f8b7dc80f7355f8bb81fb`.

## Decision

When `github.apply_changeset` is invoked with a graph-native project-transition `lease_ref`, the lease is the complete caller-visible authority for repository placement and mutation fencing.

The caller supplies mutation intent only:

```json
{
  "lease_ref": "<project-transition-lease>",
  "changes": ["..."],
  "commit_message": "..."
}
```

Overcenter derives the repository, managed execution workspace, exact starting authority, current workspace head, expected-head compare-and-swap precondition, and idempotency scope.

The caller must not choose or supply `repo`, `branch`, `base_ref`, `base_sha`, `expected_head`, `idempotency_key`, or `lease_token` in lease-scoped mode. Supplying any of those fields is a contract error rather than an override.

The existing explicit changeset mode remains available for callers that are intentionally using the lower-level Git primitive without a project-transition lease.

## Why this boundary

`project.advance` already returns the durable transition assignment, `lease_ref`, transition-definition fingerprint, and exact project authority. It should not grow Git workspace coordinates merely because the current changeset primitive requires them.

Branch names, base selection, expected-head bookkeeping, and mutation idempotency are deterministic execution mechanics. Requiring an agent to choose them would move execution correctness back into prompts and make the project-transition lease an incomplete capability.

The desired invariant is:

> A valid project-transition lease is sufficient authority to invoke every repository mutation permitted by that transition without inventing repository execution coordinates.

This keeps the agent-facing model centered on judgment and changeset intent while preserving exact Git fencing underneath.

## Two mutually exclusive request modes

### Explicit Git mode

The existing contract remains conceptually unchanged:

```text
github.apply_changeset({
  repo,
  branch,
  base_ref | base_sha,
  expected_head?,
  changes,
  commit_message,
  idempotency_key?,
  lease_token?
})
```

This mode exposes Git mechanics deliberately and remains useful for lower-level operators and compatibility paths.

### Lease-scoped project-transition mode

```text
github.apply_changeset({
  lease_ref,
  changes,
  commit_message
})
```

This mode is accepted only when `lease_ref` resolves to an active graph-native `project_transition` authority. Legacy work leases do not gain implicit workspace semantics through this design; they continue to use the explicit mode until separately migrated or deleted.

The two modes must not be mixed. In particular, lease-scoped requests fail closed if they also contain explicit repository, branch, base, head, idempotency, or token coordinates.

## Authority resolution

Before any Git mutation, Overcenter resolves `lease_ref` through the execution-authority service and requires all current project-transition checks to pass:

- the durable lease exists and is active;
- the associated run and project-transition authority are still valid;
- repository identity is taken from the lease subject;
- project and transition identity still match the authoritative graph;
- graph and transition fingerprints remain consistent;
- the issued authority epoch equals the current authority epoch;
- any stale project-transition authority is rejected before mutation.

Lease-scoped changesets do not accept a caller-provided repository even as a hint. The authoritative repository is the one proven by the lease.

### Authority API adjustment

The current execution-authority `require` path expects a caller-provided repository so it can compare that repository with the lease subject. Lease-scoped mode must not satisfy that requirement by making the agent supply `repo`, nor should the changeset adapter read `work_leases` directly and recreate authority validation.

The execution-authority layer therefore needs a graph-native subject-derived entry point, conceptually:

```text
requireProjectTransition({ lease_ref })
  -> {
       lease_ref,
       run_id,
       repository,
       project_ref,
       transition_id,
       authority_epoch,
       authority,
       graph_fingerprint,
       transition_definition_fingerprint
     }
```

That operation performs the same active-lease, graph, fingerprint, epoch, and stale-authority verification as the existing project-transition path, but derives repository identity from the verified lease subject instead of comparing it with caller input.

Existing explicit mutation paths may continue using repository-scoped authority checks. There must be one underlying project-transition verification implementation so the two entry points cannot drift.

## Managed workspace generation

A managed execution workspace is deterministic kernel state. It is not selected by the agent and is not part of `project.advance`'s public assignment contract.

The workspace generation identity is derived from:

```text
repository
project_ref
transition_id
transition_definition_fingerprint
authority.revision
```

This gives the following semantics:

- requeue and reacquisition of the same transition definition at the same exact authority revision reuse the same workspace generation;
- a changed transition definition produces a new workspace generation;
- a changed exact project authority revision produces a new workspace generation;
- an old generation remains historical evidence and is never silently treated as current execution authority.

The first implementation should not automatically rebase or transplant an old workspace across a changed authority revision. Preserving useful work across changed authority is a separate reconciliation problem and should remain fail-closed until its safety rule is explicit.

## Managed branch identity

Git remains the implementation substrate, so the first implementation may materialize a managed workspace as an ordinary work branch. The branch is an internal coordinate, not caller authority.

Use a deterministic branch namespace:

```text
work/<transition-slug>-<workspace-digest-prefix>
```

where the digest is derived from the workspace generation identity. Branch construction must be deterministic, bounded to Git's branch-name limits, and collision-resistant.

`work` becomes a recognized work-branch type in branch policy specifically for Overcenter-managed execution workspaces. Human-selected semantic branch types such as `fix/`, `feat/`, or `docs/` remain valid for explicit Git mode, but Overcenter must not guess one of those semantic categories on behalf of a leased executor.

Managed workspace branches remain ordinary work targets. They may never resolve to the managed development or production branch.

## Base and head derivation

For a new workspace generation:

1. Resolve the lease's exact `authority.revision` as the immutable starting commit.
2. Require that revision to belong to the authorized repository.
3. If the deterministic workspace branch does not exist, use that exact revision as `base_sha` and create the branch only through the existing changeset transaction path.
4. If the workspace branch already exists, read its exact current head and use that as `expected_head`.

For an existing workspace generation, the current workspace head is mutable execution state. It is not interchangeable with the immutable project authority revision.

```text
project authority revision
    immutable generation base

workspace head
    mutable implementation state
```

Every changeset performs compare-and-swap against the workspace head observed for that request. Concurrent mutation of the same managed workspace therefore produces the existing `HEAD_MISMATCH` or branch-creation-race behavior rather than lost updates.

The resolved low-level request may always carry the exact generation base as `base_sha`; when the workspace branch already exists, the existing changeset engine uses the branch head as the parent and the derived `expected_head` as the CAS fence.

## Derived idempotency

Lease-scoped mode derives its idempotency key mechanically. The agent does not provide one.

The semantic identity binds:

```text
lease_ref
workspace generation identity
observed workspace head (or absent-head sentinel)
canonical changeset intent
commit message
```

An exact replay of the same mutation intent against the same observed workspace state therefore maps to the same durable changeset receipt. A subsequent distinct write after the workspace head advances maps to a new idempotency identity.

This supports iterative TDD within one lease while preserving safe replay of an interrupted or ambiguously returned changeset attempt.

A new lease acquired after requeue receives new execution authority and therefore a new mutation idempotency scope even when it resolves to the same workspace generation. The executor must begin from authoritative workspace readback; it must not use reacquisition as permission to replay an unresolved ambiguous mutation from the previous lease.

## Data flow

```text
project.advance
    |
    v
AGENT_EXECUTION_REQUIRED
  lease_ref
  transition
  authority
    |
    | agent decides code/test change
    v
github.apply_changeset
  lease_ref + changes + message
    |
    v
subject-derived execution authority validation
    |
    v
workspace generation derivation
    |
    +--> repository
    +--> deterministic work branch
    +--> exact authority base
    +--> current workspace head
    +--> idempotency identity
    |
    v
existing github changeset engine
    |
    v
Git CAS + readback + durable receipt
```

The existing low-level changeset engine remains responsible for Git tree/commit creation, expected-head fencing, branch-creation races, mutation certainty, readback reconciliation, and durable changeset receipts. Lease scoping is an authority-and-coordinate resolution layer above it, not a second Git implementation.

## Receipt contract

A successful lease-scoped changeset receipt should retain the ordinary Git evidence and add enough derived execution evidence to explain how the mutation was authorized without making those coordinates caller inputs.

At minimum record:

- `lease_ref` and resolved project-transition execution authority;
- workspace generation identity or digest;
- derived repository;
- derived managed branch;
- generation base authority revision;
- old workspace head, if any;
- new workspace head / commit SHA;
- whether the branch was created or reused;
- derived idempotency identity;
- exact changed paths;
- idempotent replay status.

The branch may appear in receipts and diagnostics as evidence. That does not make it part of the agent's authority-selection contract.

## Failure semantics

Lease-scoped mode must fail before mutation when:

- the lease is absent, inactive, expired, settled, stale, or unknown;
- the lease does not represent a graph-native `project_transition`;
- the transition authority epoch, project identity, repository, graph fingerprint, or transition fingerprint no longer verifies;
- the request mixes lease-scoped and explicit Git coordinates;
- the exact authority revision cannot be resolved in the authorized repository;
- the deterministic workspace identity cannot be derived safely;
- branch-role policy would map the workspace onto development or production;
- the workspace head changed after preflight.

Existing mutation-certainty rules continue to apply once Git mutation begins. An ambiguous external mutation is never retried as a new intent. Exact replay uses the derived idempotency identity and existing receipt/reconciliation behavior.

## Requeue and resume semantics

Settling an agent lease as `requeue` does not delete the managed workspace. If the transition is reacquired with the same transition-definition fingerprint and exact authority revision, the new lease resolves to the same workspace generation and continues from its current head.

The new lease still receives a fresh execution-authority validation. Workspace persistence therefore preserves implementation progress without preserving stale lease authority.

If the project authority revision or transition definition changes, reacquisition resolves to a different workspace generation. The old branch remains historical evidence and cannot be mutated through the new lease unless a future explicit reconciliation operation adopts its work.

## Concurrency properties

This design composes the existing project-transition exclusivity with Git compare-and-swap:

- two agents cannot simultaneously hold valid authority for the same project transition;
- different transitions receive different deterministic workspace generations even when they share a repository;
- concurrent mutations accidentally aimed at the same workspace are fenced by expected-head comparison;
- stale lease holders are rejected by execution-authority validation before the ref update;
- authority revision changes cannot silently retarget an existing workspace generation.

This design does not attempt to prevent two independent transitions from making conflicting changes on separate branches. Integration conflict detection belongs to later project transitions and repository integration semantics.

## Compatibility and migration

The implementation should preserve explicit Git mode first. Existing internal callers that provide `repo`, `branch`, and base/head coordinates remain valid when no `lease_ref` is present.

Lease-scoped mode should be introduced as a strict tagged alternative, not as a bag of optional fields. Runtime validation should reject ambiguous mixed requests.

Once graph-native agent execution exclusively uses lease-scoped mode, callers should stop teaching agents branch naming, base selection, expected-head selection, and idempotency-key construction. Those instructions are then obsolete execution bookkeeping.

A later cleanup may narrow or remove the explicit mode from agent-visible surfaces. That is not required for this slice.

## TDD acceptance cases

The first regression must reproduce the dogfood failure that exposed this design:

1. `project.advance` returns `AGENT_EXECUTION_REQUIRED` for a repository-mutating transition with a valid `lease_ref` and exact authority.
2. The executor calls `github.apply_changeset` with only `lease_ref`, a focused changeset, and a commit message.
3. The mutation succeeds without caller-selected branch, repository, base, expected head, or idempotency key.
4. Readback proves the derived workspace head contains the change.
5. The receipt proves the lease, workspace generation, exact authority base, derived branch, CAS result, and changed paths.

Additional required regression cases:

- subject-derived authority resolution returns the verified repository without caller input and uses the same project-transition verification logic as repository-scoped authority checks;
- mixed lease-scoped plus explicit Git coordinates are rejected before mutation;
- a legacy work lease is rejected from lease-scoped mode;
- an expired or settled project-transition lease cannot mutate;
- a stale authority epoch cannot mutate;
- a changed transition-definition fingerprint cannot mutate the old generation;
- a changed authority revision resolves to a different workspace generation;
- requeue plus reacquisition at the same authority revision reuses the workspace and preserves its current head;
- reacquisition does not replay an unresolved ambiguous mutation from the previous lease;
- multiple sequential changesets under one active lease receive distinct derived idempotency identities as the workspace head advances;
- exact replay of one changeset returns the durable replay receipt;
- concurrent writes against one workspace cannot both advance the ref;
- branch creation races remain fail-closed;
- managed workspaces cannot target `dev` or the production branch;
- explicit Git mode retains its current validation and behavior.

## Implementation boundary

The implementation should add a small lease-scoped request resolver above the existing Git changeset core rather than broadening the core with graph concerns.

Responsibilities remain separated:

- execution authority service: expose one shared project-transition verifier through both repository-scoped and subject-derived entry points;
- managed workspace resolver: derive workspace generation, branch, base, current head, and idempotency identity from verified authority plus current Git readback;
- branch policy: recognize the dedicated managed `work/` branch namespace;
- existing Git changeset core: apply the fully resolved explicit request with current transaction, fencing, recovery, and receipt behavior;
- API/semantic adapter: validate the tagged request alternative and reject mixed authority sources.

The workspace resolver must not consult Linear or query lease storage directly. Graph-native project-transition authority returned by the execution-authority service is sufficient.

## Non-goals

- No branch or workspace field added to `project.advance`.
- No caller-selected repository or branch in lease-scoped mode.
- No new agent-level workspace protocol.
- No automatic rebasing or transplantation across changed authority revisions.
- No merge, pull-request, or integration policy change.
- No replacement of the existing Git changeset transaction engine.
- No weakening of exact-head, mutation-certainty, idempotency, branch-role, or authority-epoch checks.
- No attempt to solve issue #274's historical-versus-current lease diagnosis bug in this change.
- No scheduler behavior change; a worker disabling its own recurrence after an executor blocker is a separate orchestration defect.

## Success criterion

The design is successful when a project-transition agent can receive an implementation assignment from `project.advance`, make iterative repository changes through `github.apply_changeset`, and settle truthfully without ever choosing a repository, branch, base revision, expected head, or idempotency key, while Overcenter retains exact durable evidence for every Git state transition.