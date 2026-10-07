# Owner-Authorized Recovery-Root Updates

**Status:** Proposed design  
**Date:** 2026-10-07  
**Repository:** `laurajoyhutchins/overcenter`

## Problem

The accepted protected-source recovery verifier correctly rejects changes to recovery-root paths, including `biome.json`, `scripts/report-tcb.ts`, and `src/analysis/**`. The existing workflow can verify ordinary protected source changes, but it cannot authorize the verifier or measurement machinery that defines that boundary. It also produces a receipt without changing `main`.

A controlled root-update path must support maintenance of recovery-root files while keeping authorization and verification independent of candidate-controlled content.

## Goals

- Permit a repository owner to authorize one exact recovery-root candidate.
- Verify the candidate with code from the accepted base, never code supplied by that candidate.
- Bind authorization to repository, exact base, direct-child candidate, tree, canonical write set, reason, workflow run, and owner identity.
- Run accepted-baseline checks and candidate checks, including TCB and relevant hostile regressions.
- Produce a durable receipt before any branch update.
- Update `main` only with exact-base compare-and-swap semantics and read back the resulting commit and tree.
- Preserve ordinary source admission. Do not route ordinary changes through root update or broaden its writable paths implicitly.

## Non-goals

- Grant GitHub Apps, bots, or non-owners root-update authority.
- Allow a candidate to choose its verifier, commands, rules, workflow, dependencies, or permissions.
- Automatically merge the separate hostile test PR as part of the root transaction.
- Provide a general deployment or repository-write primitive.

## Existing boundary and bootstrap

The current `protected-source-recovery.yml` is manually dispatched from `main`, checks `GITHUB_ACTOR == GITHUB_REPOSITORY_OWNER`, binds the base to `GITHUB_SHA`, checks out the accepted verifier and exact candidate separately, and runs accepted commands. Its accepted verifier hard-rejects recovery-root paths. The job has read-only contents permission and only uploads a receipt.

There is no accepted root-update verifier today. Installing the first root-update verifier is therefore a distinct bootstrap transaction. Use the repository's already-recorded authority precedent, “repository-owner authenticated compare-and-swap updates,” for that one installation. Prepare a direct-child candidate containing only the root-update verifier, its tests, and the minimum workflow wiring. Before transition, an independent reviewer inspects the exact diff and verifies the candidate against the accepted base using the accepted lint, typecheck, unit, and TCB commands plus hostile root-policy fixtures. The owner then performs a non-forced ref update only after confirming live `main` still equals the exact accepted base; because the candidate is a direct child, a moved ref cannot accept it as a fast-forward. Read back `main`, and write an append-only bootstrap receipt binding the base, candidate, tree, paths, checks, owner, and settled SHA. Do not install the verifier via a workflow or tool identity that the accepted boundary does not authorize. This bootstrap must not include the TCB semantic-LOC change. The bootstrap verifier and receipt cannot be supplied by the candidate being installed.

After bootstrap, ordinary root updates use the installed path.

## Design

Extend the existing recovery flow with an explicit `mode` (`protected-source` or `recovery-root`) and a separately versioned authorization schema for root updates. Dispatch is allowed only from `main` by the repository owner. The root-update job checks out the accepted base into a trusted runtime directory and the candidate into a separate directory. All verifier code, command lists, protected roots, and path-classification rules come from the accepted checkout.

The accepted root-update verifier checks:

1. Repository owner identity and exact `main` ref/base binding.
2. Candidate SHA and tree SHA, and exactly one parent equal to the accepted base.
3. A canonical exact writable-path set equal to the observed no-renames base-to-candidate delta.
4. Every changed path is recovery-root under the accepted policy; unrelated paths are rejected.
5. Root-update authorization uses the exact root-update schema and includes a non-empty reason. It cannot be converted to ordinary source authorization.
6. Accepted-base verification runs using accepted scripts and tools against the candidate tree. Candidate checks run afterward using the candidate tree. Neither command set can silently substitute for the other.
7. The root-update verifier and workflow themselves cannot be modified in the same transaction that uses them. Changes to those paths require a subsequent owner-authorized root update, verified by the currently accepted versions.
8. Required regression evidence is present for changes to measurement rules. For TCB semantic LOC, run the hostile variants for normal layout, minified layout, extreme harmless reflow, comments/whitespace, and nested syntax; require identical semantic counts for equivalent programs.
9. An exact receipt records the accepted base, candidate and tree SHAs, writable paths, reason, owner, accepted and candidate check results, evidence digests, and workflow run ID/attempt.

The workflow is read-only and publishes the verified receipt; it does not receive contents-write permission. After the receipt is available, the repository owner performs the direct-child, non-forced `refs/heads/main` update using owner-authenticated GitHub access, only after confirming live `main` still equals the accepted base. If `main` moved, Git rejects the non-fast-forward update; recut and rerun the full verification. Read back `main`, verify candidate SHA and tree, and append the settled result to the receipt record. Never pass owner credentials or a write token to the runner or candidate scripts.

Ordinary protected-source recovery retains its current policy and behavior. The mode is explicit, and the existing rejection of root paths remains in force for that mode.

## TCB semantic-LOC transaction

After root-update support has been installed and accepted, revalidate current `main`, prepare a fresh direct-child candidate changing exactly:

- `biome.json`
- `scripts/report-tcb.ts`
- `src/analysis/tcb-semantic-loc.ts`

Authorize it as `recovery-root` and run both accepted-baseline checks and candidate checks. Include the hostile layout test as a bound evidence input for this transaction. The core transaction may be settled first; the regression test is then submitted independently through ordinary source admission, as requested. Preserve evidence tying the test's exact SHA and content digest to the verified core candidate.

## Failure behavior

All identity, base, ancestry, tree, write-set, verifier-version, command, evidence, receipt, and settlement mismatches fail closed. Failed checks produce no transition credential and cannot update `main`. A stale-base failure requires a fresh candidate and complete re-verification. No failure is repaired by disabling checks, broadening the writable set, or allowing candidate code to authorize itself.

## Review and acceptance criteria

The design is ready for implementation when reviewers agree that:

- The bootstrap authority and its evidence are explicit and auditable.
- Accepted verifier code remains the sole authority for candidate admission.
- Candidate code cannot alter the verifier, workflow, policy, or commands used to admit itself.
- The owner performs a direct-child non-forced ref update after verifying the exact base; Git's fast-forward rule rejects movement, and read-back confirms settlement. No write capability is exposed to candidate checks.
- Root updates are distinct from ordinary source admission.
- The semantic-LOC change and hostile evidence are bound to exact revisions and verified with the appropriate accepted and candidate checks.
