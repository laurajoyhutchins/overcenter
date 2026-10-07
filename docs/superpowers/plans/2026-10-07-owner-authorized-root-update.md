# Owner-Authorized Recovery-Root Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a read-only owner-dispatched root-update verifier, then use it to verify and settle the three-file logical-SLOC change and admit the hostile test separately.

**Architecture:** Execute structural verification and check orchestration from the accepted base in a separate checkout. Publish an exact verified receipt; Laura performs the final non-forced direct-child ref update through owner-authenticated access. The first verifier installation is a separate, explicitly reviewed bootstrap transaction.

**Tech Stack:** TypeScript 7.0.2, Node.js 22.16.0, Biome 2.5.14, Git, existing GCP GitHub Actions runners, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-owner-authorized-root-update-design.md`

## Global Constraints

- Repository: `laurajoyhutchins/overcenter`.
- Dispatch must use `main` and `GITHUB_ACTOR == GITHUB_REPOSITORY_OWNER`.
- Root verification runs from the accepted checkout; candidate content cannot supply its authority.
- Existing ordinary protected-source recovery keeps its root-path rejection.
- Workflow permissions remain `contents: read`; never pass an owner credential or write token to candidate checks.
- Exact repository, base, candidate, tree, one-parent ancestry, canonical write set, and reason are mandatory.
- Verification failure produces no authorization to transition.
- Installation bootstrap and TCB semantic-LOC update are separate transactions.
- Hostile regression test merges through ordinary source admission.
- First-version root capability is limited to `biome.json`, `scripts/report-tcb.ts`, and `src/analysis/tcb-semantic-loc.ts`. Exact submitted paths must equal the observed delta. Extending this capability or upgrading its own verifier/workflow requires a separately reviewed bootstrap.
- Do not claim a non-forced ref update is a general GitHub REST CAS API. Its race protection depends on the verified candidate being a single direct child of the exact base. Owner access and branch policy must permit the update; otherwise stop without changing policy.

## Review Focus

- A candidate edits package scripts, verification policy, or the root-update checker to turn a failed check green: reject before running it.
- Accepted and candidate metrics use different units: store them separately; only same-reporter comparisons may establish a TCB delta.
- A forged receipt or an artifact from another run/attempt is presented for settlement: reject unless authenticated workflow metadata and all exact bindings match.
- Evidence test source or candidate files move while checks execute: verify source digests before and after execution; reject mutation.
- Owner access cannot perform the final ref update: retain verification evidence and report the concrete blocker; never use a bot writer or change branch rules.

## Task 1: Exact root-update envelope

**Files:**
- Create: `scripts/verify-recovery-root-update.ts`
- Create: `test/recovery-root-update.test.ts`
- Leave unchanged: `scripts/verify-protected-source-recovery.ts`

**Interfaces:**
- Consumes: CLI authorization JSON path, candidate checkout path, and `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_ACTOR`, `GITHUB_REF`, `GITHUB_SHA`.
- Produces: `overcenter-recovery-root-update-structural-receipt/v1` JSON with repository, owner, base/candidate/tree SHAs, canonical paths, reason, authorization SHA-256, and bound evidence revision/path/blob SHA.
- Authorization schema: `overcenter-recovery-root-update-authorization/v1`; exact fields `schema`, `repository_full_name`, `base_sha`, `candidate_sha`, `candidate_tree_sha`, `writable_paths`, `reason`, `authorized_by`, `evidence_sha`, `evidence_path`, `evidence_blob_sha`.
- Evidence path is exactly `test/tcb-semantic-loc.test.ts`; revision is a full SHA and blob is a Git blob SHA. Read it from Git object storage, never from a movable ref.

- [ ] Write fixtures for owner/ref/base mismatch, extra authorization keys, malformed SHA/path, duplicate/unsorted paths, zero/multiple/wrong parents, tree mismatch, unexpected/renamed paths, self/workflow/policy/package mutations, evidence mismatch, and the accepted three-file envelope.
- [ ] Run `node --experimental-strip-types --test test/recovery-root-update.test.ts`; confirm the missing checker fails.
- [ ] Implement the CLI with Node builtins and Git plumbing. Read policy from the accepted base, validate exact input keys, require the fixed first-version capability, compare the observed no-renames delta, verify evidence Git object and digest, and emit structural output only after every check passes.
- [ ] Run the fixture command and existing `test/protected-source-recovery.test.ts`; confirm hostile rejections and unchanged ordinary root rejection.
- [ ] Commit the checker and fixtures.

## Task 2: Accepted checks, candidate checks, and exact evidence

**Files:**
- Create: `scripts/check-recovery-root-update.ts`
- Create: `test/recovery-root-update-checks.test.ts`

**Interfaces:**
- Consumes: accepted checkout path, candidate checkout path, structural receipt path, output directory.
- Produces: `overcenter-recovery-root-update-verification/v1` JSON with structural bindings; check executable/config source digests; accepted and candidate lint/typecheck/unit/TCB results; hostile-test source digest/result; before/after candidate tree/content digests; report digests.
- Exit nonzero on any required failure; never mint a verified receipt from a supplied result string.

- [ ] Write integration fixtures in which candidate package scripts, lint config, unit-test discovery, or a fake receipt attempt to skip checks. Include a check-time source mutation fixture and a failing hostile test.
- [ ] Run `node --experimental-strip-types --test test/recovery-root-update-checks.test.ts`; confirm red.
- [ ] Implement accepted-check orchestration from the accepted checkout. Materialize a disposable candidate projection with accepted `package.json`, `biome.json`, `tsconfig.json`, lint/test/report drivers and their accepted authority-module imports, and accepted baseline test roots. Record the projection manifest and its hash. Do not label this projection as the exact candidate tree.
- [ ] Use the accepted dependency pins and lint version. Run accepted lint, typecheck, baseline tests, and TCB reporting in that projection. Run candidate lint, typecheck, unit tests, and TCB reporting separately against an untouched candidate checkout. No candidate npm script controls accepted execution.
- [ ] Materialize only the bound hostile test file in a disposable candidate evidence checkout, execute it, then verify the candidate and evidence content digests again. Keep this evidence overlay distinct from the authorized three-file write set.
- [ ] Run the candidate reporter with `--baseline <base_sha> --output <report.json>`. Verify that the baseline and candidate calculations use the same logical-SLOC reporter and declare `typescript-logical-sloc/v1`; retain accepted-reporter results as a separate compatibility observation.
- [ ] Run fixture tests and the full accepted repository check chain; confirm only genuine subprocess results can produce a verification result.
- [ ] Commit the check runner and fixtures.

## Task 3: Owner dispatch and receipt publication

**Files:**
- Modify: `.github/workflows/protected-source-recovery.yml`
- Extend: `test/recovery-root-update-checks.test.ts`

**Interfaces:**
- Consumes: existing exact recovery tuple, explicit mode defaulting to `protected-source`, and root-mode evidence SHA/blob SHA.
- Produces: `overcenter-recovery-root-update-receipt/v1` artifact named with candidate SHA, run ID, and attempt; receipt contains all structural and verification bindings and status `verified-awaiting-owner-transition`.
- Ordinary mode preserves its current authorization schema, accepted verifier, and checks.

- [ ] Write workflow fixtures requiring owner-only main dispatch, read-only permissions, accepted-base checker paths, exact candidate checkout, evidence object binding, failure gating, and no candidate-supplied checker or write credential.
- [ ] Add root-mode inputs and mutually exclusive ordinary/root execution. Install the accepted toolchain in the trusted checkout and materialize candidate tooling separately. Keep actions pinned to the current immutable SHAs.
- [ ] Mint the verified root receipt only after the accepted check runner exits successfully; upload it with `if-no-files-found: error`. Include run/attempt and artifact/report digests. Do not write `main`.
- [ ] Run workflow fixtures, lint, typecheck, unit tests, and TCB checks. Inspect the exact bootstrap delta and review checker imports/permissions.
- [ ] Commit workflow wiring and tests.

## Task 4: Bootstrap installation and settlement record

**Files:**
- Add after settlement: `docs/recovery-receipts/2026-10-07-root-update-bootstrap.json`

**Interfaces:**
- Consumes: exact bootstrap base/candidate/tree/path tuple, independently observed test results, and owner-authenticated ref access.
- Produces: settled bootstrap receipt with authorizing owner, evidence locations/digests, observed before/after ref SHAs, candidate tree, and actual operation result.

- [ ] Revalidate current `main`; inspect changes since the implementation base and recut only the implementation files as one direct child. Keep design/plan documents and the TCB change out of the bootstrap candidate.
- [ ] Obtain independent review of the exact bootstrap verifier/workflow diff. Run the accepted check chain plus all new hostile fixtures; bind evidence to the exact bootstrap SHA/tree. Do not use the uninstalled root checker as the authority that admits itself.
- [ ] Present the complete exact bootstrap tuple and evidence to Laura for explicit bootstrap authorization. Implementation approval is not proof that an unknown later tuple was authorized.
- [ ] Through owner-authenticated access, verify live `main == base` and perform a non-forced direct-child ref update. If the owner operation is unavailable or rejected by branch policy, stop before mutation and report it; do not use the connector's app identity as a substitute.
- [ ] Read back the resulting SHA/tree. Append the independently produced settlement receipt in a separate ordinary documentation change.
- [ ] Dispatch the installed root mode for the TCB tuple only after installation read-back confirms the accepted checker/workflow.

## Task 5: Logical-SLOC core and ordinary hostile test

**Files:**
- Protected core: `biome.json`, `scripts/report-tcb.ts`, `src/analysis/tcb-semantic-loc.ts`
- Ordinary test: `test/tcb-semantic-loc.test.ts`

**Interfaces:**
- Consumes: installed accepted root updater, fresh core tuple, exact test source revision/blob from draft PR #683.
- Produces: successful root verification receipt, owner-settled core SHA/tree, and independently verified/merged test-only PR.

- [ ] Revalidate `main` and overlap. Mechanically recut the intended protected contents as one direct child when safe; retain the exact three-file delta.
- [ ] Fetch the exact hostile test object from #683 and review that it tests normal, minified, reflowed and comment-heavy equivalent programs plus nested syntax deduplication. Bind its revision/blob in owner dispatch.
- [ ] Follow the owner-dispatched root run through all structural, accepted, candidate, same-basis TCB, hostile evidence, and receipt steps. Inspect logs for real failures; repair the smallest cause and recut against then-current `main`.
- [ ] Present the verified receipt and exact core tuple for the owner transition; perform only the authorized direct-child non-forced update and read back SHA/tree.
- [ ] Recut only the hostile test onto new `main`; use ordinary source admission and exact-candidate verification, then merge after evidence passes.
- [ ] Report bootstrap/core tuples, run IDs/URLs, every required check outcome, settled `main`, test PR/merge result, and any concrete remaining gap.

## Execution method and review

Recommended method: native execution in this session. The tasks share a small authority surface and require careful sequential bootstrap and settlement. Independent review remains mandatory before bootstrap installation; use an available qualified reviewer after implementation, with delegation only if Laura authorizes that review method.

This plan intentionally freezes the first updater's own verifier/workflow and narrows its initial writable capability. A future updater upgrade is a new explicit bootstrap review; it is not an exception input that candidates can enable.

No implementation starts until this written plan is reviewed and an execution method is selected.
