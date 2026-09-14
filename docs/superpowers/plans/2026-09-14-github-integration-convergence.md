# GitHub Integration Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an accepted exact-head GitHub PR integration intent converge durably without an agent carrying refreshed heads, CI waiting state, merge request UUIDs, or retry bookkeeping.

**Architecture:** Keep `reconcileGithubIntegration` as the deterministic one-pass GitHub decision engine. Wrap it in a compact durable recovery operation stored in existing `operation_state`, register that recovery with `orchestration.maintain`, and expose only the initial intent through the existing GCP worker-command path.

**Tech Stack:** Node.js 22 ESM, PostgreSQL/Cloud SQL, GitHub App API transport, GitHub Actions GCP OIDC bridge, existing `operation_state` compact transaction machinery.

**Spec:** `docs/superpowers/specs/2026-09-14-github-integration-convergence-design.md`

## Global Constraints

- No new scheduler, persistence table, webhook dependency, or caller-managed continuation protocol.
- Preserve exact-head fencing and fail closed on unexpected head movement or uncertain mutation outcome.
- Only a head produced by Overcenter's own exact-head branch refresh may replace the accepted head automatically.
- `orchestration.maintain` may advance only already-authorized integration intents; it must not select semantic work.
- Existing direct `api/github-integration-reconcile.js` remains a compatibility surface.

---

### Task 1: Durable integration convergence operation

**Files:**
- Create: `lib/github-integration-convergence.js`
- Modify: `lib/compact-provider-operation-store.js`
- Create: `scripts/verify-github-integration-convergence.test.mjs`
- Modify: `scripts/test.mjs`

**Interfaces:**
- Consumes: `createCompactProviderOperationPostgresStore(db)`, `reconcileGithubIntegrationRoleAware(input, options)`.
- Produces: `createGithubIntegrationConvergenceService(options)` with `converge(input)` and `reconcilePending({limit})`; `createGithubIntegrationConvergenceForRuntime(runtime)`; generic compact-store `reject(input)`.

- [ ] **Step 1: Write failing tests for convergence**

Create a node:test suite that supplies a fake compact operation store and a scripted `reconcileIntegration` function. Prove:

```js
const service = createGithubIntegrationConvergenceService({ operations, reconcileIntegration });
const first = await service.converge({ repo:'owner/repo', pull_request:7, expected_head:HEAD });
assert.equal(first.outcome, 'waiting');
assert.equal(first.accepted_head, UPDATED_HEAD);

const second = await service.reconcilePending({ limit:20 });
assert.equal(second[0].outcome, 'waiting');

const third = await service.reconcilePending({ limit:20 });
assert.equal(third[0].outcome, 'merge_pending');
assert.equal(third[0].merge_request_uuid, 'merge-uuid');

const fourth = await service.reconcilePending({ limit:20 });
assert.equal(fourth[0].outcome, 'merged');
assert.equal(fourth[0].state, 'succeeded');
```

Also prove failed required checks, `changes_requested`, `GITHUB_INTEGRATION_CONFLICT`, `stack_rebase_required`, policy ambiguity, and unexpected head movement call the terminal rejection path with `outcome:'requires_judgment'`; uncertain mutation calls `markIndeterminate` rather than retrying.

- [ ] **Step 2: Register the test in `scripts/test.mjs` and run CI to verify RED**

Expected failure: missing `lib/github-integration-convergence.js` or missing `reject` support.

- [ ] **Step 3: Add token-fenced compact operation rejection**

Add `reject(input)` to `createCompactProviderOperationPostgresStore` using:

```sql
UPDATE operation_state
   SET state='rejected', may_have_mutated=$5,
       recovery_payload=NULL, resolution=$6::jsonb,
       resolved_at=$7, updated_at=$7
 WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
   AND state IN ('prepared','indeterminate')
   AND recovery_payload->>'attempt_token'=$4
RETURNING *
```

Return `reject` from the store object.

- [ ] **Step 4: Implement `github-integration-convergence.js`**

Use internal command `github.integration.convergence` and pending phase `PENDING_CONVERGENCE`. Normalize only `repo`, positive integer `pull_request`, exact 40-character `expected_head`, and optional bounded `run_id`. Derive scope and idempotency identity internally.

Each pass calls the existing role-aware integration engine with `apply:true`, current `accepted_head`, and internal `merge_request_uuid` when present. Map outcomes exactly:

```text
updated_for_recheck -> persist returned head.sha as accepted_head, pending
waiting/mergeability -> pending
merge_submitted/merge_pending -> persist merge_request_uuid, pending
merged/already_merged -> succeed
failed checks / changes requested / conversation resolution / conflict /
stack_rebase_required / policy ambiguity / unexpected head -> reject requires_judgment
may_have_mutated / indeterminate -> markIndeterminate
```

Do not accept caller-supplied refreshed heads or merge UUIDs.

- [ ] **Step 5: Run the focused test and full repository verification**

Run `node --test scripts/verify-github-integration-convergence.test.mjs`, then `npm test` through CI. Expected: PASS.

---

### Task 2: Maintenance-owned wake-up

**Files:**
- Modify: `lib/orchestration-maintenance-subjects.js`
- Modify: `scripts/verify-github-integration-convergence.test.mjs`

**Interfaces:**
- Consumes: `createGithubIntegrationConvergenceForRuntime({db, withGitHubAppApiClient})`.
- Produces: compact recovery registration `{ kind:'github_integration', reconcilePending }` alongside existing project-authoring recovery.

- [ ] **Step 1: Add a failing source/behavior assertion**

Assert maintenance composition registers both recovery kinds when GitHub auth exists and that the integration recovery delegates to `reconcilePending({limit})`.

- [ ] **Step 2: Run focused test to verify RED**

Expected failure: `github_integration` recovery is absent.

- [ ] **Step 3: Register convergence in `compactRecoveries`**

Add the integration recovery next to project authoring. Keep the existing maintenance limit and action accounting unchanged so integration reconciliation consumes the same bounded maintenance budget.

- [ ] **Step 4: Run focused and full tests**

Expected: maintenance remains `semantic_work_mutations:0` and no semantic work selection is introduced.

---

### Task 3: Authoritative worker and GCP ingress

**Files:**
- Modify: `lib/semantic-command-descriptors.js`
- Modify: `lib/worker-transport.js`
- Modify: `api/gcp-semantic-command-dispatch.js`
- Modify: `.github/workflows/gcp-semantic-command.yml`
- Create: `scripts/gcp-semantic-github-integration-convergence-bridge.test.mjs`
- Modify: `scripts/test.mjs`

**Interfaces:**
- Consumes: `createGithubIntegrationConvergenceForRuntime(runtime).converge(request)`.
- Produces: internal worker command `github.integration.reconcile` with caller schema `{repo,pull_request,expected_head,run_id?}` and no MCP exposure.

- [ ] **Step 1: Write failing bridge and descriptor tests**

Assert the descriptor has exactly these semantic fields and is `{worker:true,mcp:false}`. Assert worker transport delegates to convergence service. Assert broker/workflow allowlist and JSON validation admit exactly repo, PR, expected head, optional run id and reject continuation fields.

- [ ] **Step 2: Run focused bridge test to verify RED**

Expected failure: descriptor and GCP allowlist do not contain `github.integration.reconcile`.

- [ ] **Step 3: Add semantic descriptor and worker binding**

Add a dedicated schema and worker spec. Runtime composition derives DB, GitHub auth, operation-state store, and recovery state; caller cannot provide `apply`, `merge_request_uuid`, accepted head, base SHA, checks, or retry state.

- [ ] **Step 4: Extend bounded GCP broker and workflow**

Add `github.integration.reconcile` to the bounded GitHub integration command set, validate its exact JSON shape, include it in workflow choice/case dispatch, and continue posting only to authoritative `/api/worker-command` with exact Overcenter `dev` revision fencing.

- [ ] **Step 5: Run focused tests, `npm test`, semantic type verification, contract evidence verification, and exact-revision V8 verification**

Expected: all green on one exact PR head. Contract evidence is derived automatically; no generated evidence files are committed.

- [ ] **Step 6: Open PR, review exact diff, and merge with head-SHA fence**

Before merge, confirm current `dev`, PR base/head, mergeability, required `repository-static` and `verify` contexts, and the automatic contract-evidence attestation. If `dev` moves, refresh deterministically and rerun gates rather than bypassing strict branch policy.
