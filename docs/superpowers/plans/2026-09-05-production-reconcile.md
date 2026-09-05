# Intent-First Production Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `production.reconcile({ repo })` the repo-only operator-facing command that safely converges verified `dev`, Git production, and the immutable Hatchable runtime to one exact revision.

**Architecture:** Add a pure convergence coordinator that composes the existing exact-SHA promotion and deterministic materialization contracts through an Overcenter host adapter. Keep GitHub as source authority and require fresh post-effect/readback evidence before proceeding to the next external mutation or returning success.

**Tech Stack:** Node.js ESM, TypeScript semantic contracts, Hatchable V8 runtime, GitHub App transport, GitHub Actions, Node test runner, Overcenter semantic-command/MCP surfaces.

**Spec:** `docs/superpowers/specs/2026-09-05-production-reconcile-design.md`

## Global Constraints

- Public input is exactly `{ repo }`; no caller-selected branch, SHA, verification run, Hatchable coordinate, runtime ref/version, or idempotency key.
- Reuse the existing exact-SHA production promotion and production materialization safety contracts; do not reimplement them more weakly.
- Materialization is forbidden until authoritative post-promotion Git readback proves the selected exact SHA is production.
- Historical workflow success is not fresh runtime evidence.
- Preserve `may_have_mutated`; never blind-retry an indeterminate external effect.
- Final success requires fresh evidence that Git production and verified immutable runtime name the same exact 40-character SHA.
- Keep lower-level promotion/materialization primitives available.
- Do not claim to solve Hatchable #161.

---

### Task 1: Pure production convergence coordinator

**Files:**
- Create: `lib/production-reconcile-operation.js`
- Test: `scripts/production-reconcile-operation.test.mjs`

**Interfaces:**
- Consumes: dependency-injected observations and lower-level promotion/materialization functions.
- Produces: `reconcileProduction(intent, ports)` returning converged/no-op evidence or a fail-closed error with mutation certainty.

- [ ] **Step 1: Write the disposable-caller failing regression**

Construct ports where development is exact verified SHA `aaaaaaaa...`, production/runtime are stale, and assert the call order:

```js
const result = await reconcileProduction({ repo:'owner/repo' }, ports);
assert.deepEqual(calls, [
  'observe',
  'verify-dev',
  'promote',
  'read-production',
  'materialize',
  'final-observe',
]);
assert.equal(result.production_revision, SHA);
assert.equal(result.runtime_revision, SHA);
```

Also assert `materialize` has not been called before `read-production` proves `SHA`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/production-reconcile-operation.test.mjs
```

Expected: failure because the coordinator does not exist.

- [ ] **Step 3: Implement the smallest coordinator**

Implement a pure state machine that observes facts, chooses at most the next safe effect, rereads authority after mutation, and returns only after final same-SHA proof.

- [ ] **Step 4: Add failure/no-op cases**

Cover already-converged no-op, production-current/runtime-stale, missing verification, production drift, indeterminate promotion, immutable deployment mismatch, and final readback drift.

- [ ] **Step 5: Run focused tests and commit**

```bash
node --test scripts/production-reconcile-operation.test.mjs
```

Expected: PASS.

Commit: `feat: add production reconciliation coordinator`

### Task 2: Overcenter host adapter and fresh runtime evidence

**Files:**
- Create: `lib/production-reconcile-overcenter-host.js`
- Create: `scripts/production-runtime-observation-http.mjs`
- Test: `scripts/production-reconcile-host.test.mjs`
- Test: `scripts/production-runtime-observation-http.test.mjs`

**Interfaces:**
- Consumes: stored branch roles, GitHub App exact-head reads, existing `productionPromotionFor`, deterministic materialization operation, and runtime observation HTTP surface.
- Produces: `productionReconcileFor({ db, ...ports }).reconcile({ repo })` with normalized exact evidence.

- [ ] **Step 1: Write a failing host composition test**

Assert the host derives branch roles and exact coordinates internally and forwards only derived exact identity to lower-level ports.

- [ ] **Step 2: Write the stale-history regression**

Give the host a historical successful materialization workflow record but a fresh runtime observation whose receipt names a different SHA. Assert reconciliation refuses to call the runtime converged.

- [ ] **Step 3: Run host tests and verify RED**

```bash
node --test scripts/production-reconcile-host.test.mjs scripts/production-runtime-observation-http.test.mjs
```

- [ ] **Step 4: Implement the host and fresh observer**

Resolve repository roles, exact Git heads, verification evidence, promotion, runtime observation, and materialization through existing boundaries. Normalize all SHAs to full lowercase 40-character identities.

- [ ] **Step 5: Run focused tests and commit**

Expected: both test files PASS.

Commit: `feat: bind production reconciliation to fresh runtime evidence`

### Task 3: Harden production materialization workflow readback

**Files:**
- Modify: `.github/workflows/production-materialization.yml`
- Create: `scripts/production-materialization-head-fence.mjs`
- Test: `scripts/production-materialization-recovery-workflow.test.mjs`

**Interfaces:**
- Consumes: exact production Git coordinate and fresh immutable runtime receipt.
- Produces: serialized workflow behavior that refuses stale-head or historical-success substitution.

- [ ] **Step 1: Write workflow regression tests**

Assert the workflow runs the exact-head fence and current runtime observation before concluding convergence.

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/production-materialization-recovery-workflow.test.mjs
```

- [ ] **Step 3: Add the exact-head fence helper and workflow wiring**

The helper must reject when the observed production branch head differs from the selected exact SHA and must not reinterpret an old successful workflow run as present runtime state.

- [ ] **Step 4: Run the workflow regression and commit**

Commit: `fix: require fresh production materialization readback`

### Task 4: Publish the repo-only semantic command

**Files:**
- Create: `mcp/production.reconcile.js`
- Modify: `lib/semantic-command-descriptors.js`
- Modify: `src/semantic/semantic-command-descriptors.ts`
- Modify: `lib/canonical-commands.js`
- Modify: `src/semantic/canonical-commands.ts`
- Modify: `lib/worker-transport.js`
- Modify: `lib/github-app-auth.js`
- Test: `scripts/verify-semantic-command-descriptors.test.mjs`

**Interfaces:**
- Consumes: `productionReconcileFor` host.
- Produces: canonical semantic command `production.reconcile` exposed through worker transport and MCP with input schema `{ repo }` only.

- [ ] **Step 1: Add schema rejection tests**

For each mechanical field (`branch`, `sha`, `candidate_sha`, `verification_run_id`, `hatchable_project`, `runtime_ref`, `runtime_version`, `idempotency_key`), assert descriptor validation rejects the request.

- [ ] **Step 2: Run descriptor tests and verify RED**

```bash
node --test scripts/verify-semantic-command-descriptors.test.mjs
```

- [ ] **Step 3: Add canonical descriptor, transport, and MCP adapter**

The MCP adapter must delegate directly to the semantic descriptor/host and must not expose a second schema authority.

- [ ] **Step 4: Run focused descriptor tests and commit**

Commit: `feat: expose production reconcile semantic command`

### Task 5: Operator documentation and canonical test registration

**Files:**
- Create: `public/docs/production-reconciliation.md`
- Modify: `public/docs/semantic-command-descriptors.md`
- Modify: `scripts/test.mjs`

**Interfaces:**
- Produces: documented normal production path and inclusion of focused regressions in the canonical developer test front door.

- [ ] **Step 1: Document the normal operator path**

Show:

```text
production.reconcile({ repo })
  -> observe
  -> promote exact verified dev if needed
  -> reread production
  -> materialize exact production if needed
  -> immutable runtime verification
  -> fresh final same-SHA proof
```

State explicitly that `production.promote` and materialization remain lower-level primitives.

- [ ] **Step 2: Register focused tests in `scripts/test.mjs`**

Include coordinator, host, runtime-observation, workflow-recovery, and descriptor regressions.

- [ ] **Step 3: Run the repository developer front door**

```bash
node scripts/test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

Commit: `docs: make production reconcile the normal promotion path`

### Task 6: Regenerate contract evidence

**Files:**
- Modify: `generated/contracts/catalog.json`
- Modify: `docs/generated/data-contracts.md`
- Modify only if generator output changes it: `docs/generated/data-contract-authority-atlas.md`

**Interfaces:**
- Consumes: current semantic descriptors and MCP projections.
- Produces: generator-exact contract evidence for the final candidate.

- [ ] **Step 1: Run the canonical contract-evidence generator once**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md \
  --atlas docs/generated/data-contract-authority-atlas.md
```

- [ ] **Step 2: Verify committed evidence**

Run the contract-evidence check against the generated outputs and require byte-for-byte agreement.

- [ ] **Step 3: Run the historical unclassified ratchet**

Compare against the merge base and require that no new unrelated unclassified debt replaces old debt.

- [ ] **Step 4: Commit exact generator output**

Commit: `chore: refresh production reconcile contract evidence`

### Task 7: Exact-head integration and production proof

**Files:**
- No new implementation files.

**Interfaces:**
- Consumes: GitHub PR exact-head checks, `github.integration.reconcile`, exact-revision V8 verification, existing production bootstrap promotion/materialization, then deployed `production.reconcile`.
- Produces: integrated `dev`, settled project transition, deployed production, and live packet proof that the new normal operator returns verified convergence.

- [ ] **Step 1: Require fresh PR-head CI**

Do not reuse checks from an earlier branch head. Required repository and exact-revision checks must pass for the exact final PR head after any update-branch operation.

- [ ] **Step 2: Integrate through `github.integration.reconcile`**

Fence the exact PR head. If the base moves, update the branch and repeat Step 1. Merge only when the operator reports all requirements satisfied.

- [ ] **Step 3: Require exact-revision verification on resulting `dev`**

Record the successful V8 run ID bound to the exact integrated development SHA.

- [ ] **Step 4: Settle the project transition with exact evidence**

Use `project.advance` execution settlement only after the authoritative project graph observes the integrated SHA and the evidence names that SHA.

- [ ] **Step 5: Bootstrap this release with the existing production primitive**

Use current live `production.promote({ repo })` to move production to the verified exact `dev` SHA. Let the existing serialized materialization path deploy and verify the immutable runtime.

- [ ] **Step 6: Prove the new operator live**

After the new runtime is deployed, invoke:

```json
{"repo":"laurajoyhutchins/overcenter"}
```

through `production.reconcile` and require a fresh verified no-op/converged result whose Git production SHA and immutable runtime SHA are identical.

- [ ] **Step 7: Record final evidence**

Record final `dev`, `main`, immutable Hatchable deployment/version, exact verification run, transition receipt, and the live `production.reconcile` result. Do not claim completion if any coordinate differs.