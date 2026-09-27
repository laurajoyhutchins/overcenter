# Research lifecycle and contract authority cleanup

Status: Design and spec approved in conversation; implementation plans prepared for review.

## Baseline and intent

The audit reviewed main at c911b73729a8616389af8b0b1d53d3a6aa791942, where the Git tree contains 434 files and 26 GitHub workflows. Before this spec was written, main advanced to 26fb5892d24af317fc089c1f020df86e4832b848. That revision is 30 commits ahead and adds TypeScript workflow-effect reachability analysis plus related architecture reconciliation. It does not change the experiment, contract, proof-layout, or workflow files covered by this design. The tree then contained 438 files and 26 workflows. Main subsequently advanced to 6b8dceb65fc231279ec1f0bcf78beefb65ccf75c, 23 commits ahead; those commits continue workflow-effect reachability and architecture reconciliation without changing the cleanup files. The current tree contains 442 files and 26 workflows. Both implementation plans are based on this exact main head.

The goal is to make experiments/ contain unanswered research, with completed or rejected work retained in Git history and durable correctness moved to production tests, tools, or formal models. A second goal is to make contracts/ the actual structural authority it documents itself to be. This is repository lifecycle and boundary cleanup; it is not a broad production-code reduction.

## Constraints

- Preserve production semantics, authority boundaries, exact-revision checks, fail-closed behavior, and current hostile coverage.
- Keep unfinished research: codex-closed-loop, verified-generated-output, authority-storage-decomposition, distributed-authority-handoff, distributed-authority-chaos, and substrate-capability-admission.
- Preserve the current architecture-reconciliation checks for workflow permissions and direct effects, including the newer TypeScript transitive-effect reachability check. Workflow consolidation must update .overcenter/architecture-intent.json and remain consistent with those checks.
- Keep workflows separate whenever required permissions, secrets, credential ownership, network access, or trust domains differ. Workflow count is not itself a success criterion.
- Keep generated output distinct from authority: generation must be reproducible and checked against its source.
- Preserve the no-runtime-dependency property. Remove TypeBox only if repository-wide inspection confirms no other consumer.
- Do not claim a TCB reduction until the report has been rerun on the resulting exact revision.

## Research lifecycle changes

Retire the completed/falsified experiment scaffolding identified by the audit: adapter-uncertainty-exploration, transport-not-dispatched-evidence, github-status-not-dispatched-release, effect-authority-decay, source-obligation-integration, kubernetes-configmap-effect, github-observation-grammar, and typed-capability-authority. Retire the assignment-capsule and disposable-agent experiment wrappers after moving still-useful assertions to their lasting proof/test locations. Fold github-object-transport's unique permission-separated publication assertion into the assignment/worker boundary proof or a production regression before removing its experiment contract.

Move core-loop-concurrency out of maintained research and into benchmarks/ as a reproducible throughput benchmark. Keep it out of the research registry and routine merge gate. Retire adapter-diagnosability's experiment wrapper while keeping the generic diagnoser under scripts/ and its existing production-tool test. Promote the authority-flow analyzer from experiments/ into ordinary tooling and add hostile tests that exercise its trust-boundary conclusions.

Retire scheduler-liveness and scheduler-policy-comparison as experiments. Keep the TLA+ models under formal/ and retain the production service-age regression in test/. Keep production-backed tests for source obligations, Kubernetes ConfigMap effects, GitHub observation grammar, and NOT_DISPATCHED release semantics. Remove obsolete experiment commands, registry entries, statistical-gate entries, and workflows only after their durable equivalents are present.

## Contract authority

Make contracts/observation-evidence/schema.json the sole structural authority for SettlementObservation.

- Change scripts/generate-settlement-observation.ts to read the contract's SettlementObservation definition and generate only src/generated/settlement-observation-schema.ts.
- The generator must not import contracts/ TypeScript, src/model.ts, or TypeBox, and must not rewrite schema.json.
- Replace TypeBox-source projection tests with tests proving that changes to schema.json alter the generated runtime projection, that stale generated output is detected, and that runtime structural admission remains fail-closed.
- Preserve the existing conformance examples, semantic validation, provider-owned data annotations, and absence-evidence reference behavior.
- Remove settlement-observation.typebox.ts and the TypeBox dependency/tests after checking for every remaining repository use.
- Update contract and source-layout documentation to describe the one-way dependency: contract JSON to generated TypeScript to production consumers.

## Proof and documentation boundaries

Move src/execution/confinement/supervisor_proof.ts, src/execution/worker-client/proof.ts, and src/execution/executor/containment/driver.ts to test/ or scripts/ according to whether each is a test helper or launcher. Move the confinement and worker-client proof shell launchers from src/ to scripts/ or a dedicated proof/ directory. Update every caller, workflow, and package command; production imports must not point into proof-only code.

Fix the missing ADR-0009 link in src/README.md. The existing ARCHITECTURE.md section titled “Authority confinement and effect confinement” states the referenced policy, so link to that section instead of leaving a dead ADR reference or creating a duplicate decision record.

## Workflow consolidation

After experiment graduation, remove workflows whose only purpose was to run a retired experiment. Combine remaining proofs into a small number of capability-class workflows only when their permissions, secrets, execution boundary, and evidence requirements match. Do not combine credential-separated worker and trusted broker jobs into one trust domain. Keep merge-gate and operator workflows with their existing purpose.

Update .overcenter/architecture-intent.json whenever workflow paths or effects change. The static workflow scan, direct provider-effect observation, and TypeScript transitive-effect reachability must all agree with the final workflow set. Keep exact-head evidence and all provider-effect authority constraints intact.

## TCB accounting

Update .overcenter/tcb-obligations.json only as required by the new source inventory and regenerate the TCB report after the contract-source inversion. Record exact revision-bound measurements. Use the report to identify the next reduction target; this change does not include an unrelated attempt to remove the full broker-mutation-safety excess.

## Verification and acceptance

The change is acceptable when:

1. The experiment registry lists only live research questions; retired scaffolding and package/workflow references have been removed.
2. Every graduated claim still has its specified deterministic, hostile, formal, or hosted proof in its lasting location.
3. Scheduler liveness TLA+ models and the service-age regression remain available.
4. JSON Schema is the sole structural source for SettlementObservation; generation is deterministic; stale generated output fails verification; TypeBox is absent if no other consumer exists.
5. No proof-only harness remains under src/, and production code does not depend on test or script paths.
6. Documentation links resolve, including the source-layout policy link.
7. Workflow authority intent and all workflow-effect checks pass for the final workflow set. Trust boundaries and credential separation remain intact.
8. The ordinary test, typecheck, lint, contract-generation check, formal proof, production proof, and exact-head hosted merge gate pass as applicable to the changed surface.
9. The TCB report is regenerated from the final exact source revision, with no unsupported claim that file deletion alone reduced trusted-core size.

