# Verified source profile and bounded write envelope

Status: proposed design for review. Related MVP issues: #498, #500, and #501.

## Goal

Let a coding worker change a bounded, initially unknown subset of an allowed source and test tree while keeping task identity, verification policy, and publication authority under trusted control.

The product outcome remains the one in #498: an untrusted worker can propose a candidate; trusted software checks its exact base, scope, and verification evidence; the final product is one authoritatively observed pull request. The worker never declares the work DONE, supplies its own verification authority, or publishes the PR.

## Current repository contracts

At main `3877bc2908de4c21da4c31d9932da7898bbc0aef`:

- `SourceTaskPacket` v1 authorizes an exact `writable_paths` list.
- The source broker validates a proposal, materializes a candidate commit, and inspects its Git delta before publishing the candidate ref.
- `SourceTransactionPlan` already distinguishes `authorized_write_set`, `expected_write_set`, and `observed_write_set`, but authorization is currently a flat exact-path list.
- `sourceTransactionContextFromEnvironment()` selects a named repository baseline and validator paths. The baseline digest binds path, mode, and content; the source proof binds the exact candidate, base, runtime, plan digest, baseline identity, and hosted workflow/job readback.
- The current Overcenter baseline includes `test/**` among validator inputs. That makes a candidate which edits tests ineligible for verified status, even when the verifier commands and configuration are unchanged.

The MVP should reuse this source transaction and proof path. It should not add another verifier registry, transaction store, or publication lifecycle.

## Design

### 1. Repository-owned verification profile

Represent one default source-task profile as versioned data owned by the target repository at the exact claimed base revision. The profile fixes:

- the stable profile ID;
- the trusted workflow and required hosted job identities, where hosted evidence is used;
- the commands and runner configuration that define verification;
- the paths that control verification or source admission;
- the immutable base test suite that must continue to pass.

Load the profile from the claimed base, not from candidate-controlled bytes. Bind its ID and content digest into the assignment, transaction plan, and admitted proof. Missing, malformed, unknown, or changed profiles fail closed. Existing baseline and proof machinery supplies the exact-revision binding and should be promoted rather than shadowed.

### 2. Bounded write envelope

Keep exact-file tasks representable. Add a versioned envelope for tasks whose concrete files are discovered during work:

- allowed roots and optional exact paths;
- explicit denied roots and paths;
- a maximum changed-file count;
- a maximum changed-byte count.

Normalize path arrays by validating safe repository-relative paths, rejecting duplicates, and sorting them before identity calculation. Root matching is segment-based. Denials and profile-protected paths override every allowed root or exact path. `.git/**`, `.github/**`, `.overcenter/**`, and verifier/profile inputs are protected by trusted policy.

The envelope is part of the immutable task identity. It remains distinct from the concrete write sets: the envelope authorizes a region, while the independently observed candidate delta supplies the expected and observed paths.

### 3. Candidate and verification flow

Before candidate-ref publication, the trusted broker reconstructs the candidate delta from the exact claimed base and candidate commit. It rejects unsupported modes, paths outside the envelope, protected-path edits, duplicate or malformed proposal entries, and file or byte limits exceeded. File count is the number of entries in the no-renames delta. Changed bytes are the sum of the before and after blob sizes for each entry; this bounds both large replacements and deletions deterministically.

The verifier profile and runner configuration remain fixed at the base. Verification runs both:

1. the base test suite against the candidate implementation, so the worker cannot remove or weaken the pre-existing regression suite; and
2. the candidate test suite, so new coverage is exercised as part of the proposed change.

The proof records bind both results to the same candidate, base, runtime, and profile digest. Candidate-authored tests are additional evidence; they do not replace the base suite or redefine the commands that run.

A profile or envelope mismatch is rejected before publishing the candidate ref. A stale base returns to re-realization. An ambiguous candidate-ref or later PR-publication outcome remains recovery-required; no blind retry is introduced here.

## Data flow

```text
profile + task envelope at exact base
                ↓
       immutable assignment
                ↓
      untrusted worktree agent
                ↓
 proposal → broker → observed Git delta
                ↓
 scope/limits + base/candidate tests
                ↓
 exact-bound proof → later reserved PR effect
```

## Scope and sequencing

Implement the two source contracts as separate reviewable slices:

1. #500: make the existing baseline a repository-owned, exact-base verification profile and bind its identity to source evidence.
2. #501: add the bounded envelope and enforce it against the observed candidate delta before candidate publication.

Then implement #502's worker adapter. #499's PR effect must continue to reuse the generic settlement and certified-read work in #493 and #490, as well as the single authority decision in #495; it should not proceed by duplicating those paths. #503 and #504 remain the semantic controller and user-facing CLI slices.

This design does not change merge policy, storage authority, provider mutation semantics, or the rule that the MVP stops at an observed PR.

## Required regressions

- A changed profile digest invalidates an otherwise identical candidate proof.
- Missing or unknown profiles fail closed.
- The worker cannot select easier commands or replace profile identity after assignment.
- A broad allowed root cannot override a protected path.
- Exact-file tasks remain valid under their existing identity.
- Reordering equivalent envelope paths does not change identity; duplicates and unsafe paths fail.
- Candidate additions, edits, deletions, mode changes, file-count overflow, and byte-count overflow are evaluated from the reconstructed Git delta.
- Base tests still run when the candidate deletes or weakens their corresponding tests.
- Candidate-added tests run under the same immutable verification profile.
- Rejected scope/profile candidates are not published; ambiguous publication remains recovery-required.
