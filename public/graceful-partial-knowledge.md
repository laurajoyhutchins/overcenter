# Graceful partial knowledge

Hatchable observational commands degrade only evidence that is optional to the command's central claim.

## Rule

A successful observation may combine known evidence with explicit unavailable evidence when the unavailable surface is bounded and the remaining result is still truthful and internally coherent.

Unavailable evidence must never be interpreted as satisfied evidence. Absence, known-empty, unavailable, and observed values remain distinct.

## `github.review_packet`

The evidence boundary is explicit in `githubReviewPacketEvidencePolicy`.

Coherence-critical evidence:

- repository / pull request identity
- exact head identity
- exact base identity
- final identity reread and head/base coherence

Bounded observational evidence:

- review state and review threads
- changed paths
- check runs
- commit statuses
- applicable repository rulesets

Repository rulesets are the sole branch-policy authority for this Hatchable deployment. The review packet does not inspect the older branch-protection API and does not request GitHub Administration permission.

The GitHub App uses the already-approved Contents grant for exact PR/head identity, while Pull Requests, Checks, and Statuses use isolated internal permission profiles. A missing bounded observation grant therefore does not prevent exact PR/head identity from being established.

Only recognized permission, unsupported/not-found, or transient upstream failures on bounded observation surfaces may degrade to structured unavailable evidence. Malformed GitHub responses, unexpected internal exceptions, transport failures that cannot be classified safely, and identity/head movement remain command-level failures.

`protection.policy_surfaces.rulesets` records ruleset availability, configuration, completeness, and structured unavailable evidence. `protection.source` is `rulesets` when applicable and `none` when the ruleset surface was successfully observed and contains no applicable policy.

Policy-dependent derived values remain `null` or `evaluation: unavailable` when ruleset evidence is not established. Known unsatisfied evidence can still be reported as unsatisfied; unknown evidence is never promoted to satisfied.

The canonical snapshot digest includes explicit availability state, so known-empty ruleset evidence cannot hash identically to unavailable ruleset evidence.

## Other current read primitives

### `object.get_verified`

No graceful degradation is appropriate. Drive identity, retained-binary status, canonical object metadata, object-id uniqueness, capture-ledger identity, expected identity, immutable-byte integrity, configured-root membership, and reconciliation are all required to truthfully return `verification.verified: true`. Any missing required evidence remains a command-level failure.

### Portfolio `fetch` and `search`

These read already-materialized Hatchable portfolio projections. They do not assemble a new live snapshot from multiple authorities during the read, so there is no optional external evidence surface to degrade at this boundary.

### `portfolio.reconcile_work_surface`

This is a reconciliation command rather than a read primitive. Its existing two-level result model already distinguishes command completion from bounded item-level rejection; that is not a partial-knowledge mechanism and remains unchanged.