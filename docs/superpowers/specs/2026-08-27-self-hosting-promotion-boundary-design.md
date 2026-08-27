# Overcenter self-hosting promotion boundary

Date: 2026-08-27
Status: proposed, user-approved architecture

## Problem

Overcenter currently develops and operates from the same moving GitHub source surface. Ordinary implementation work can advance the source coordinate that production source materialization reads while the live control plane is still orchestrating work against earlier assumptions. Recent source-materialization incidents show that this coupling lets Overcenter trip over its own development: repository state, materialization receipts, Hatchable draft state, and the live deployment can advance on different clocks.

Branch-policy-v1 currently governs work-branch naming and the repository default-branch ruleset, but it does not model semantic branch roles. Source synchronization accepts a caller-supplied GitHub branch. Production therefore lacks an explicit promotion boundary.

## Goal

Introduce a dedicated `dev` integration branch and an exact-SHA promotion path into the branch already used as the Hatchable production source. Development can then continue without changing production source authority. Production Overcenter must remain a stable executor until an already-verified development commit is deliberately promoted.

## Non-goals

- Do not make Hatchable a source authority.
- Do not create a second repository-state authority inside Overcenter.
- Do not solve Hatchable's mutable-draft-to-deploy atomicity limitation tracked separately by Overcenter #161.
- Do not add a generic GitHub branch-management wrapper.
- Do not invent a new production branch name when a deployed runtime already has an established GitHub source branch.

## Authority model

GitHub remains authoritative for repository content, commit identity, refs, pull requests, checks, and branch ancestry.

Overcenter is authoritative for orchestration state, promotion receipts, exact-revision evidence, idempotency, recovery, and the configured semantic role of a repository branch within the portfolio. Branch-role configuration is explicit portfolio configuration; it must not be re-inferred from GitHub's default branch after a repository is migrated.

Hatchable remains a derived runtime projection. A Hatchable deployment is trusted only after immutable post-deploy verification binds it to the promoted production commit.

## Branch roles

Each managed deployed repository declares:

- `development`: the literal `dev` branch, which receives verified integrated work;
- `production`: the existing GitHub branch used as the production runtime source;
- `work`: branches matching the existing branch-policy-v1 work-branch convention.

For the initial Overcenter migration, `dev` is the development branch and `main` is the production branch because Hatchable source materialization currently targets `main`. The migration preserves that production source branch rather than introducing a new `production` branch.

A branch cannot hold both development and production roles.

The production role is seeded from the existing runtime source binding during migration and then stored explicitly. It must not silently follow a later caller-supplied branch or a change to GitHub's default branch.

## Mutation rules

Ordinary `github.apply_changeset` mutations may target conforming work branches. They must reject direct content mutation of branches assigned the development or production role.

Development advances only through the existing integration path after required review/check evidence succeeds. That integration path must resolve `dev` as the development target instead of assuming the repository default branch is the integration target.

Production advances only through a narrow semantic promotion command. No ordinary changeset, ad hoc ref update, or integration command may advance it.

## Promotion operation

Add a semantic command conceptually equivalent to:

`github.production.promote`

The request carries the repository, candidate development commit, observed development head, observed production head, and the required verification coordinate. The command resolves `dev` as the development branch and derives the production branch from explicit repository deployment configuration.

Before mutation it must verify:

1. the configured development and production roles are unambiguous;
2. the observed branch heads still match GitHub;
3. the candidate commit is the exact requested development commit;
4. the candidate is reachable from `dev`;
5. required verification evidence applies to that exact candidate SHA;
6. advancing production is a fast-forward unless an explicitly separate rollback semantic operation is used;
7. the idempotency key maps to the same semantic request.

The only GitHub mutation is advancing the production branch ref to the existing candidate SHA. Promotion must never recreate, squash, cherry-pick, or otherwise synthesize a new commit.

The receipt records old production head, new production head, development head observed, candidate SHA, verification evidence coordinate, branch-role policy version, and GitHub readback.

## Source materialization binding

Production source synchronization must no longer accept an arbitrary caller-selected branch as authority. It resolves the configured production role and snapshots its exact head before planning materialization.

A production materialization receipt must bind:

- repository;
- production-role branch name;
- exact production commit SHA;
- base Hatchable version;
- immediate target Hatchable version;
- complete synchronized-source manifest digest;
- source path count.

If the immutable live deployment contains a receipt targeting a different Hatchable version or different production SHA, the deployment state is `UNVERIFIED` even when sampled files appear to match.

The v351 condition observed on 2026-08-27 is the regression example: live code contained a newer `main` change while the embedded receipt still targeted v350 and its parent GitHub commit. That state must never be treated as verified production provenance.

## Self-hosting safety

Production Overcenter orchestrates development while remaining pinned to its current verified production commit.

The intended Overcenter flow is:

```
work branches
    |
    v
   dev
    |
    | integration + exact-SHA verification
    v
verified candidate
    |
    | github.production.promote
    v
   main
    |
    | serialized source materialization
    v
Hatchable deployment
    |
    | immutable deployment verification
    v
verified production coordinate
```

A production deployment must not be considered complete merely because Hatchable reports it live. Overcenter advances its verified-production coordinate only after the immutable deployment manifest and receipt verify against the promoted production SHA.

## Failure behavior

All mismatches fail closed.

- Development head moved: reject promotion with no mutation.
- Production head moved: reject promotion with no mutation.
- Candidate lacks exact-SHA verification: reject promotion.
- Candidate is not reachable from `dev`: reject promotion.
- Production source receipt targets the wrong deployment version or SHA: mark deployment unverified and do not advance the verified-production coordinate.
- Hatchable post-deploy verification fails: leave the GitHub production ref authoritative, report runtime drift, and require rematerialization or rollback. Do not rewrite GitHub to match Hatchable.

## Interaction with #161

This design removes the moving-GitHub-source side of the source-materialization race and serializes the semantic production target. It does not eliminate the remaining mutable Hatchable draft-to-deploy TOCTOU window. #161 remains blocked until Hatchable exposes an immutable prepared deployment candidate or conditional deploy/fenced atomic replace primitive.

## Migration

1. Add branch-role configuration and read-only resolution first, with `dev` fixed as the development role and an explicit production source branch field.
2. Teach mutation/integration commands to enforce role boundaries while preserving existing work-branch behavior.
3. Add exact-SHA production promotion with idempotent receipts and readback.
4. Bind production source-sync to the configured production role and strengthen stale-receipt verification.
5. For Overcenter, confirm the existing Hatchable production source branch from current source-materialization configuration. Today that branch is `main`; if the authoritative runtime configuration disagrees at cutover, use the runtime-configured branch rather than assuming `main`.
6. Before changing branch flow, converge Hatchable production to the current head of that production source branch and require a fully verified immutable deployment receipt for the exact commit. If verification fails, retry materialization or stop the migration; do not infer success from live code.
7. Create `dev` at that same verified production commit. From this cutover point, ordinary work integrates to `dev`, while the existing production branch remains pinned until promotion.
8. Promote newer verified `dev` commits into the existing production branch through the new semantic operation, then materialize and verify them in Hatchable.
9. Only after the self-hosting path is verified should the policy be rolled out portfolio-wide.

Migration must not rewrite repository history, move the production branch backward to match an older deployment, or infer a production commit from an uncertified Hatchable deployment.

## Tests

Add deterministic regressions for:

- direct changeset mutation of `dev` rejected;
- direct changeset mutation of the configured production branch rejected;
- work-branch mutation remains allowed;
- integration resolves `dev` rather than the default branch;
- production branch is seeded from the existing runtime source binding;
- changing the default branch does not silently change the production role;
- promotion succeeds only for exact verified `dev` SHA;
- stale observed development or production head rejects before mutation;
- non-ancestor candidate rejects;
- promotion replays idempotently;
- production branch advances to the existing candidate commit with no new commit object;
- source-sync derives production branch from role configuration;
- caller cannot override production branch;
- wrong-version receipt is unverified;
- wrong-SHA receipt is unverified;
- cutover creates `dev` only after current production source has a fully verified immutable deployment coordinate;
- cutover fails closed when current production source cannot be verified;
- immutable deployment verification is still authoritative after promotion;
- #161 residual Hatchable race remains fail-closed rather than being falsely declared solved.

## Acceptance

Overcenter can continue integrating development work on `dev` without changing the production source coordinate. Production changes only by an evidence-preserving exact-SHA promotion into the branch already used by the production runtime. Hatchable production is trusted only when immutable deployment evidence binds it to that promoted SHA. Ordinary agents cannot bypass the branch-role boundary through existing semantic mutation commands.
