# Graduated Research and Proof Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep experiments/ limited to unanswered research while preserving completed safety results in production tests, tools, benchmarks, formal models, or capability-scoped hosted proofs.

**Architecture:** Move reusable checkers and hostile regressions to stable tooling/test paths before retiring experiment wrappers. Then remove completed experiment packages and workflow triggers, retaining hosted workflows where their permission split is itself the evidence. The ordinary production code path is not refactored except where a missing durable regression must be added.

**Tech Stack:** TypeScript, Node.js 22 test runner, GitHub Actions, TLA+, existing Overcenter static architecture and workflow-effect checks.

**Spec:** docs/superpowers/specs/2026-09-27-research-lifecycle-contract-authority-design.md

**Plan base:** `main` at `6b8dceb65fc231279ec1f0bcf78beefb65ccf75c` (442 tracked files; 26 workflows). Reconfirm the base before execution.

## Global Constraints

- Git history archives retired experiment scaffolding and outcomes; current experiments/ lists unanswered research.
- Preserve production semantics, hostile recovery coverage, authority boundaries, exact-head evidence, and fail-closed behavior.
- Keep codex-closed-loop, verified-generated-output, authority-storage-decomposition, distributed-authority-handoff, distributed-authority-chaos, and substrate-capability-admission.
- Keep scheduler TLA+ models and test/scheduler-service-age-promotion.test.ts.
- Keep the no-checkout worker boundary and ensure the worker has no write permission or execution capability.
- Preserve separate trusted broker/publication permissions; update .overcenter/architecture-intent.json and all workflow-effect checks when workflow paths or effects change.
- Retain the concurrency measurement as a benchmark, not an experiment or merge-gate check.
- Do not claim TCB savings until the final exact-head TCB report is regenerated.

## Review Focus

- Altered or omitted assignment bytes must be rejected before workspace materialization; cover in Task 2.
- Hostile paths, extra files, symlinks, duplicate entries, and unsupported file modes must fail closed; cover in Task 2.
- Loss of a worker must leave unresolved authority recoverable without blind replay; cover in Task 2.
- A worker token must lack provider write permission while only the trusted job can publish; verify in Task 6.
- Stale references to retired experiments in scripts, registry, statistics, source imports, or workflow intent must fail checks; cover in Task 5 and Task 6.

---

## File Structure

- scripts/authority-flow-analysis.ts — promoted static checker.
- test/authority-flow-analysis.test.ts — safe and hostile authority-flow regressions.
- test/assignment-capsule.test.ts and test/disposable-agent-recovery.test.ts — durable recovery and byte-boundary coverage.
- test/assignment-publication-boundary.test.ts — regressions for the permission-separated hosted publication path.
- benchmarks/core-loop-concurrency/ — reproducible manual throughput benchmark.
- proof/ — confinement, worker-client, and executor proof harnesses and launchers.
- experiments/README.md and experiments/registry.json — only maintained research inventory.
- .github/workflows/assignment-boundary-proof.yml — assignment-boundary hosted proof with job-level permission isolation.
- .github/workflows/github-provider-observation.yml — provider observation reads with its existing scoped permissions.
- .github/workflows/recovery-and-effect-boundary-proof.yml — separate worker, broker, and recovery trust domains.
- .github/workflows/ — no workflow exists solely to run a retired experiment.

### Task 1: Promote authority-flow analysis to normal tooling

**Files:**
- Move: experiments/authority-flow-analysis/analyzer.ts to scripts/authority-flow-analysis.ts
- Create: test/authority-flow-analysis.test.ts
- Delete: experiments/authority-flow-analysis/experiment.ts after coverage is moved
- Modify: package.json and .github/workflows/authority-flow-analysis.yml

**Interfaces:**
- Preserve exported analyzeProductionBoundary, analyzeSnippet, IssueCode, and FlowIssue interfaces from the current analyzer.
- Production-boundary analysis remains development/CI tooling and gains no runtime authority.

- [ ] Add named tests for the accepted trusted flow and hostile cases: raw agent data to mutation, missing mutation authority, serialization/queue authority decay, and dynamic dispatch with mixed call targets.
- [ ] Run: node --experimental-strip-types --test test/authority-flow-analysis.test.ts
  Expected: FAIL until the analyzer is promoted to scripts/.
- [ ] Move the analyzer without changing abstract-domain semantics; preserve stable issue codes and conservative joins.
- [ ] Run the test again; expect safe flows accepted and each hostile case rejected with its expected issue codes.
- [ ] Add the focused test file to package.json's ordinary test:unit command and remove the experiment runner command.
- [ ] Commit.

### Task 2: Graduate assignment and recovery regressions

**Files:**
- Move: experiments/assignment-capsule/contract.test.ts to test/assignment-capsule.test.ts
- Move: experiments/disposable-agent/disposable-agent.test.ts to test/disposable-agent-recovery.test.ts
- Create: test/assignment-publication-boundary.test.ts
- Modify: package.json and the assignment/recovery proof workflow sources

**Interfaces:**
- Continue testing src/execution/assignment-capsule.ts and GitOvercenterKernel through their existing exported APIs.
- The hosted no-checkout publication check uses separate materialize, no-permission worker, trusted write publisher, and read-only verification jobs.

- [ ] Add hostile assertions for altered bytes, missing required files, malformed/duplicate manifest paths, unexpected workspace files, symlinks, and unsupported modes using the production assignment verifier where it owns the invariant.
- [ ] Run the focused tests and confirm each hostile assertion fails if its corresponding production guard is removed.
- [ ] Move the disposable-agent recovery tests into test/ and preserve sandbox deletion, fresh-worker reconstruction, authority rotation, lost acknowledgement, missing authority, and CAS-race cases.
- [ ] Write a regression in test/github-actions-boundary.test.ts that asserts the combined assignment proof has separate assign/read, execute/no-permissions, publish/contents:write, and settle/read jobs; the worker job has no checkout or credential access.
- [ ] Combine assignment capsule and GitHub object transport into .github/workflows/assignment-boundary-proof.yml with those four job roles; retain trusted publication and canonical readback in the hosted proof.
- [ ] Add the moved test files to test:unit and update focused test scripts.
- [ ] Commit.

### Task 3: Retain existing graduated production proofs

**Files:**
- Keep: test/github-status-effect.test.ts
- Keep: test/kubernetes-configmap-core-loop.test.ts
- Keep: test/github-certified-read.test.ts and related provider tests
- Keep: test/source-obligation.test.ts
- Keep: test/scheduler-service-age-promotion.test.ts and formal/SchedulerLiveness.tla, formal/SchedulerServiceAge.tla

- [ ] Verify NOT_DISPATCHED regression cases distinguish pre-secureConnect failure (release allowed) from post-secureConnect failure and HTTP 502 (reservation remains unresolved).
- [ ] Verify Kubernetes tests reject same-name replacement with a different UID and stale watch continuity.
- [ ] Verify source-integration tests settle only from exact candidate identity and authoritative readback.
- [ ] Verify GitHub observation tests reject malformed or incomplete certified read results.
- [ ] Run the focused existing test commands before retiring wrappers; expect every promoted property to have a deterministic test.
- [ ] Confirm both scheduler TLA+ models and their configurations remain under formal/ and the service-age promotion test remains in the ordinary suite.
- [ ] Commit any missing production-backed tests.

### Task 4: Move core-loop concurrency to benchmarks

**Files:**
- Move: experiments/core-loop-concurrency/experiment.ts to benchmarks/core-loop-concurrency/benchmark.ts
- Move/update: experiments/core-loop-concurrency/README.md to benchmarks/core-loop-concurrency/README.md
- Modify: package.json

- [ ] Rename the command to bench:core-loop-concurrency and update usage instructions.
- [ ] Remove it from the maintained experiment registry, statistics gate, and hosted workflows.
- [ ] Keep the benchmark reproducible; do not add it to routine CI or alter runCoreLoop production behavior.
- [ ] Run: npm run bench:core-loop-concurrency
  Expected: completes and reports the existing throughput measures without changing test results.
- [ ] Commit.

### Task 5: Retire completed experiment scaffolding

**Files:**
- Delete these completed/falsified directories after their coverage has moved: adapter-uncertainty-exploration, transport-not-dispatched-evidence, github-status-not-dispatched-release, effect-authority-decay, source-obligation-integration, kubernetes-configmap-effect, github-observation-grammar, assignment-capsule, disposable-agent, github-object-transport, adapter-diagnosability, authority-flow-analysis, scheduler-liveness, scheduler-policy-comparison, and typed-capability-authority.
- Modify: experiments/README.md, experiments/registry.json, package.json, scripts/check-experiment-statistics.ts

- [ ] Confirm Tasks 1–4 have moved or retained all specified durable coverage.
- [ ] Remove only completed entries and commands; preserve the six unfinished lines from Global Constraints and any other still-live experiment.
- [ ] Run: npm run check:experiment-statistics
  Expected: PASS against only maintained sampled claims.
- [ ] Search package scripts, documentation, tests, workflows, and imports for every retired directory name; remove stale references.
- [ ] Commit the lifecycle cleanup.

### Task 6: Move proof-only code out of src/

**Files:**
- Move: src/execution/confinement/supervisor_proof.ts to proof/confinement/supervisor-proof.ts
- Move: src/execution/confinement/proof.sh to proof/confinement/proof.sh
- Move: src/execution/worker-client/proof.ts to proof/worker-client/proof.ts
- Move: src/execution/worker-client/proof.sh to proof/worker-client/proof.sh
- Move: src/execution/executor/containment/driver.ts to proof/executor/containment/driver.ts
- Modify: package.json, scripts/proof-production.sh, and any invoking workflows

- [ ] Add test/proof-layout.test.ts; it walks src/ and fails if proof.sh, proof.ts, supervisor_proof.ts, or executor/containment/driver.ts remains there.
- [ ] Run the layout regression and confirm it fails against the current tree.
- [ ] Move each harness and launcher, update relative imports and all callers, and keep executable permissions on shell launchers.
- [ ] Run: npm run proof:rust-exec && npm run proof:worker-client && npm run proof:production-boundary
  Expected: PASS from the new proof paths.
- [ ] Commit.

### Task 7: Consolidate workflows by permission and evidence boundary

**Files:**
- Modify/delete/rename workflows according to their required token permissions and evidence purpose.
- Modify: .overcenter/architecture-intent.json
- Modify: test/architecture-reconciliation.test.ts
- Modify: scripts/observe-architecture.ts and any workflow effect fixtures if path changes require them.
- Modify: src/README.md, experiments/README.md, relevant workflow documentation, and .overcenter/tcb-obligations.json.

- [ ] Retire the authority-flow-analysis, core-loop-concurrency, effect-authority-decay, and typed-capability-authority workflows once their local checks are in test:unit or benchmarks.
- [ ] Combine the assignment capsule and GitHub object transport proof workflow into one assignment-boundary proof only if job-level permissions remain: worker permissions: {}, separate trusted publisher contents:write, read-only verifier.
- [ ] Rename `.github/workflows/github-observation-grammar.yml` to `.github/workflows/github-provider-observation.yml`; retain its actions/checks/issues/pull-requests/statuses read scopes and keep it separate from ordinary CI.
- [ ] Rename `.github/workflows/disposable-agent-proof.yml` to `.github/workflows/recovery-and-effect-boundary-proof.yml`; preserve the worker, trusted effect-broker, and recovery jobs as separate permission domains.
- [ ] Update workflow path entries and explicit permission/effect grants in `.overcenter/architecture-intent.json`, `test/architecture-reconciliation.test.ts`, `scripts/observe-architecture.ts`, and workflow-effect fixtures as needed; verify direct effects and TypeScript transitive-effect reachability against final workflow entrypoints.
- [ ] Add a static regression that fails when retired experiment directory names remain in package scripts, experiment registry/statistics, workflow paths, or ordinary source imports.
- [ ] Replace the broken ADR-0009 link with the existing ARCHITECTURE.md#authority-confinement-and-effect-confinement section.
- [ ] Run: npm run test:unit && npm run typecheck && npm run lint && npm run test:formal && npm run test:architecture-reconciliation
  Expected: PASS with no experiment-path references from ordinary source or workflows.
- [ ] Run: npm run proof:production and every retained exact-head hosted capability proof.
  Expected: PASS with workflow run SHAs matching the exact branch head.
- [ ] Regenerate the TCB report at the final head; update only stale source paths and measurements.
- [ ] Commit.

### Task 8: Final exact-head evidence

- [ ] Run: npm test
  Expected: all ordinary deterministic tests pass.
- [ ] Run: npm run check:settlement-observation && npm run check:experiment-statistics
  Expected: both checks pass.
- [ ] Run: npm run proof:formal && npm run proof:production
  Expected: all required proofs pass.
- [ ] Wait for the exact-head Merge gate and retained hosted proof workflows; verify every result's head SHA equals the plan branch head.
- [ ] Review the final diff for behavior changes, stale experiment references, permission broadening, and deleted unique evidence.
- [ ] Commit any final documentation/evidence updates.

