# Overcenter MVP: verified pull request from an untrusted coding agent

Status: draft product boundary. Tracking issue: #498.

## Promise

Given a bounded GitHub coding task, Overcenter gives an untrusted coding agent an exact assignment, independently verifies the resulting source change, and publishes one verified pull request without allowing the agent to certify or publish its own success.

The MVP stops at a verified pull request. It does not autonomously merge or deploy.

```text
GitHub issue / explicit task
        ↓
trusted task construction
        ↓
source obligation @ exact base
        ↓
claim
        ↓
untrusted coding agent
        ↓
SourceProposal
        ↓
brokered canonical candidate
        ↓
independent verification
        ↓
reserved PR publication
        ↓
authoritative GitHub readback
        ↓
DONE = exact verified PR observed
```

## Authority boundary

The coding worker may inspect source, reason, edit its disposable worktree, run exploratory tools, and submit a candidate.

The coding worker does not own:

- task identity or exact base revision;
- write authorization;
- verifier/profile identity;
- authoritative verification evidence;
- provider mutation credentials;
- effect reservation or settlement;
- the authoritative meaning of DONE.

Worker success text is provenance, not authority.

## MVP DONE predicate

For this product slice, DONE is derived only when trusted machinery establishes all of the following:

1. the candidate originated from the exact live claim;
2. the candidate delta stayed inside the immutable source write envelope;
3. the candidate was independently verified under the repository-owned verification profile;
4. the verification evidence is bound to the exact candidate/base/profile identity;
5. GitHub authoritatively reports the expected pull request at the expected repository/base/head coordinates.

A pull request being created is not enough. The exact intended PR must be observed and verified after mutation.

## Source publication lifecycle

The terminal source product effect is pull-request publication:

```text
verified candidate
      ↓
reserve
      ↓
publish head / create PR
      ↓
certified read
      ↓
predicate
      ↓
resolve
```

Ambiguous publication remains `RECOVERY_REQUIRED`. It never authorizes blind duplicate creation.

If the candidate is stale relative to the admitted base policy, return to re-realization rather than silently rebasing or updating it in the MVP path.

Implementation: #499.

## Verification profile

Acceptance semantics are selected before worker execution from repository-owned trusted configuration. The worker cannot redefine the required checks after producing a candidate.

The first profile should be intentionally small and deterministic, for example fixed repository commands and/or an already-authoritative hosted workflow. Profile identity must be bound into verification evidence.

Implementation: #500.

## Bounded source write envelope

General coding tasks cannot always predict the exact file set before investigation. The MVP therefore needs a bounded immutable write envelope rather than only exact predeclared files.

The envelope may include:

- allowed roots;
- optional exact files;
- denied roots/files;
- maximum changed-file count;
- deterministic size bounds.

Control-plane, verifier, authority, and repository-policy inputs remain protected.

The envelope is authorization. The realized candidate delta supplies the concrete observed/expected write set. These are not the same concept.

Implementation: #501.

## Coding-agent adapter

A worker adapter prepares the exact assigned worktree, runs the configured coding command, computes the resulting source delta, and emits a `SourceProposal` through the existing broker boundary.

The adapter is disposable and untrusted. It does not mint verification evidence or publish effects.

Implementation: #502.

## Transport-neutral controller protocol

The semantic advance/submit protocol must not require GitHub Actions rerun coordinates as intrinsic state.

GitHub Actions, a local CLI, and future hosted controllers should be transports over the same authority semantics. Transport metadata remains evidence/provenance unless a specific predicate explicitly admits it.

This work must not choose or create another durable authority substrate. The production authority-store decision belongs to PR #495/current main.

Implementation: #503.

## Public interface

The intended first operator surface is approximately:

```text
overcenter init
overcenter run --repo owner/repo --issue 418 --agent codex
overcenter status
overcenter recover
```

A successful run should surface concise exact identities:

```text
claimed       issue-418 @ main:<sha>
agent         run-7
candidate     <sha>
verification  passed
pull request  #<n> observed
head          <verified candidate>
state         DONE
```

The CLI drives the existing kernel, source broker, verification, generic effect, certified observation, and recovery machinery. It is not a second orchestrator.

Implementation: #504.

## Deterministic judgment frontier

The product loop should use #422 to decide whether the next step is:

- deterministic software action;
- reasoning required;
- recovery required;
- unsupported/reject.

The agent only receives the unresolved judgment frontier. Known mechanical work stays software.

## Repository admission

The MVP produces a verified PR; repository policy decides whether that PR may merge.

Issue #130 owns the `main` policy boundary: exact-head `Merge gate`, up-to-date admission, and no direct/force-push bypass.

## Existing convergence work

The MVP should reuse rather than fork current convergence work:

- PR #493: source settlement through the generic effect lifecycle;
- PR #490: generic certified GitHub reads;
- PR #495: one production durable authority substrate.

No MVP implementation should preserve or add a shadow authority simply for product convenience.

## Non-goals

The first release does not require:

- autonomous merge;
- deployment;
- arbitrary provider mutations;
- multi-agent candidate selection;
- a universal planner;
- generalized research-surface expansion;
- workers that understand claims, leases, generations, settlement, or recovery internals.

## Implementation order

1. #499 — verified source candidate → pull-request effect
2. #500 — repository-owned verification profile
3. #501 — bounded source write envelope
4. #502 — coding-agent worktree adapter
5. #503 — transport-neutral advance/submit
6. #504 — public CLI

Post-MVP: #505 closes the unattended retry loop by feeding trusted failure evidence back into source re-realization.

## Ship criterion

A fresh supported repository can take one bounded coding task through:

```text
task
→ claim
→ untrusted coding worker
→ brokered candidate
→ independent verification
→ reserved PR publication
→ authoritative readback
→ DONE
```

with fail-closed behavior for stale bases, out-of-envelope changes, failed verification, and ambiguous publication.
