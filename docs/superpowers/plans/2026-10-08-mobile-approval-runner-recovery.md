# Mobile Owner Approval for Runner Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the #689 runner autoscaler recovery behind an immutable, owner-reviewed GitHub Mobile request, then execute the existing recovery operation only after revalidation and independently record settlement.

**Architecture:** A trusted workflow on `main` prepares a read-only manifest for the current accepted infrastructure revision and waits at the existing main-only environment. A separate post-approval job revalidates the same request before using the existing WIF identity and deployment script. Start with the operation-level readback canary; enable deployment only after that benign exact operation is approved and independently verified.

**Tech Stack:** TypeScript, Node.js native test runner, GitHub Actions, GitHub run-approvals API, Google Workload Identity Federation, existing `gcloud` deployment script.

**Spec:** `docs/superpowers/specs/2026-10-08-mobile-approval-runner-recovery-design.md`

## Global Constraints

- The protected environment stays restricted to `main`, requires `laurajoyhutchins`, and keeps administrator bypass disabled.
- The request workflow is trusted `main` source; never widen environment branches to include candidate workflow code.
- No provider API, cloud credential, ID token, or mutation runs before owner approval.
- Use the existing `overcenter-deployer` WIF principal and `infra/gcp/deploy-runner-autoscaler.sh`; do not add IAM roles or GitHub secrets.
- Bind the accepted base, infrastructure head/tree, workflow and script digests, fixed resource set, privilege ceiling, expiry, request ID, reason, and impact in the reviewed manifest.
- Reject non-owner initiation/review, changed or stale revisions, failed provenance checks, expired requests, reruns, replay, unavailable review evidence, and scope drift before provider mutation.
- Keep the #695/#704 owner-only direct dispatch path from becoming an unreviewed bypass; do not activate or merge either path without this gate.
- **Protected-source precondition:** do not change `.github` through ordinary source admission or the current recovery verifier. Start workflow tasks only after an independent, accepted, owner-authorized control-plane source transition exists for the exact candidate.
- Keep #702 open until the approved/rejected mobile canaries, harmless exact operation, independent readback, and durable settlement evidence all pass.

## Review Focus

- **Non-owner or rerun actor:** no request reaches an approval gate or executor; test rejected dispatch and `run_attempt > 1`.
- **Manifest substitution or infrastructure head movement:** approval cannot authorize a different tree or script; test digest mismatch and stale-ref rejection.
- **Wrong reviewer or missing review API evidence:** no WIF authentication occurs; test wrong reviewer, rejection, and unavailable API evidence.
- **Expired, duplicate, or replayed request:** no second execution occurs; test expiration and same request/run attempt replay.
- **Partial deployment or unclear provider response:** receipt reports indeterminate settlement and does not retry mutation; test postcondition/readback failure classification.
- **Unreviewed direct dispatch:** no standalone workflow can invoke the deployment script without the protected request gate; test workflow permission and call-path boundaries.

---

## Execution Gate

Before Task 2, verify that an independent protected-source transition mechanism has been accepted and is authorized for the exact workflow candidate. If it is absent, stop after any code-only work in Task 1; do not submit or merge a protected workflow edit through another route. The current verifier's rejection of `.github` is intentional evidence of this gate.

## Task 1: Request and receipt contract

**Files:**
- Create: `scripts/runner-recovery-approval.ts`
- Test: `test/runner-recovery-approval.test.ts`

**Interfaces:**
- `RunnerRecoveryManifestInput` contains `repositoryFullName`, `acceptedBaseSha`, `targetRef`, `targetSha`, `targetTreeSha`, `workflowBlobSha`, `scriptBlobSha`, `evidenceRefs`, `resources`, `identityPrincipal`, `privilegeCeiling`, `runId`, `runAttempt`, `createdAt`, `expiresAt`, `requestedBy`, `reason`, `humanImpact`, and `sideEffects`; the builder derives `request_id` as `runId.runAttempt`.
- `createRunnerRecoveryManifest(input: RunnerRecoveryManifestInput): { manifest: RunnerRecoveryManifest; canonicalJson: string; sha256: string }` validates fixed operation/scope constants and returns canonical serialized bytes plus their SHA-256.
- `RunnerRecoveryReviewInput` contains `evidenceAvailable`, normalized `approvals`, `expectedEnvironment`, `expectedReviewer`, `gateJobResult`, `requestId`, `runAttempt`, and `now`.
- `classifyRunnerRecoveryApproval(input: RunnerRecoveryReviewInput): RunnerRecoveryReviewReceipt` preserves review state, reviewer login/comment when present, and a truthful outcome.
- `RunnerRecoverySettlementInput` contains the review receipt, request/run identity, operation result, and independent readback result.
- `settleRunnerRecovery(input: RunnerRecoverySettlementInput): RunnerRecoverySettlementReceipt` distinguishes settled, failed, stale, rejected, and indeterminate outcomes without retrying the operation.

- [ ] **Step 1: Write failing tests** for canonical manifest digest, required accepted base and exact target, fixed operation/resource/identity scope, rejection, owner approval, wrong reviewer, unavailable evidence, expiration, and indeterminate settlement.
- [ ] **Step 2: Run focused tests and confirm expected failures** with `node --experimental-strip-types --test test/runner-recovery-approval.test.ts`.
- [ ] **Step 3: Implement the three typed functions** using canonical JSON and the repository's existing validation helpers; keep provider I/O outside this module.
- [ ] **Step 4: Re-run focused tests, then `npm run lint`, `npm run typecheck`, and `npm run test:unit`.**
- [ ] **Step 5: Commit the code-only change** and verify its normal source-profile checks; do not include `.github` files in this commit.

## Task 2: Trusted approval and readback-canary workflow

**Files:**
- Create: `.github/workflows/gcp-runner-autoscaler-approval-canary.yml`
- Test: `test/gcp-runner-autoscaler-approval-workflow.test.ts`

**Interfaces:**
- Consumes the manifest/receipt functions from Task 1.
- Produces an owner-only workflow dispatched from `main`; its only provider operation is an exact, read-only runner-service inspection.

- [ ] **Step 1: Write failing workflow-boundary tests** for main-only workflow provenance, owner-only dispatch, reason-only input, immutable manifest before environment wait, no pre-approval provider or credential steps, and no `id-token: write` before the approval dependency.
- [ ] **Step 2: Run the focused test and confirm it fails** because the trusted workflow does not exist.
- [ ] **Step 3: Add the canary workflow** with top-level permissions none; read-only GitHub preparation; a no-permission `overcenter-owner-approval` job; and a post-approval job that verifies the exact GitHub reviewer record before using the existing WIF identity for read-only service inspection.
- [ ] **Step 4: Verify the postcondition** against independently fetched service state and upload a durable receipt containing decision, reviewer, request/run IDs, target, manifest digest, and readback.
- [ ] **Step 5: Run focused workflow tests and all repository checks.**
- [ ] **Step 6: Submit this protected workflow only through the independent source-transition gate.** Stop if the gate is unavailable or any review value changed.

## Task 3: Live canary and harmless operation evidence

**Files:**
- No source edits; record run URLs and immutable receipt digests in the #702 evidence comment.

- [ ] **Step 1: Dispatch the readback canary from trusted `main`** and inspect its exact manifest before the environment wait.
- [ ] **Step 2: Reject one run from the iPhone push notification** and verify the GitHub review record, no WIF step, and rejected receipt.
- [ ] **Step 3: Approve a separate run from the iPhone push notification** and verify the reviewer identity, read-only GCP inspection, independent readback, and settled receipt.
- [ ] **Step 4: Confirm the two request IDs and manifests differ** and neither run invoked the deployment script.

## Task 4: Gate the existing recovery executor

**Files:**
- Modify: `.github/workflows/gcp-runner-autoscaler-approval-canary.yml`
- Modify or retire: `.github/workflows/gcp-runner-autoscaler-recovery.yml` and the corresponding #695/#704 proposals
- Test: `test/gcp-runner-autoscaler-approval-workflow.test.ts`

- [ ] **Step 1: Add failing tests** requiring execution to consume the approved manifest, reject any changed infrastructure head/tree/script digest, use the existing `overcenter-deployer` identity, and invoke only `infra/gcp/deploy-runner-autoscaler.sh` at the approved SHA.
- [ ] **Step 2: Run focused tests and confirm expected failures.**
- [ ] **Step 3: Add the deployment job after the protected approval and revalidation jobs.** Grant `id-token: write` only to this post-approval job; preserve exact-ref checkout, current-head comparison, accepted source evidence, and the existing script.
- [ ] **Step 4: Ensure no independent owner-manual dispatch can bypass the gate.** Recast or close #695/#704 only after the protected gated path is reviewed and accepted; keep the ordinary self-hosted deployment as the default.
- [ ] **Step 5: Run the workflow tests and all repository checks; pass the protected workflow through the independent transition mechanism.**

## Task 5: Hostile verification and settlement

**Files:**
- Modify: `test/runner-recovery-approval.test.ts`
- Modify: `test/gcp-runner-autoscaler-approval-workflow.test.ts`

- [ ] **Step 1: Add hostile tests** for actor/rerun substitution, owner review mismatch, missing approvals API evidence, expiry, replay, changed branch head/tree, source-check failure, resource-scope drift, concurrency, and partial/unclear provider outcome.
- [ ] **Step 2: Verify each hostile case fails before WIF authentication or deployment-script invocation.**
- [ ] **Step 3: Verify rejection, failure, and indeterminate outcomes still publish truthful durable receipts with reviewer/run/request identities where available.**
- [ ] **Step 4: Run `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run check:tcb` on the exact candidate.**
- [ ] **Step 5: Re-read the final workflow and environment settings; verify main-only scope, required reviewer, disabled bypass, least job permissions, and no secrets or extra IAM.**

## Plan self-review

- Spec coverage: manifest, immutable owner gate, post-approval identity, exact revalidation, replay/expiry, readback, settlement, canary, hostile cases, and protected-source precondition each have a task.
- Step precision: tests precede implementations; each workflow task names the files, gates, and checks; no protected workflow edit is scheduled before its separate prerequisite.
- Review focus: all six input/failure classes above have named tests or live checks.
- Scope: one existing operation (#689) and one operation-level read-only canary; no universal admin shell or new IAM.
