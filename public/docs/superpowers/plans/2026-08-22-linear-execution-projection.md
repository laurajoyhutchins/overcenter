# Linear Execution Projection Implementation Plan

> Execute end-to-end. Do not stop after policy or queue audit.

1. Add focused policy tests for the typed dispositions, strict executable-action predicate, source-unit/canonical identity, phase-ticket exclusion, and bounded frontier behavior. Prove the new tests fail before implementation.
2. Implement the policy as a small shared module and contract `portfolio.reconcile_work_surface` to the minimal packet. Preserve compatibility only where it does not recreate duplicated authority.
3. Add eviction to reconciliation: closed source → Done; disposed/superseded repository → Canceled; explicit terminal/non-executable dispositions → truthful terminal state; terminal identities never resurrect.
4. Add project-frontier counting and enforce a frontier of three for `U.S. Jurisdiction Coverage`; allow source `unit_key` so one canonical roadmap issue can back multiple bounded units without duplicate Linear identity.
5. Add deterministic scheduled-cycle verification evaluation and receipt persistence; hook it into the existing integration deadline reconciler. Use `LJH-117` as the production regression case and settle it when the evidence predicate is satisfied.
6. Preserve `LJH-116` as a historical incident record while removing it from executable selection; keep corrective actions as independent work identities.
7. Update MCP/API documentation and control-plane architecture docs so workers/callers send executable facts rather than lifecycle essays, exact heads, or orchestration telemetry.
8. Inspect scheduled workers, Fast Forward, integration/verification guidance, and Engineering Agent Team instructions. Remove Linear grooming, phase-ticket creation, exact-head packet maintenance, and evidence-copy expectations.
9. Reconcile every current non-terminal `Ljh-projects` issue under the new dispositions. Keep only concrete executable, externally blocked, or human-waiting work. Retire disposed, superseded, duplicate, historical-only, deterministic, PR-phase, umbrella, speculative, and no-action clutter. Preserve IDs and relations.
10. Run focused policy/reconcile/deterministic-settlement tests, then the complete Portfolio Control Plane regression verification and live route diagnostics. Fix every failure.
11. Re-run reconciliation and the live queue scan to prove idempotency, bounded frontier replenishment behavior, no disposed work, no phase-ticket resurrection, and normal claim/settle operation on the reduced surface.