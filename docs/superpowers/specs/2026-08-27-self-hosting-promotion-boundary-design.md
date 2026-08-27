# Overcenter self-hosting promotion boundary

Date: 2026-08-27
Status: user-approved architecture

## Problem

Overcenter currently develops and operates from the same moving GitHub source surface. Ordinary implementation work can advance the source coordinate that production source materialization reads while the live control plane is still orchestrating work against earlier assumptions. Repository state, materialization receipts, Hatchable draft state, and the live deployment can therefore advance on different clocks.

Branch-policy-v1 governs work-branch naming and the repository default-branch ruleset, but it does not model development and production as distinct semantic roles. Source synchronization also accepts a caller-supplied GitHub branch. Production therefore lacks an explicit promotion boundary.

## Goal

Use `dev` as the development/default branch and preserve the GitHub branch already used by the production runtime as the production branch. Production Overcenter remains stable while development continues on `dev`; production changes only by promoting an already-verified exact `dev` commit.

For Overcenter today, existing source-materialization evidence names `main`, so the initial role mapping is:

```text
work branches -> dev -> main -> Hatchable production
```

## Non-goals

- Do not make Hatchable a source authority.
- Do not create a second repository-content authority inside Overcenter.
- Do not solve Hatchable's mutable-draft-to-deploy atomicity limitation tracked by Overcenter #161.
- Do not add a generic GitHub branch-management wrapper.
- Do not invent a new production branch when a runtime already has an established source branch.
- Do not add another pre-production verifier when the existing exact-revision Hatchable V8 verifier can be reused.

## Authority model

GitHub remains authoritative for repository content, commit identity, refs, pull requests, checks, workflow runs, and branch ancestry.

Overcenter is authoritative for orchestration state, branch-role configuration, promotion receipts, idempotency, recovery, and verified deployment coordinates.

Hatchable remains a derived runtime projection. A Hatchable deployment is trusted only after immutable post-deploy verification binds it to the promoted production commit.

## Branch roles

Each managed deployed repository declares:

- `development`: literal `dev`;
- `production`: the existing GitHub branch used by the production runtime;
- `work`: branches satisfying branch-policy-v1.

The GitHub default branch is `dev` after migration. Default branch and production branch are intentionally different concepts.

For Overcenter initially:

```text
development = dev
production  = main
default     = dev
```

The production role is seeded from authoritative runtime source-binding evidence during migration and then persisted explicitly. It must not silently follow later caller input or a later GitHub default-branch change.

A branch cannot hold both development and production roles.

## Mutation rules

Ordinary `github.apply_changeset` operations may mutate conforming work branches only. For a configured repository they reject direct content mutation of `dev` and the production branch.

Ordinary pull-request creation requires `dev` as the base branch. Integration independently rereads the PR and rejects any PR whose base is not `dev`.

Development advances through the existing integration path after review/check requirements succeed.

Production advances only through a narrow semantic production-promotion operation. No ordinary changeset, PR integration, caller-selected source-sync branch, or ad hoc Overcenter ref mutation may advance it.

Unconfigured repositories retain existing behavior until explicitly migrated.

## Exact-revision verification

Overcenter already has `.github/workflows/exact-revision-v8.yml`. That workflow checks out one exact Git commit, materializes it into an isolated Hatchable V8 verification project, verifies the immutable verification deployment, and runs the canonical regression endpoint. It also requires the verification Hatchable project to differ from the production project.

Production promotion must reuse this verifier.

A promotion request carries the successful GitHub Actions workflow run ID. Promotion independently rereads that run and requires:

```text
workflow path = .github/workflows/exact-revision-v8.yml
event         = workflow_dispatch
head SHA      = candidate SHA
status        = completed
conclusion    = success
```

Ordinary PR checks are not a substitute for this exact-revision production gate.

## Promotion operation

Add a semantic command conceptually equivalent to:

`github.production.promote`

The request contains:

- repository;
- candidate SHA;
- observed `dev` head;
- observed production head;
- exact-revision verification workflow run ID;
- idempotency key.

Version 1 promotes the current `dev` head only. Before mutation it must verify:

1. branch roles are configured and unambiguous;
2. current `dev` and production refs equal the observed refs;
3. candidate SHA equals the current `dev` head;
4. the successful exact-revision workflow run is for that candidate SHA;
5. advancing production to the candidate is fast-forward or already identical;
6. the idempotency key maps to the same semantic request.

The only GitHub mutation is advancing the existing production branch ref to the existing candidate SHA. Promotion must never recreate, squash, cherry-pick, rebase, or otherwise synthesize a commit.

Immediately before ref mutation, reread `dev` and production. After mutation, reread production and require exact candidate equality. If mutation transport becomes uncertain, authoritative ref readback decides whether the intended promotion occurred.

The durable receipt records old/new production heads, observed development head, candidate SHA, verification workflow run ID and reread, branch-role policy coordinate, idempotency identity, and GitHub readback.

Ordinary promotion never moves production backward. Rollback requires a separate semantic operation and is outside this design.

## Branch protection and default branch

After cutover, GitHub default branch becomes `dev`, so existing `~DEFAULT_BRANCH` branch-policy reconciliation naturally protects development integration rather than production.

Production identity must not be inferred from the default branch.

Overcenter's own semantic boundaries prohibit ordinary production mutation. Any direct/manual GitHub mutation outside Overcenter is break-glass behavior and will invalidate observed production-head coordinates until reconciled.

## Source materialization binding

Production source synchronization must not accept an arbitrary branch selection. It resolves the configured production role and snapshots that exact branch head before planning materialization.

A production materialization receipt binds:

- repository;
- production branch name;
- exact production SHA;
- base Hatchable version;
- immediate target Hatchable version;
- complete synchronized-source manifest digest;
- source path count.

If the immutable deployment contains a receipt targeting a different Hatchable version or different production SHA, the deployment is `UNVERIFIED`, even when sampled files happen to match.

The v351 condition observed on 2026-08-27 is the regression example: live code contained a newer source change while the embedded receipt still targeted v350 and its parent GitHub commit. That state must never count as verified production provenance.

Mutable-draft receipt and verified materialization are distinct:

```text
draft receipt = candidate evidence
immutable deployment + exact target version + exact production SHA = verified materialization
```

## Self-hosting safety

The intended steady-state flow is:

```text
work branches
    |
    v
   dev  (GitHub default)
    |
    | exact-revision V8 verification
    v
verified candidate
    |
    | github.production.promote
    v
 production branch (main for Overcenter today)
    |
    | serialized source materialization
    v
Hatchable production deployment
    |
    | immutable deployment verification
    v
verified production coordinate
```

Production Overcenter orchestrates development while remaining pinned to its last promoted production commit. Development may continue moving without changing the production source coordinate.

A Hatchable deployment is not complete merely because Hatchable reports it live. Overcenter advances its verified-production coordinate only after immutable deployment manifest and receipt verification succeeds for the promoted SHA.

## Failure behavior

All mismatches fail closed.

- PR targets production instead of `dev`: reject before mutation.
- Ordinary changeset targets `dev` or production: reject before mutation.
- Development head moved: reject promotion.
- Production head moved: reject promotion.
- Candidate is not the current `dev` head: reject promotion.
- Exact-revision workflow run is failed, incomplete, wrong workflow, or wrong SHA: reject promotion.
- Promotion is not fast-forward: reject promotion.
- Source-sync caller tries to override the production branch: reject.
- Production receipt targets the wrong deployment version or SHA: mark unverified.
- Hatchable post-deploy verification fails: leave GitHub production authoritative, report runtime drift, and rematerialize. Do not rewrite GitHub to match Hatchable.

## Interaction with #161

This design removes the moving-GitHub-source side of the source-materialization race and gives production a stable semantic target. It does not eliminate the mutable Hatchable draft-to-deploy TOCTOU window. #161 remains blocked until Hatchable exposes an immutable prepared deployment candidate or conditional/fenced deployment primitive.

## Migration

1. Implement branch-role persistence, enforcement, exact-SHA promotion, production-bound source-sync, and deterministic cutover planning while Overcenter remains unconfigured. Existing behavior therefore continues during implementation.
2. At cutover, reread fresh authoritative source-binding evidence. For Overcenter today it should identify `main`; if fresh authoritative evidence says otherwise, use that runtime source branch rather than assuming `main`.
3. Converge Hatchable production to the current production-branch head and require a fully verified immutable deployment for that exact SHA. Never move the production branch backward to match an older deployment.
4. Do not cut over while an ordinary executable PR can still merge into the production branch.
5. Persist the branch-role binding first. This intentionally creates a brief fail-closed interval where ordinary integration can no longer target production.
6. Use the existing semantic default-branch migration to create `dev` at the exact verified production SHA and change GitHub default from production to `dev`. If `dev` already exists at a different SHA, stop.
7. Reconcile branch policy on the new default `dev`.
8. Reread production and prove it did not move during cutover.
9. Dogfood a low-risk work branch into `dev`; verify production remains unchanged.
10. Run exact-revision V8 verification for the resulting `dev` SHA.
11. Promote that exact verified SHA into production, materialize it to Hatchable, and require immutable production deployment verification.
12. Roll out branch-role configuration to other repositories only after the Overcenter self-hosting path is verified.

## Tests

Deterministic regression coverage must include:

- `dev` fixed as the development role;
- production seeded from explicit runtime source-binding evidence;
- development and production cannot alias;
- direct changeset mutation of `dev` rejected;
- direct changeset mutation of production rejected;
- work-branch mutation remains allowed;
- PR creation requires `dev` for configured repos;
- integration independently rejects a production-base PR;
- changing GitHub default does not change production role;
- promotion requires the current `dev` head;
- stale development or production coordinates reject before mutation;
- failed/incomplete/wrong-SHA/wrong-workflow verification runs reject;
- non-fast-forward promotion rejects;
- promotion replay is idempotent;
- production advances to the existing candidate commit with no new commit object;
- source-sync derives production branch from branch roles;
- caller cannot override production source branch;
- wrong-version receipt is unverified;
- wrong-SHA receipt is unverified;
- cutover refuses unverified production;
- cutover refuses conflicting existing `dev`;
- cutover refuses executable production-target PRs;
- immutable deployment verification remains authoritative after promotion;
- #161 residual race remains fail-closed rather than being falsely declared solved.

## Acceptance

Overcenter can integrate ordinary work into `dev` without moving the production source branch. `dev` is the GitHub default branch. Production remains the branch already used by Hatchable and changes only through evidence-preserving exact-SHA promotion backed by the existing isolated V8 verifier. Hatchable production is trusted only when immutable deployment evidence binds it to that promoted SHA. Ordinary Overcenter agent paths cannot bypass the branch-role boundary.
