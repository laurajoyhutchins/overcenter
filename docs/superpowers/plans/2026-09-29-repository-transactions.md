# Repository Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user chooses delegation. Steps use checkbox syntax for tracking.

**Goal:** Enforce evidence-backed source transactions through the existing production broker, hosted validation and source integration path, then demonstrate that path in Overcenter and Azelficoast.

**Architecture:** Observe immutable Git objects, bind conservative proof plans into existing durable authority history, and require trusted evidence before the existing reserved source CAS. Derive lifecycle state from facts and receipts. SQL remains a derived planning model; there is no new transaction backend.

**Tech Stack:** TypeScript, Git, Node SQLite, the pinned TypeScript compiler API, existing content-addressed evidence stores and GitHub Actions.

**Spec:** [Approved repository transaction design](../specs/2026-09-29-repository-transactions.md)

**Inspected revisions:** Overcenter `8f68ddd61a2a02aa0e36d1b8c0bf287da413c936`; Azelficoast `806630728b472ebaa11d5f991e72d306da90628a`. Refresh both before execution. Azelficoast currently pins Overcenter runtime `856b37b441b7a03943c110ed962d6a7850f973e0`.

## Global Constraints

- TypeScript for production semantics; no new npm runtime dependencies.
- Use small reviewable PRs, existing proof and authority APIs, and no parallel backend architecture.
- Remove superseded orchestration as integration replaces it.
- Agents propose intent and candidates; deterministic software owns observations and commit admission.
- Minimum evidence is relative to the captured model and coverage, never global semantic minimality.
- Candidate certification, source integration and authoritative settlement are separate milestones.
- Unknown coverage cannot silently become no impact. Preserve independently defined validation baselines.
- Every PR requires strict TypeScript, lint, focused hostile regressions and fresh hosted merge-gate evidence at its exact head.
- Observe hosted checks for at most three minutes per turn. Pending checks remain pending; do not substitute local results.

## Review Focus

1. Unusual Git paths and mode-only edits must not disappear during observation (Task 1).
2. Deleted imports, deleted trust roots and type-only changes must not erase validation obligations (Task 2).
3. Historical source tasks without a transaction plan must not bypass admission (Task 3).
4. Candidate changes to proof producers or workflow configuration must not weaken their own validation (Task 4).
5. Python source changes must remain explicitly outside TypeScript selective analysis, with baseline evidence required (Task 7).

## Delivery and execution preparation

Execute tasks sequentially, with a reviewable commit at each task boundary. Native execution is recommended because all tasks share the source protocol and evidence interfaces. This plan does not authorize independent product branches with different protocol designs.

- [ ] Read the spec and refresh exact main heads, local instructions and overlapping open PRs. Reuse compatible work already landed.
- [ ] Establish an isolated checkout using the worktree skill. Direct cloning was unavailable in this session because the configured network proxy was unreachable. Use GitHub connector reads to reconstruct the exact tree and validate its Git object identity if necessary; never treat a directory of downloaded files as verified source without checking it.
- [ ] Run baseline checks with repository-pinned tooling. Record unavailable tools or pre-existing failures before implementation.
- [ ] Track plan/spec files in the working branch under `docs/superpowers/`; the review copies linked here are not yet repository commits.

## Task 1: Complete immutable repository delta

**Files:** Create `src/source/repository-delta.ts`; modify `scripts/plan-semantic-change.ts`, `src/source/source-integration.ts`, `src/source/source-broker.ts`, `src/evidence/repository-snapshot.ts`, `package.json`; extend `test/semantic-transaction.test.ts` and `test/source-obligation.test.ts`; create `test/repository-delta.test.ts`.

**Interfaces:**

- `RepositoryDeltaEntry`: `path`, `before` and `after`; each side is null or `{ mode: string; object_id: string; object_type: 'blob' | 'commit' }`.
- `RepositoryDelta`: `base_revision`, `candidate_revision`, `candidate_tree`, and sorted `entries`.
- `observeRepositoryDelta(repo: string, baseSha: string, candidateSha: string): RepositoryDelta` reads exact commit objects, with NUL-delimited raw diff and rename detection disabled.
- `assertSupportedSourceDelta(delta: RepositoryDelta): void` permits regular files with modes 100644/100755; rejects symlinks, submodules, invalid paths and unsupported transitions with specific errors. Existing source path validation remains authoritative.
- Keep `semanticArtifactChanged(path, before, after): boolean` as byte/text inequality until safe semantic omission is implemented. Preserve `admitObservedSemanticDelta(expectedWriteSet, observedDelta)` and its divergence result.

- [ ] Write real-Git tests: template-literal lines starting `//` and `*` remain changed; comments-only changes remain conservatively changed; mode-only edits remain visible; rename is deletion plus addition; missing Git object throws; deletion yields a null after-side. Whitespace in file content is preserved.
- [ ] Test filenames with spaces and leading dashes as literal arguments; newline/tab paths are observed intact and rejected by source policy. Test symlink/submodule rejection before materialization and publication.
- [ ] Run the new tests against current code and record the failing assertions. The template-literal test must expose the current stripping heuristic.
- [ ] Implement the observer and remove comment-line stripping and broad missing-file catch behavior. Snapshot reads distinguish confirmed absence from a failed Git read. Share full-delta observation with candidate scope checks and proposal transport; no alternate filtered scope path remains.
- [ ] Run `node --experimental-strip-types --test test/repository-delta.test.ts test/semantic-transaction.test.ts test/source-obligation.test.ts`; run `npm run typecheck` and `npm run lint`. Add meaningful new tests to `test:unit`.
- [ ] Commit with message `fix: observe complete source transaction deltas`.

## Task 2: Conservative two-snapshot assurance planning

**Files:** Create `src/source/transaction-planner.ts`; modify `scripts/plan-semantic-change.ts`, `src/architecture/change-planner.ts`, `src/analysis/typescript-runtime.ts`; extend `test/architecture-reconciliation.test.ts`; create `test/transaction-planner.test.ts`.

**Interfaces:**

- `TransactionCoverageGap`: `{ artifact_id: string; reason: 'unmodeled-artifact' | 'unsupported-language' | 'unresolved-dependency' | 'source-unavailable' | 'evidence-unmapped' | 'model-changed' | 'validator-changed' }`.
- `TransactionAssurancePlan`: `base_revision`, `candidate_revision`, `candidate_tree`, `model_sha256`, `dependency_sha256`, sorted `changed_artifacts`, `impacts`, deduplicated `proof_plans`, sorted `coverage_gaps`, `validation_mode: 'selective' | 'baseline' | 'unsupported'`, and `baseline_id: string | null`.
- `planSourceTransaction(repo: string, delta: RepositoryDelta, policy: TrustedValidationPolicy): TransactionAssurancePlan` analyzes isolated base/candidate snapshots. `TrustedValidationPolicy` contains a baseline identifier/digest and validator artifact paths, supplied by trusted runtime configuration, never candidate text.
- Extend dependency reporting without changing existing callers: preserve `runtimeModuleClosure`; add planner-facing observation of both runtime and type-only module references. Type-only impact may be covered by mandatory strict type checking, but cannot be silently discarded.

- [ ] Write tests for the unchanged golden fixture's exact assurance impacts/evidence. Add import deletion, root deletion, import addition and type-only edit cases. A removed dependency remains in the base/candidate union.
- [ ] Add tests for every changed artifact being either covered or a named gap. A missing baseline produces `unsupported`; Python with a declared baseline produces `baseline` plus `unsupported-language`, not zero required checks.
- [ ] Add architecture SQL mutation tests: take properties and dependencies from both snapshots, require reconciliation, reject a candidate that deletes its own obligation mapping as sufficient selective evidence.
- [ ] Record failing tests, then implement immutable snapshot loading, closure union and canonical model/dependency digests. Ignore dirty working-directory state. Never catch analysis failure and return an empty impact set.
- [ ] Deduplicate repeated evidence producers across impacted properties, retaining all required obligation mappings. Preserve the existing exact cover algorithm and state its model-relative guarantee.
- [ ] Run `node --experimental-strip-types --test test/transaction-planner.test.ts test/architecture-reconciliation.test.ts`; run typecheck/lint and commit `feat: plan conservative source transaction evidence`.

## Task 3: Durable plan binding and candidate admission

**Files:** Create `src/source/transaction.ts`; modify `src/source/source-obligation.ts`, `src/source/source-broker.ts`, `src/source/source-integration.ts`, `src/authority/facts.ts`, `src/authority/replay.ts`, `src/authority/engine.ts`, `src/storage/git-store.ts`, `src/storage/sqlite.ts`; extend `test/source-obligation.test.ts`, `test/git-kernel.test.ts`, `test/sqlite-kernel.test.ts`; create `test/source-transaction.test.ts`.

**Interfaces:**

- Source task schema uses the stable name `overcenter-source-task` with explicit `schema_version: 2`, and adds required `expected_write_set: string[]`. `writable_paths` remains an authorization envelope; expected writes are an exact nonempty subset. Normalize legacy v1 inputs into an explicitly marked baseline-required path, never silently enable selective certification.
- `SourceTransactionPlan` binds numeric repository identity/full name, the existing `SourceClaimBinding`, execution generation/authority commit, runtime SHA, authorized/expected/observed path sets, and `TransactionAssurancePlan`. Closed interfaces and exact runtime validators are required.
- `sourceTransactionPlanDigest(plan: SourceTransactionPlan): string` uses existing `canonicalDigest` with a distinct domain.
- `SourceTransactionBindingFact` is one new fact schema `overcenter-source-transaction-binding` with `schema_version: 1`, run/obligation identity, current execution generation/authority commit, and immutable plan evidence reference plus digest. It adds no store or mutable status field.
- `KernelCore.bindSourceTransaction(permit: ExecutionPermit, plan: SourceTransactionPlan): string` validates current authority, publishes immutable evidence, and CAS-appends its binding. `KernelCore.sourceTransaction(runId: string)` reconstructs the authoritative binding or returns null.

- [ ] Write tests rejecting absent planned writes, extra observed writes, duplicate/invalid paths, expected paths outside authorization, wrong repository/base/tree, tampered plan digest, forged execution identity and stale generation.
- [ ] Test v1 compatibility: legacy source tasks are visibly baseline-required; omission of a binding at submission fails closed. Existing already-settled historical receipts remain readable without retroactive certification.
- [ ] Record failures; implement strict schema handling, one binding fact and replay/store support. Broker materializes candidate objects, observes/plans, binds through kernel authority, then publishes candidate; candidate publication never precedes successful binding. An orphaned immutable object is not authoritative.
- [ ] Add reconstruction tests in both stores: the same fact history yields the same binding; unavailable referenced evidence fails closed; a losing authority CAS cannot activate its plan.
- [ ] Run focused source/store tests, `npm run test:storage`, typecheck/lint; commit `feat: bind source transaction plans to authority history`.

## Task 4: Trusted hosted proof admission and integration gate

**Files:** Create `src/source/transaction-evidence.ts` and `scripts/record-source-verification.ts`; modify `src/source/source-integration.ts`, `src/authority/project-agent-protocol.ts`, `src/providers/github/source-bound-evidence.ts`, `.github/workflows/agent-candidate-signal.yml`, `.github/workflows/operator-project-submit.yml`; extend `test/project-agent-protocol.test.ts`; create `test/source-transaction-evidence.test.ts`.

**Interfaces:**

- `SourceTransactionVerification` uses stable schema `overcenter-source-verification`, explicit version 2, existing verification identities, transaction plan digest, trusted runtime/model/dependency digests and producer results.
- Each producer result has evidence identity, execution-context digest, required obligation mapping, workflow run/job/attempt identity, candidate SHA/tree, and artifact digest. Validate producer coordinates through existing certified GitHub reads and artifact verification.
- `admitSourceTransactionEvidence(plan: SourceTransactionPlan, verification: SourceTransactionVerification, trustedProducerObservations: readonly TrustedProducerObservation[]): SourceTransactionEvidenceAdmission` returns an admitted opaque witness or a rejected result with a stable reason. Only certified provider observations can construct `TrustedProducerObservation`; raw JSON cannot.
- `integrateVerifiedSourceCandidate` consumes this admitted witness for new source transactions; retain legacy settled-history decoding, never an unguarded new-integration entry point.

- [ ] Test failed, missing, cancelled, skipped, stale and wrong-attempt results; wrong repository/runtime/tree/model/dependency/plan digests; fabricated artifact identity; incomplete obligation coverage; conflicting duplicate producer results; raw witness forgery.
- [ ] Test producer self-modification: the candidate cannot change workflow path, job identity, required producer catalog or baseline definition accepted by the trusted command runtime. Such a change requires the independently anchored baseline or explicit unsupported outcome.
- [ ] Record failing tests; implement admission before effect authorization/reservation. Retain cheap mandatory merge checks and existing complete validation while selective execution is unproven. A selective plan alone never suppresses hosted gates.
- [ ] Replace the workflow's inline JavaScript verification writer with the typed trusted-runtime script. Record plan identity and individual required results. Verify run/artifact provenance at project.submit; do not trust a downloaded success field alone.
- [ ] Verify denied admission invokes no mutation/reservation; valid admission still requires current authority, exact source head and verified tree. Run evidence/protocol tests, typecheck/lint and workflow static checks.
- [ ] Commit `feat: require trusted transaction evidence before source integration`.

## Task 5: Recovery and interruption evidence

**Files:** Modify `src/source/source-integration.ts`, `src/authority/project-agent-protocol.ts`, `src/authority/engine.ts` only where regression evidence requires changes; extend `test/project-agent-protocol.test.ts`; create `test/source-transaction-recovery.test.ts`.

**Interfaces:** Preserve existing `RECOVERY_REQUIRED`, `REREALIZE_REQUIRED`, source integration witnesses, reservations and settlement receipts. Add transaction-plan binding to integration evidence using a stable schema with explicit metadata versioning. Derived transaction stages are observations of existing facts, not a new status authority.

- [ ] Use a local bare remote and real kernel history. Inject interruptions before reservation, after reservation, after successful remote CAS before response, and after readback before settlement. Assert no premature DONE and no duplicate mutation.
- [ ] Test concurrent source-head movement, generation rotation, remote unavailability, failed readback, divergent candidate identity and integrated commit beneath a later head. Exact ancestry/tree/transaction binding determines recovery; a matching message substring alone is insufficient.
- [ ] Record failures; add only missing recovery behavior. Persist plan/candidate identity before mutation. Retry observation and settlement after ambiguous dispatch; never replay the mutation while its reservation remains unresolved.
- [ ] Reconstruct kernel state in a new process after each fault. Assert exactly one source effect, one verified settlement, unchanged authority rules and the same transaction digest.
- [ ] Run recovery/protocol/store regressions, typecheck/lint; commit `test: verify source transaction interruption recovery` (use a fix message if production repair was necessary).

## Task 6: Overcenter production self-application

**Files:** Create `scripts/source-transaction-evidence.ts` and `test/source-transaction-report.test.ts`; modify `.github/workflows/self-application.yml` and `scripts/proof-self-application.sh`; extend `docs/operator-commands.md`. Keep the existing representative computation witness separate and accurately scoped.

**Interfaces:** `buildSourceTransactionReport` consumes independently verified plan, producer observations, integration witness and settlement receipt; emits schema `overcenter-source-transaction-evidence` with version 1. Report exact planned/observed sets, revision identities, executed validation, coverage gaps, CAS/readback outcome and reconstructed settlement. Report generation never mints authority.

- [ ] Write report tests rejecting missing lifecycle stages, copied receipts from another transaction, unverified integration and incorrect source identity.
- [ ] Implement reporting through existing evidence storage. Wire a hosted real source transaction using the unchanged golden intent: change only the status-description literal in `src/providers/github/status-effect.ts`. First check whether that exact edit is already present; if so, record a reviewed equivalent descriptive edit before staging rather than inventing a semantic change mid-run.
- [ ] Run it through assignment, broker, observed delta, plan binding, hosted evidence, reserved integration and reconstructed settlement. Check the golden expected property/evidence mappings and all actual additional mandatory baseline checks separately.
- [ ] Capture a negative run with an unexpected source path and show deterministic rejection before publication/integration. Capture the recovery cases from Task 5 as independent hostile evidence.
- [ ] Check fresh exact-head hosted evidence and produce a report. Remove superseded worker instructions that software now enforces; preserve instructions for semantic judgment.
- [ ] Commit the machinery/report changes and create reviewable PRs; do not describe a hosted run as successful before observing its evidence.

## Task 7: Azelficoast production validation

**Files:** In Azelficoast, modify `.overcenter/runtime.json` and `.github/workflows/ci.yml`; add `tests/hostile/test_overcenter_transaction_contract.py` only for meaningful external contract assertions. In Overcenter, extend the report producer from Task 6 and document Python selective-analysis limitations.

**Interfaces:** Reuse the transaction/evidence schemas unchanged. The Azelficoast policy marks Python selective analysis unsupported and binds baseline checks to the trusted runtime/control-plane source. Runtime pin names the exact verified Overcenter commit from Tasks 1–6.

- [ ] Test that a `.py` change cannot be certified from an empty TypeScript property set; it requires Python baseline evidence and retains the explicit coverage gap. Test candidate attempts to remove/rename required CI checks.
- [ ] Update the runtime pin in a separate reviewed commit after the runtime's hosted evidence is observed. Keep the pin change outside the agent's proposed source transaction; control-plane mutation remains forbidden to agents.
- [ ] Wire trusted candidate verification and submit using the same broker/admission interfaces. Run candidate Python code in a read-only, credential-free validation job; privileged integration runs only trusted runtime code after provider provenance checks.
- [ ] Use current trusted CI baseline commands: `uv run mypy`, `uv run ruff check .`, `uv run pytest`, `uv run pytest tests/hostile -m hostile_fast`, and the three existing reference/simulator experiment commands. Retain applicable Showdown static checks and any existing candidate gate. Do not replace strength evidence or change training/evaluator authority.
- [ ] Select one current non-control-plane descriptive source change only after refreshing source and authorized task state. Declare its exact write set before staging. Execute the same production lifecycle and capture independent integration/readback/settlement evidence.
- [ ] Run scope widening and stale-base negative controls. Produce a second report using the same schema; explicitly distinguish baseline validation from semantic proof coverage.
- [ ] Verify exact-head hosted gates and deliver the runtime-pin PR, contract PR and report. Completion requires both repositories' verified production transactions, not merely these PRs existing.

## Final verification and handoff

- [ ] Self-review every plan/spec requirement against implemented code and evidence. Identify unsupported cases with stable reasons; do not silently narrow the approved completion boundary.
- [ ] Run the repository-required verification once on the final exact head, broadening only for new changes or unresolved failures. Get an independent whole-branch review using the execution method selected by the user.
- [ ] Review diff scope, authority API surface and removed orchestration. Ensure no new lower-level mutation entry point bypasses transaction admission.
- [ ] Publish the exact-head evidence, two production reports, PR links and any remaining blocked stage. Pending hosted checks or unavailable deployment authority prevent a completion claim.

## Plan self-review

The seven tasks cover complete observation, immutable identity, dual-snapshot planning, coverage gaps, current authority, exact evidence, reserved integration, durable reconstruction, hostile recovery, and both production demonstrations. Each review-focus condition has an owning test. No claim is made that arbitrary natural-language intent can be minimized automatically, that SQL has complete semantic knowledge, or that external providers participate in a local atomic transaction.

The signatures above are proposed interfaces, not claims about functions already present. Existing public contracts must be migrated with fail-closed legacy handling and refreshed consumer checks. Detailed execution begins only after plan review and execution-method selection.
