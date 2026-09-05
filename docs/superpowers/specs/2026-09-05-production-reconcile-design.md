# Intent-First Production Reconciliation Design

> **Document status: Approved design.** This design defines the operator-facing production convergence boundary for Overcenter. GitHub remains source authority, Overcenter remains execution/settlement authority, and Hatchable remains a derived runtime projection.

## Problem

Overcenter already has a safe exact-revision production promotion primitive, `production.promote({ repo })`, and a deterministic production materialization operation. The remaining product defect is that a caller must still reason about the procedural seam between them:

```text
verified dev
  -> production.promote
  -> reread production
  -> decide whether runtime is stale
  -> materialize exact production revision
  -> verify immutable deployment
  -> decide whether production is converged
```

Those decisions are mechanically knowable. Requiring an agent to sequence them makes the reasoning agent a command dispatcher and leaves retry/recovery correctness in prompt context.

## Decision

Add one normal operator-facing semantic command:

```text
production.reconcile({ repo })
```

The public input is repository identity only. The caller does not supply branch names, commit SHAs, verification run IDs, Hatchable project IDs or versions, runtime refs, or idempotency keys.

Overcenter derives those coordinates from authoritative state and converges the declared production state by taking only the next safe deterministic step.

Lower-level promotion and materialization primitives remain narrow implementation boundaries. `production.reconcile` composes them; it does not replace or weaken them.

## Product invariant

> A caller that can name the repository can request production convergence, while deterministic software owns exact-revision selection, mutation fencing, recovery, readback, and final proof.

Success means fresh evidence proves:

```text
Git production revision
        ==
verified immutable runtime revision
```

for the exact same 40-character Git SHA.

## State model

The coordinator observes three facts:

- `development_revision`: current exact development branch head derived from stored branch roles;
- `production_revision`: current exact production branch head;
- `runtime_revision`: revision proven by a fresh authoritative runtime observation and immutable materialization receipt.

The normal convergence states are:

```text
A. dev == production == runtime
   -> verified no-op

B. dev != production
   -> require exact verification for dev
   -> promote dev exact SHA
   -> authoritative production reread
   -> continue only if production now proves the selected SHA

C. production == selected SHA, runtime != selected SHA
   -> materialize that exact production SHA
   -> immutable deployment readback
   -> production verification

D. fresh final readback proves production == runtime == selected SHA
   -> CONVERGED
```

The coordinator never materializes a SHA merely because promotion reported success. The post-promotion authoritative production reread is a hard boundary.

## Authority boundaries

### GitHub

GitHub is source authority. Branch roles are resolved from Overcenter repository-role state, then exact Git heads are read from GitHub. Promotion uses the existing exact-SHA non-force production promotion implementation.

A mutable branch name is never evidence that a previously verified object is still selected. Verification and effects remain bound to the same exact commit identity.

### Overcenter

Overcenter owns command semantics, idempotency, mutation certainty, sequencing, and final convergence claims. It decides which deterministic step is currently safe from observed facts.

The reasoning caller does not choose retry identity or reconstruct which prior side effect might have happened.

### Hatchable

Hatchable is a derived runtime projection. Runtime convergence is proven only by fresh observation of an immutable deployed version whose source-materialization receipt binds the exact Git production SHA and source manifest.

A historical successful materialization workflow run is not current runtime evidence.

## Fresh runtime observation

`production.reconcile` must observe runtime state at invocation time or through a bounded fresh read performed by the host adapter. Historical CI success, an old deployment receipt, or a cached workflow conclusion cannot authorize a current convergence result.

The runtime observation surface returns the exact immutable deployment version and source-materialization receipt. The host rejects missing, malformed, stale, or mismatched identity evidence.

## Mutation ordering

Only one external mutation boundary is crossed at a time:

1. observe authoritative Git and runtime state;
2. if production promotion is required, perform promotion;
3. reread Git production authority;
4. only after exact readback, decide whether materialization is required;
5. perform deterministic materialization;
6. inspect immutable deployment and production verification evidence;
7. perform fresh final Git/runtime readback;
8. return convergence evidence.

This ordering makes interrupted execution resumable by observation. If promotion succeeded but materialization did not, the next invocation starts from state C rather than replaying promotion.

## Mutation certainty

Existing lower-level `may_have_mutated` semantics are preserved.

If a mutation returns indeterminate certainty, `production.reconcile` stops. It must not infer success from intention and must not blind-retry the effect. A later invocation first observes authoritative state and decides from facts.

Known precondition rejection remains safe to retry after authority is refreshed. Confirmed no-op remains mutation-free.

## Public contract

Accepted:

```json
{
  "repo": "owner/name"
}
```

Rejected as unsupported mechanical authority:

```text
branch
sha
candidate_sha
verification_run_id
hatchable_project
runtime_ref
runtime_version
idempotency_key
```

The semantic descriptor, worker transport, and MCP adapter all expose the same repo-only input schema.

## Coordinator versus host

The coordinator is a pure dependency-injected state machine. It understands convergence facts and ordering, but not GitHub App authentication, Hatchable HTTP details, or database transport.

The Overcenter host adapter owns:

- repository branch-role resolution;
- exact Git head reads;
- exact-revision verification lookup;
- invocation of the existing production promotion host;
- fresh runtime observation;
- invocation of deterministic production materialization;
- normalization of exact convergence evidence.

This keeps policy testable without network effects and prevents weaker duplicate implementations of promotion/materialization safety.

## Workflow serialization

The production materialization workflow remains the serialized GitHub-triggered projection path. Its runtime-observation and head-fence helpers must use exact production identity and refuse to treat stale workflow history as current runtime state.

The workflow is an execution substrate, not a second production authority.

## Required regressions

The implementation must prove:

1. repo-only disposable caller: verified dev + stale production + stale runtime promotes, rereads, materializes the exact same SHA, verifies immutable runtime, and converges;
2. already converged returns a verified no-op with no mutation;
3. production current + runtime stale skips promotion and materializes only;
4. missing exact dev verification fails before promotion;
5. production head drift fails closed;
6. indeterminate promotion prevents materialization;
7. immutable deployment mismatch fails closed;
8. final Git/runtime readback drift fails closed;
9. public schema rejects caller-selected mechanical coordinates;
10. historical materialization workflow success cannot substitute for fresh runtime evidence.

## Recovery behavior

`production.reconcile` is intentionally convergent. Retrying the command means re-observing the world, not replaying a remembered step list.

Examples:

- promotion confirmed, materialization absent -> resume at materialization;
- materialization confirmed, final readback interrupted -> reread and return no-op convergence if identities still match;
- effect indeterminate -> stop; next call resolves by observation;
- Git or runtime authority changed -> recompute from new facts.

## Operator-facing documentation

`production.reconcile({ repo })` is the normal path documented for moving verified development state to production. `production.promote` and materialization remain available as lower-level implementation/recovery primitives, not the conceptual entry point.

## Out of scope

This design does not claim to solve Hatchable issue #161 or create an atomic cross-provider transaction. Hatchable still lacks a prepared-deployment/CAS primitive spanning GitHub and runtime publication. The safety model is deterministic convergence with exact observations, single-effect boundaries, and fail-closed recovery.