# Overcenter repository transactions

Design for review · September 29, 2026

## Outcome

Turn proposed software work into an evidence-backed repository transaction. An agent supplies intent and a candidate; deterministic software enforces scope, derives conservative validation requirements, checks evidence, and admits integration at the exact verified revision. A failed assumption produces a specific replan or recovery obligation.

This design is grounded in overcenter-research main at `8f68ddd61a2a02aa0e36d1b8c0bf287da413c936`. It is a proposed design, not an implementation or a claim that current production satisfies it.

## Existing machinery

| Component | What exists | What needs connecting |
| --- | --- | --- |
| `scripts/plan-semantic-change.ts` | Git delta observation, exact expected/observed artifact comparison, assurance planning | Production source admission; immutable snapshot binding; conservative observation |
| `src/architecture/change-planner.ts` | Affected property propagation and minimum evidence cover | Coverage accounting and validation results bound to the transaction |
| `src/source/source-integration.ts` | Candidate inspection, writable-path bounds, verified-tree comparison, reserved remote CAS, readback, recovery outcomes | Exact planned write set and proof-plan admission |
| `src/authority/transaction-admission.ts` | Current authority and revision checks for execution/effects | Reuse these checks without a second authority mechanism |
| `test/fixtures/golden-transaction.ts` | Tiny change with expected write set, impacts and evidence | End-to-end production transaction regression |

The golden case and current semantic transaction tests exercise artifact-set comparison. Those tests alone do not establish an end-to-end transaction guarantee.

## Architectural choice

Extend the existing source lifecycle and durable authority facts. Keep SQL as a derived architecture and planning model. Keep repository commits and existing authority serialization as the authorities they already represent.

A separate transaction database would add reconciliation and another mutation boundary. Merely wrapping current scripts would leave correctness dependent on workers following instructions. Connecting the current source broker, planner, evidence admission and integration is the recommended approach.

## Transaction identity

Bind an immutable plan to the repository identity, source base commit, candidate commit and tree, architecture-model digest, dependency-observation digest, authorized write set, observed full write set, affected properties, required evidence, and current execution identity. Use canonical content identities and current source claim bindings already present in the repository.

The agent may propose intent and expected scope. It cannot supply authoritative observations, declare proof success, or mint integration authority. Free-form intent remains a judgment input; arbitrary natural-language intent is not promised to have a provably smallest realization.

## Observation and conservative planning

1. Read the base and candidate from immutable Git objects, using NUL-delimited paths and an explicit policy for additions, deletions, renames, modes and symlinks.
2. Enforce authorized scope against the complete repository delta. Keep semantic classification separate from this check.
3. Compare planned writes with observed writes. Missing or unexpected artifacts require replanning; they cannot be silently accepted by widening the plan.
4. Replace line-based comment stripping as a basis for omitting validation. Until a parser-backed classifier proves an omission safe, treat changed TypeScript as potentially semantic.
5. Observe dependency closures at both base and candidate. Use their union so removal of an import or trust root does not erase a dependency that still needs validation.
6. Account for every changed artifact. Missing source, unresolved dependencies, unsupported languages, unmodeled artifacts and missing evidence mappings produce explicit coverage gaps.
7. Coverage gaps prevent selective proof certification. Run an independently defined complete applicable validation baseline if one exists; otherwise return a specific unsupported obligation. A baseline can establish repository checks, not an unmodeled semantic property.
8. An architecture-model change requires reconciliation and conservative validation of properties from both model snapshots. Changes to the admission machinery need an independent baseline; a candidate cannot weaken its own gate.

The current observer strips lines starting with comment markers. Such lines can contain meaningful text inside a TypeScript template literal. This is sufficient reason not to use that heuristic as correctness authority.

## Evidence and integration

Deduplicate proof work across affected properties. Describe minimum evidence as minimum relative to the captured model, coverage and supported proof catalog; do not claim global semantic minimality.

Accept only trusted producer results bound to the exact candidate/tree, model, proof plan and execution context. Failed, skipped, missing, cancelled, stale or wrong-revision evidence cannot satisfy an obligation. Serialized agent claims are not trusted witnesses.

Before integration, re-establish current execution authority and source head. Reuse the existing reservation and verified-tree checks. Advance the source ref with the existing exact-base CAS. If the base moved, regenerate the candidate integration tree and revalidate affected assumptions; do not transplant old evidence automatically.

Separate candidate certification from source integration and authoritative settlement. A transport success response is insufficient for completion. An ambiguous mutation outcome creates a durable recovery obligation. Recovery observes repository identity, commit ancestry and the exact integration binding before settling; it does not blindly repeat a write.

## Durable lifecycle

Record the immutable plan and observations through existing content-addressed evidence and durable facts. Derive transaction state from those facts rather than maintaining a separate mutable status field.

The useful states are planned, candidate-observed, validation-required, verified, integration-reserved, integrated, and settled, with explicit replan-required, rejected and recovery-required outcomes. Implementation must map these into existing fact and projection contracts before adding new ones.

Resume after interruption by reconstructing facts and checking dynamic authority. Reuse evidence only where all identity and coverage bindings still hold. Unreferenced immutable objects never become authoritative merely because they exist.

## Delivery order

1. Make complete delta observation safe and test the golden case with real Git objects.
2. Bind immutable transaction plans and coverage to source candidate admission.
3. Connect proof planning to trusted exact-candidate evidence admission and integration.
4. Exercise interruption, concurrent head movement and ambiguous mutation recovery end to end.
5. Run a bounded Overcenter change through the production path, then an Azelficoast change through the same path. Identify remaining judgment inputs and deterministic software that replaced worker instructions.

Use small reviewable PRs, TypeScript for production semantics, existing proof and authority APIs, no new npm runtime dependencies, and no parallel backend architecture. Remove superseded orchestration as integration replaces it.

## Acceptance evidence

The production path must reject missing writes, extra writes, hidden executable changes, stale snapshots, removed dependencies, incomplete model coverage, forged evidence, incorrect proof-plan bindings, moved source heads and stale execution authority.

Crash tests cover interruption before reservation, after reservation, after remote commit but before response, and after observation but before settlement. Recovery must distinguish an observed committed transaction from an unresolved outcome without duplicate mutation.

A successful demonstration records planned and observed write sets, actual validation executed, candidate/tree identities, source CAS outcome, independently observed integration and reconstructed settled state. Verification includes strict TypeScript, lint, focused hostile regressions, and fresh hosted merge-gate evidence at each exact PR head.

## Completion boundary

Complete means these controls are exercised by production source work in both repositories, with independently reproducible evidence and documented unsupported cases. A design document, a green fixture, or a successful script run alone is insufficient.

## Review decision

Approve this architecture as the basis for a detailed implementation plan. The next review artifact will name exact changes and verification steps against refreshed repository state. No product code has been changed for this design.
