# Compact Execution State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Overcenter execution correctness depend only on fresh external authority plus `orchestration_runs`, `execution_state`, `operation_state`, and `proof_state`, never historical chronology.

**Architecture:** Add typed compact-state contracts and normalized Postgres state first. Dual-write from the current JavaScript runtime while legacy reads remain available, prove exact semantic equivalence, then cut recovery, authority, idempotency, continuation, and proof reads to compact state. TTL purge/archive behavior and destructive production deletion are deliberately deferred to the companion telemetry/archive plan.

**Tech Stack:** Node.js 22, TypeScript 5.9.2 strict mode, PostgreSQL, Node built-in test runner, generated `dist/lib` runtime artifacts, existing Hatchable exact-revision verification.

**Spec:** `docs/superpowers/specs/2026-09-01-compact-execution-state-and-telemetry-archive-design.md`

## Global Constraints

- GitHub remains authoritative for repository/project definitions and GitHub-owned state.
- Runtime validation remains authoritative for external JSON and durable rows.
- No correctness path may query telemetry or archive state.
- Every successful execution-subject acquisition increments `authority_epoch`.
- Every effecting operation authorized by a lease binds `subject_key`, `authority_epoch`, and `authority_revision` before provider mutation.
- `indeterminate` operations are never compacted or garbage-collected until externally resolved.
- Canonical operation idempotency identity is exactly `(command, idempotency_scope, idempotency_key)`; `idempotency_scope` is server-derived from semantic target/subject.
- Same canonical idempotency identity plus same `request_sha256` replays; the same identity plus a different hash fails closed before mutation.
- Proofs satisfy only their exact repository/revision predicate.
- Historical tables must be physically removable in an acceptance database without changing the next safe decision.
- Runtime-bearing TypeScript emits to `dist/lib`; tracked `lib/` copies are compatibility mirrors only where Hatchable still requires those paths.
- Use forward migrations only. The inspected branch has migrations through `052`; this plan reserves `053` through `056`.
- Do not purge production history in this plan.

---

### Task 1: Define compact semantic state contracts

**Files:**
- Create: `src/semantic/compact-execution-state.ts`
- Create: `type-tests/compact-execution-state.test.ts`
- Create: `scripts/verify-compact-execution-state-contracts.test.mjs`
- Modify: `tsconfig.semantic.runtime.json`
- Create generated compatibility mirror: `lib/compact-execution-state.js`
- Modify: `.github/workflows/semantic-kernel-types.yml`

**Interfaces:**
- Consumes: existing canonical JSON/hash helpers and semantic identities.
- Produces: `ExecutionState`, `ExecutionFence`, `OperationState`, `ProofState`, `assertTerminalOperationCompactable()`.

- [ ] **Step 1: Write the failing type test**

```ts
import type { ExecutionFence, OperationState } from '../src/semantic/compact-execution-state.js';

const fence: ExecutionFence = {
  subject_key: 'project:overcenter#transition:ship',
  authority_epoch: 3,
  authority_revision: 'a'.repeat(40),
};

const unresolved: OperationState = {
  operation_id: '00000000-0000-0000-0000-000000000002',
  command: 'github.apply_changeset',
  idempotency_scope: 'repository:laurajoyhutchins/overcenter',
  idempotency_key: 'idem-1',
  request_sha256: 'b'.repeat(64),
  state: 'indeterminate',
  subject_key: fence.subject_key,
  run_id: null,
  lease_epoch: 3,
  authority_revision: fence.authority_revision,
  may_have_mutated: true,
  effect_kind: 'github_commit',
  effect_ref: null,
  effect_sha256: null,
  result_sha256: null,
  recovery_payload: { repository: 'laurajoyhutchins/overcenter' },
  resolution: null,
  created_at: '2026-09-01T18:00:00.000Z',
  resolved_at: null,
};

void unresolved;
// @ts-expect-error epoch is an integer fence
const badFence: ExecutionFence = { ...fence, authority_epoch: '3' };
void badFence;
```

- [ ] **Step 2: Run the type check and verify failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
```

Expected: FAIL because `compact-execution-state.ts` does not exist.

- [ ] **Step 3: Implement the exact contracts**

```ts
export interface ExecutionFence {
  readonly subject_key: string;
  readonly authority_epoch: number;
  readonly authority_revision: string;
}

export type OperationLifecycleState =
  | 'prepared'
  | 'indeterminate'
  | 'succeeded'
  | 'no_effect'
  | 'rejected';

export function assertTerminalOperationCompactable(operation: OperationState): void {
  if (operation.state === 'prepared' || operation.state === 'indeterminate') {
    throw Object.assign(new Error('operation is not terminal'), { code:'OPERATION_NOT_COMPACTABLE' });
  }
  if (operation.state === 'succeeded' && operation.may_have_mutated && !operation.effect_ref) {
    throw Object.assign(new Error('successful mutation lacks a proven effect identity'), { code:'OPERATION_EFFECT_UNPROVEN' });
  }
}
```

Also implement `ExecutionState` with a maximum of two `recent_progress_sha256` values and `ProofState` with exact repository/revision coordinates. Runtime guards reject negative epochs/streaks/counts and active rows missing run/revision/expiry coordinates.

- [ ] **Step 4: Add runtime guard coverage**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTerminalOperationCompactable } from '../lib/compact-execution-state.js';

test('indeterminate operations cannot compact', () => {
  assert.throws(
    () => assertTerminalOperationCompactable({ state:'indeterminate', may_have_mutated:true, effect_ref:null }),
    error => error?.code === 'OPERATION_NOT_COMPACTABLE',
  );
});
```

- [ ] **Step 5: Materialize and verify the compatibility mirror**

```bash
rm -rf dist/lib
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/compact-execution-state.js lib/compact-execution-state.js
diff -u lib/compact-execution-state.js dist/lib/compact-execution-state.js
node --test scripts/verify-compact-execution-state-contracts.test.mjs
```

Add the same diff check to `.github/workflows/semantic-kernel-types.yml`.

- [ ] **Step 6: Commit**

```bash
git add src/semantic/compact-execution-state.ts type-tests/compact-execution-state.test.ts scripts/verify-compact-execution-state-contracts.test.mjs tsconfig.semantic.runtime.json lib/compact-execution-state.js .github/workflows/semantic-kernel-types.yml
git commit -m "feat: define compact execution state contracts"
```

---

### Task 2: Add compact-state schema

**Files:**
- Create: `migrations/053_execution_state.sql`
- Create: `migrations/054_operation_state.sql`
- Create: `migrations/055_proof_state.sql`
- Create: `migrations/056_orchestration_run_compaction.sql`
- Create: `scripts/verify-compact-state-migrations.test.mjs`

**Interfaces:**
- Consumes: Task 1 field names.
- Produces: normalized durable constraints used by every later store.

- [ ] **Step 1: Write failing migration-shape tests**

```js
const executionSql = await read('053_execution_state.sql');
assert.match(executionSql, /subject_key\s+TEXT\s+PRIMARY KEY/i);
assert.match(executionSql, /authority_epoch\s+BIGINT\s+NOT NULL/i);
const operationSql = await read('054_operation_state.sql');
assert.match(operationSql, /UNIQUE\s*\(command,\s*idempotency_scope,\s*idempotency_key\)/i);
assert.match(operationSql, /request_sha256\s+TEXT\s+NOT NULL/i);
```

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-compact-state-migrations.test.mjs
```

Expected: FAIL because the migrations are absent.

- [ ] **Step 3: Create `execution_state`**

```sql
CREATE TABLE execution_state (
  subject_key TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('project_transition','legacy_work')),
  project_ref TEXT,
  transition_id TEXT,
  authority_epoch BIGINT NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  lease_ref TEXT UNIQUE,
  run_id UUID REFERENCES orchestration_runs(run_id),
  authority_repository TEXT,
  authority_revision TEXT,
  graph_fingerprint TEXT,
  transition_revision_fingerprint TEXT,
  transition_dependency_fingerprint TEXT,
  expires_at TIMESTAMPTZ,
  hard_expires_at TIMESTAMPTZ,
  active_capability_material TEXT,
  checkpoint JSONB,
  checkpoint_sha256 TEXT,
  recent_progress_sha256 JSONB NOT NULL DEFAULT '[]'::jsonb,
  heartbeat_count INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_count >= 0),
  last_heartbeat_at TIMESTAMPTZ,
  continuation JSONB,
  continuation_sha256 TEXT,
  continuation_execution_fingerprint TEXT,
  no_progress_streak INTEGER NOT NULL DEFAULT 0 CHECK (no_progress_streak >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(recent_progress_sha256) = 'array'),
  CHECK (jsonb_array_length(recent_progress_sha256) <= 2)
);
```

Add a check requiring current run/repository/revision/expiry/hard-expiry whenever `lease_ref` is non-null.

- [ ] **Step 4: Create `operation_state` with the approved identity**

```sql
CREATE TABLE operation_state (
  operation_id UUID PRIMARY KEY,
  command TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','indeterminate','succeeded','no_effect','rejected')),
  subject_key TEXT REFERENCES execution_state(subject_key),
  run_id UUID REFERENCES orchestration_runs(run_id),
  lease_epoch BIGINT CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  authority_revision TEXT,
  may_have_mutated BOOLEAN NOT NULL,
  effect_kind TEXT,
  effect_ref TEXT,
  effect_sha256 TEXT,
  result_sha256 TEXT,
  recovery_payload JSONB,
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (command, idempotency_scope, idempotency_key),
  CHECK (state <> 'indeterminate' OR resolved_at IS NULL),
  CHECK (state IN ('prepared','indeterminate') OR recovery_payload IS NULL)
);
```

- [ ] **Step 5: Create `proof_state` and run pointers**

```sql
CREATE TABLE proof_state (
  proof_key TEXT PRIMARY KEY,
  subject_key TEXT REFERENCES execution_state(subject_key),
  predicate_kind TEXT NOT NULL,
  authority_repository TEXT NOT NULL,
  authority_revision TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  satisfied_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX proof_state_exact_authority_idx
  ON proof_state (predicate_kind, authority_repository, authority_revision);
```

`056_orchestration_run_compaction.sql` adds `active_subject_key`, `unresolved_operation_id`, `final_effect_refs`, and `final_evidence_sha256` to `orchestration_runs`.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/verify-compact-state-migrations.test.mjs
git add migrations/053_execution_state.sql migrations/054_operation_state.sql migrations/055_proof_state.sql migrations/056_orchestration_run_compaction.sql scripts/verify-compact-state-migrations.test.mjs
git commit -m "feat: add compact execution state schema"
```

---

### Task 3: Add the intent-oriented store port and Postgres adapter

**Files:**
- Create: `src/ports/compact-execution-state-store.ts`
- Create: `src/adapters/postgres/compact-execution-state-store.ts`
- Modify: `src/adapters/postgres/node-postgres-runtime.ts`
- Modify: `tsconfig.portable-runtime.json`
- Create: `type-tests/compact-execution-state-store.test.ts`
- Create: `scripts/compact-execution-state-postgres.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `CompactExecutionStateStore` and `createPostgresCompactExecutionStateStore(db)`.

- [ ] **Step 1: Write the failing consumer**

```ts
async function exercise(store: CompactExecutionStateStore) {
  const acquired = await store.acquireExecution({
    subject_key:'subject-1', subject_kind:'project_transition', lease_ref:'lease-1',
    run_id:'00000000-0000-0000-0000-000000000001',
    authority_repository:'laurajoyhutchins/overcenter', authority_revision:'a'.repeat(40),
    expires_at:'2026-09-01T18:30:00.000Z', hard_expires_at:'2026-09-01T18:45:00.000Z',
    active_capability_material:'capability',
  });
  return acquired.authority_epoch;
}
```

- [ ] **Step 2: Verify failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
```

- [ ] **Step 3: Define exact intent methods**

```ts
export interface CompactExecutionStateStore {
  getExecution(subjectKey: string): Promise<ExecutionState | null>;
  acquireExecution(input: AcquireExecutionInput): Promise<ExecutionState>;
  writeCheckpoint(input: WriteCheckpointInput): Promise<ExecutionState>;
  heartbeatExecution(input: HeartbeatExecutionInput): Promise<ExecutionState>;
  settleExecution(input: SettleExecutionInput): Promise<ExecutionState>;
  getOperation(command: string, scope: string, key: string): Promise<OperationState | null>;
  getOperationById(operationId: string): Promise<OperationState | null>;
  prepareOperation(input: PrepareOperationInput): Promise<OperationState>;
  markOperationIndeterminate(input: MarkOperationIndeterminateInput): Promise<OperationState>;
  resolveOperation(input: ResolveOperationInput): Promise<OperationState>;
  getProof(proofKey: string): Promise<ProofState | null>;
  putProof(input: PutProofInput): Promise<ProofState>;
  deleteProof(proofKey: string): Promise<void>;
  compactRun(input: CompactRunInput): Promise<void>;
}
```

- [ ] **Step 4: Write Postgres behavior tests first**

Assert first acquisition epoch `1`, reacquisition epoch `2`, stale settlement rejection, one current checkpoint, maximum two progress hashes, same identity/hash replay, different-hash conflict, and exact-key proof access.

- [ ] **Step 5: Implement transaction-safe behavior**

Lock the execution row `FOR UPDATE`; insert epoch `1` for a new subject and increment for existing subjects. Settlement updates only where `subject_key`, `lease_ref`, and `authority_epoch` all match. `prepareOperation` uses `ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING`, rereads, and compares `request_sha256`.

- [ ] **Step 6: Compile/run/commit**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/portable && npx --yes --package typescript@5.9.2 tsc -p tsconfig.portable-runtime.json
node --test scripts/compact-execution-state-postgres.test.mjs
git add src/ports/compact-execution-state-store.ts src/adapters/postgres/compact-execution-state-store.ts src/adapters/postgres/node-postgres-runtime.ts tsconfig.portable-runtime.json type-tests/compact-execution-state-store.test.ts scripts/compact-execution-state-postgres.test.mjs
git commit -m "feat: add compact state postgres store"
```

---

### Task 4: Dual-write transition authority and add epoch fencing

**Files:**
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `src/semantic/execution-authority-contracts.ts`
- Modify: `src/semantic/execution-authority-core.ts`
- Modify generated mirrors: `lib/execution-authority-contracts.js`, `lib/execution-authority-core.js`
- Modify: `lib/project-transition-leases.test.js`
- Modify: `scripts/verify-project-transition-leases.test.mjs`

**Interfaces:**
- Consumes: compact store semantics.
- Produces: project-transition execution authority carrying `authority_epoch`; temporary dual-write bridge into `execution_state`.

- [ ] **Step 1: Add the stale-process regression**

Acquire epoch 1, settle, reacquire epoch 2, then validate an effecting request bound to epoch 1. Expect `EXECUTION_AUTHORITY_STALE` and zero provider calls.

- [ ] **Step 2: Verify failure**

```bash
node --test lib/project-transition-leases.test.js scripts/verify-project-transition-leases.test.mjs
```

- [ ] **Step 3: Extend the semantic contract**

```ts
export interface ProjectTransitionExecutionAuthority {
  readonly subject:'project_transition';
  readonly lease_id:LeaseId;
  readonly lease_ref:LeaseId;
  readonly run_id:RunId;
  readonly authority_epoch:number;
  readonly repository:string;
  readonly project_ref:string;
  readonly transition_id:string;
  readonly authority:unknown | null;
  readonly graph_fingerprint:string | null;
  readonly transition_definition_fingerprint:string | null;
}
```

The current transition validator returns the epoch from compact state; `createExecutionAuthorityService().require()` rejects any inconsistency.

- [ ] **Step 4: Add the temporary JS dual-write bridge**

Add `getExecutionState`, `acquireExecutionState`, `writeExecutionCheckpoint`, `heartbeatExecutionState`, and `settleExecutionState` to `createProjectTransitionLeasePostgresStore`. Use the same SQL/fencing semantics as Task 3. Acquisition writes legacy lease/slot and compact state in one database transaction so split authority cannot commit.

- [ ] **Step 5: Generate, run, commit**

```bash
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/execution-authority-contracts.js lib/execution-authority-contracts.js
cp dist/lib/execution-authority-core.js lib/execution-authority-core.js
node --test lib/project-transition-leases.test.js scripts/verify-project-transition-leases.test.mjs
git add lib/project-transition-lease-store.js lib/project-transition-leases.js src/semantic/execution-authority-contracts.ts src/semantic/execution-authority-core.ts lib/execution-authority-contracts.js lib/execution-authority-core.js lib/project-transition-leases.test.js scripts/verify-project-transition-leases.test.mjs
git commit -m "feat: fence transition authority with compact epochs"
```

---

### Task 5: Replace historical checkpoint, heartbeat, and continuation reads

**Files:**
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `scripts/verify-project-transition-checkpoint-revision-evidence.test.mjs`
- Modify: `scripts/verify-project-transition-heartbeat-replay-evidence.test.mjs`
- Modify: `scripts/verify-project-transition-continuation-wiring.test.mjs`
- Modify: `scripts/verify-project-transition-revision-continuation.test.mjs`
- Modify: `scripts/verify-project-transition-settlement-atomicity.test.mjs`

**Interfaces:**
- Consumes: one current `execution_state` row.
- Produces: no project-transition correctness scan of checkpoint/heartbeat/settled-lease history.

- [ ] **Step 1: Make history deletion part of the tests**

After normal acquire/checkpoint/heartbeat setup, delete the corresponding legacy checkpoint/heartbeat rows before resume/heartbeat/settlement. The next decision must be unchanged.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-project-transition-checkpoint-revision-evidence.test.mjs scripts/verify-project-transition-heartbeat-replay-evidence.test.mjs scripts/verify-project-transition-continuation-wiring.test.mjs scripts/verify-project-transition-revision-continuation.test.mjs scripts/verify-project-transition-settlement-atomicity.test.mjs
```

- [ ] **Step 3: Cut reads to current state**

Checkpoint reads use `execution_state.checkpoint/checkpoint_sha256`. No-progress logic uses only `recent_progress_sha256` and `heartbeat_count`. Settlement writes `continuation`, digest, execution fingerprint, and `no_progress_streak`, then clears active lease fields atomically. Acquisition reads that continuation head directly.

- [ ] **Step 4: Run and commit**

Run the Step 2 command again. Expected: PASS even after legacy history deletion.

```bash
git add lib/project-transition-lease-store.js lib/project-transition-leases.js scripts/verify-project-transition-checkpoint-revision-evidence.test.mjs scripts/verify-project-transition-heartbeat-replay-evidence.test.mjs scripts/verify-project-transition-continuation-wiring.test.mjs scripts/verify-project-transition-revision-continuation.test.mjs scripts/verify-project-transition-settlement-atomicity.test.mjs
git commit -m "refactor: read transition progress from compact state"
```

---

### Task 6: Move mutation idempotency and certainty into `operation_state`

**Files:**
- Modify: `lib/github-apply-changeset.js`, `lib/github-apply-changeset.test.js`
- Modify: `lib/github-release.js`, `lib/github-release.test.js`
- Modify: `lib/github-production-promotion.js`, `lib/github-production-promotion.test.js`
- Modify: `lib/portfolio-reconcile-work-surface.js`, `lib/portfolio-reconcile-work-surface.test.js`
- Modify: `src/semantic/mutation-certainty.ts`
- Modify generated mirror: `lib/mutation-certainty.js`
- Modify: `scripts/verify-github-mutation-certainty.test.mjs`

**Interfaces:**
- Consumes: compact operation store and current execution fence.
- Produces: shared mutation certainty while command-specific receipts remain temporary dual-write comparison surfaces.

- [ ] **Step 1: Add replay/conflict/indeterminate tests for each family**

Use server-derived scopes:

```text
github.apply_changeset + repository:<repo>
github.release + repository:<repo>
github.production_promote + repository:<repo>
portfolio.reconcile + portfolio:<scope>
```

Assert same identity/same hash replays, same identity/different hash rejects before provider call, ambiguous provider outcome becomes `indeterminate`, and proven terminal effect becomes a compact tombstone.

- [ ] **Step 2: Verify focused failures**

```bash
node --test lib/github-apply-changeset.test.js lib/github-release.test.js lib/github-production-promotion.test.js lib/portfolio-reconcile-work-surface.test.js scripts/verify-github-mutation-certainty.test.mjs
```

- [ ] **Step 3: Prepare before provider mutation and preserve uncertainty**

Every effecting command calls `prepareOperation` before the provider. Bind `lease_epoch` and `authority_revision` where applicable. A conflict returns `may_have_mutated:false`. Ambiguous transport after possible mutation calls `markOperationIndeterminate`; no blind retry may overwrite it.

- [ ] **Step 4: Resolve only proven terminal outcomes**

`succeeded` requires an effect identity such as commit/tag/release/promotion coordinate. `no_effect/rejected` requires evidence that mutation did not occur. Terminal resolution clears `recovery_payload`.

- [ ] **Step 5: Keep dual-write equivalence and commit**

For this migration phase, continue old receipt writes and compare request hash, terminal certainty, and effect identity.

```bash
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/mutation-certainty.js lib/mutation-certainty.js
node --test lib/github-apply-changeset.test.js lib/github-release.test.js lib/github-production-promotion.test.js lib/portfolio-reconcile-work-surface.test.js scripts/verify-github-mutation-certainty.test.mjs
git add lib/github-apply-changeset.js lib/github-apply-changeset.test.js lib/github-release.js lib/github-release.test.js lib/github-production-promotion.js lib/github-production-promotion.test.js lib/portfolio-reconcile-work-surface.js lib/portfolio-reconcile-work-surface.test.js src/semantic/mutation-certainty.ts lib/mutation-certainty.js scripts/verify-github-mutation-certainty.test.mjs
git commit -m "refactor: unify mutation certainty in operation state"
```

---

### Task 7: Move exact-revision predicates into `proof_state`

**Files:**
- Modify: `lib/exact-revision-verification.js`
- Modify: `lib/github-required-check-observation.js`
- Modify: `lib/github-required-checks.js`, `lib/github-required-checks.test.js`
- Modify: `lib/github-production-promotion.js`
- Create: `scripts/verify-proof-state-exact-revision.test.mjs`

**Interfaces:**
- Consumes: exact repository/revision coordinates.
- Produces: proofs that cannot authorize a newer head by accident.

- [ ] **Step 1: Write the superseded-proof regression**

```js
const proof = await putProof({
  proof_key:`exact_revision_verified:${repo}:${SHA_A}`,
  predicate_kind:'exact_revision_verified',
  authority_repository:repo,
  authority_revision:SHA_A,
  evidence_sha256:evidenceSha,
  evidence_refs:['verification:1'],
  satisfied_at:now,
});
assert.equal(canPromote({ candidate_sha:SHA_A, proof }), true);
assert.equal(canPromote({ candidate_sha:SHA_B, proof }), false);
```

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-proof-state-exact-revision.test.mjs lib/github-required-checks.test.js
```

- [ ] **Step 3: Dual-write proofs and cut promotion reads**

On exact-revision verification success, write a deterministic proof key including predicate kind, repository, and SHA. Promotion requires matching repository and `authority_revision === candidate_sha`; never query the latest proof without an exact SHA. Required-check chronology remains diagnostic.

- [ ] **Step 4: Run and commit**

```bash
node --test scripts/verify-proof-state-exact-revision.test.mjs lib/github-required-checks.test.js lib/github-production-promotion.test.js
git add lib/exact-revision-verification.js lib/github-required-check-observation.js lib/github-required-checks.js lib/github-required-checks.test.js lib/github-production-promotion.js scripts/verify-proof-state-exact-revision.test.mjs
git commit -m "feat: store exact revision predicates as proofs"
```

---

### Task 8: Rewrite recovery, status, and evidence around current facts

**Files:**
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-status.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/execution-evidence-store.js`
- Create: `src/semantic/execution-evidence-v2-contracts.ts`
- Create: `src/semantic/execution-evidence-v2.ts`
- Create generated mirrors: `lib/execution-evidence-v2-contracts.js`, `lib/execution-evidence-v2.js`
- Create: `scripts/verify-compact-recovery-no-history.test.mjs`
- Create: `scripts/verify-execution-evidence-v2.test.mjs`
- Modify: `tsconfig.semantic.runtime.json`

**Interfaces:**
- Consumes: fresh authority + compact run/execution/unresolved-operation/proof state.
- Produces: deterministic recovery and `execution-evidence-v2` without transcript reconstruction.

- [ ] **Step 1: Write no-history recovery and v2 shape tests**

```js
const forbidden = async () => { throw new Error('historical correctness read attempted'); };
const store = { getRun, getExecution, getOperationById, getProof,
  lastSuccessfulInvocation:forbidden, recentFailures:forbidden, latestCheckpoint:forbidden };
```

Evidence v2 must expose `run`, `execution`, compact `operations`, `proofs`, and `integrity`; it must not expose `commands` or `checkpoints` chronology.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-compact-recovery-no-history.test.mjs scripts/verify-execution-evidence-v2.test.mjs
```

- [ ] **Step 3: Replace recovery inputs**

```js
const run = await state.getRun(runId);
const execution = run?.active_subject_key ? await state.getExecution(run.active_subject_key) : null;
const operation = run?.unresolved_operation_id ? await state.getOperationById(run.unresolved_operation_id) : null;
const authority = await readFreshAuthority(run);
return diagnose({ run, execution, operation, authority });
```

No historical fallback is permitted.

- [ ] **Step 4: Implement evidence v2 and generate mirrors**

V2 uses only compact state plus explicit bounded fresh authority observations. V1 remains a compatibility historical projection during rollout.

- [ ] **Step 5: Run and commit**

```bash
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/execution-evidence-v2-contracts.js lib/execution-evidence-v2-contracts.js
cp dist/lib/execution-evidence-v2.js lib/execution-evidence-v2.js
node --test scripts/verify-compact-recovery-no-history.test.mjs scripts/verify-execution-evidence-v2.test.mjs
git add lib/orchestration-recovery.js lib/orchestration-status.js lib/orchestration-runs.js lib/execution-evidence-store.js src/semantic/execution-evidence-v2-contracts.ts src/semantic/execution-evidence-v2.ts lib/execution-evidence-v2-contracts.js lib/execution-evidence-v2.js scripts/verify-compact-recovery-no-history.test.mjs scripts/verify-execution-evidence-v2.test.mjs tsconfig.semantic.runtime.json
git commit -m "refactor: recover and prove from compact state"
```

---

### Task 9: Make settlement and terminal run compaction atomic

**Files:**
- Modify: `lib/orchestration-finish-runtime.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `scripts/verify-project-transition-settlement-atomicity.test.mjs`
- Create: `scripts/verify-terminal-run-compaction.test.mjs`

**Interfaces:**
- Consumes: current compact execution/operation/run rows.
- Produces: one atomic terminal transition.

- [ ] **Step 1: Add rollback and terminal-summary tests**

Inject a failure after continuation update but before run finalization and prove both roll back. On success, preserve IDs, target/scope hashes, disposition, `final_effect_refs`, and `final_evidence_sha256` while clearing active recovery detail.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-project-transition-settlement-atomicity.test.mjs scripts/verify-terminal-run-compaction.test.mjs
```

- [ ] **Step 3: Use one transaction in this order**

```text
lock execution_state + orchestration_runs
validate lease_ref + authority_epoch + fresh authority preconditions
resolve terminal operation only when effect/no-effect is proven
write continuation head
clear active execution fields
compact/finalize orchestration_runs
commit
```

- [ ] **Step 4: Run and commit**

```bash
node --test scripts/verify-project-transition-settlement-atomicity.test.mjs scripts/verify-terminal-run-compaction.test.mjs
git add lib/orchestration-finish-runtime.js lib/orchestration-runs.js lib/project-transition-leases.js scripts/verify-project-transition-settlement-atomicity.test.mjs scripts/verify-terminal-run-compaction.test.mjs
git commit -m "refactor: atomically settle compact execution state"
```

---

### Task 10: Add the physical history-independence gate

**Files:**
- Create: `scripts/verify-compact-state-history-independence.test.mjs`
- Create: `scripts/verify-correctness-does-not-query-history.test.mjs`
- Modify: `lib/regression-suite-registry.js`
- Modify: `scripts/verify-regression-suite-registry.mjs`
- Modify: `.github/workflows/regression-suite-registry.yml`

**Interfaces:**
- Consumes: Tasks 4-9.
- Produces: CI proof that old chronology is not a correctness substrate.

- [ ] **Step 1: Write destructive acceptance setup**

In an isolated test schema, seed compact state and physically drop:

```sql
DROP TABLE work_lease_heartbeats;
DROP TABLE work_lease_checkpoints;
DROP TABLE orchestration_horizons;
DROP TABLE orchestration_invocation_resolutions;
DROP TABLE orchestration_command_invocations;
```

Delete historical project-transition lease rows after preserving the current subject in `execution_state`. Invoke authority validation, recovery, resume/settlement, status, and evidence v2.

- [ ] **Step 2: Add a static forbidden-query test**

Scan correctness modules and fail on SQL references to old chronology tables. Only migration/backfill code and the companion telemetry/archive modules may be allowlisted.

- [ ] **Step 3: Run, remove fallbacks, register the gate**

```bash
node --test scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs
node scripts/verify-regression-suite-registry.mjs
```

If a current fact is missing, add it to compact state rather than weakening the test.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs lib/regression-suite-registry.js scripts/verify-regression-suite-registry.mjs .github/workflows/regression-suite-registry.yml
git commit -m "test: prove compact state is history independent"
```

---

### Task 11: Backfill compact state, prove equivalence, and cut over

**Files:**
- Create: `src/runtime/compact-state-maintenance.ts`
- Create: `scripts/backfill-compact-execution-state.mjs`
- Create: `scripts/verify-compact-state-equivalence.test.mjs`
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-semantic-journal-resolution.js`

**Interfaces:**
- Consumes: legacy rows once, strictly as migration input.
- Produces: deterministic compact backfill and a cutover where history is telemetry only.

- [ ] **Step 1: Write equivalence fixtures**

Cover active lease, recoverable expiry, terminal success, proven no-effect, and unresolved indeterminate mutation. Compare the legacy next-safe-action with the action from freshly backfilled compact state.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-compact-state-equivalence.test.mjs
```

- [ ] **Step 3: Implement deterministic backfill**

Create one current execution row per subject; run the old continuation algorithm exactly once to establish the current continuation head; create unresolved operation rows for ambiguous effects; compact proven terminal receipt facts; materialize exact-revision proofs; populate active run pointers. Ambiguous source state stops that subject with a machine-readable failure and leaves source rows untouched.

- [ ] **Step 4: Make the CLI dry-run by default**

`scripts/backfill-compact-execution-state.mjs` prints counts and canonical state hashes. Only `--apply` writes.

- [ ] **Step 5: Cut correctness reads/writes and remove temporary bridge code**

After equivalence passes, remove history reads from authority/recovery/continuation/mutation retry/proof paths. Legacy journals/resolution/specialized receipts may still be written as telemetry for the companion plan, but cannot affect correctness. Replace the temporary JS compact-store bridge with the typed adapter where the host composition is now available.

- [ ] **Step 6: Run both safety gates and commit**

```bash
node --test scripts/verify-compact-state-equivalence.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs
git add src/runtime/compact-state-maintenance.ts scripts/backfill-compact-execution-state.mjs scripts/verify-compact-state-equivalence.test.mjs lib/project-transition-lease-store.js lib/orchestration-journal.js lib/orchestration-semantic-journal-resolution.js
git commit -m "refactor: cut execution correctness to compact state"
```

---

### Task 12: Update docs and run exact-head verification

**Files:**
- Create: `docs/execution-evidence-v2-design.md`
- Modify: `docs/execution-evidence-v1-design.md`
- Modify: `docs/architecture/recovery-kernel-and-self-healing.md`
- Modify: `docs/architecture/ontology-and-authority.md`
- Modify: `docs/operator-recovery.md`
- Modify: `docs/implementation/recovery-kernel-plan.md`
- Modify: `public/docs/orchestration-recovery.md`
- Modify: `public/docs/work-continuation-v1.md`
- Modify: `public/docs/control-plane-surface-inventory.md`
- Modify: `public/docs/architecture/terminology.md`
- Modify: `public/docs/command-response-v1.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: implemented compact behavior.
- Produces: operator/public model centered on present-tense execution truth plus exact-head verification evidence.

- [ ] **Step 1: Correct architecture language**

Canonical recovery inputs must be stated exactly as:

```text
fresh authoritative observations
+ orchestration_runs
+ execution_state
+ unresolved operation_state
+ exact-revision proof_state
```

Mark evidence v1 as compatibility history, not recovery authority. Document epoch fencing and the explicit continuation head.

- [ ] **Step 2: Run strict TS/runtime artifact verification**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/lib
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
```

Run every `lib`/`dist/lib` diff in `.github/workflows/semantic-kernel-types.yml`.

- [ ] **Step 3: Run compact targeted gates**

```bash
node --test scripts/verify-compact-execution-state-contracts.test.mjs scripts/verify-compact-state-migrations.test.mjs scripts/compact-execution-state-postgres.test.mjs scripts/verify-compact-recovery-no-history.test.mjs scripts/verify-proof-state-exact-revision.test.mjs scripts/verify-execution-evidence-v2.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs scripts/verify-compact-state-equivalence.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run canonical regression/public-release verification**

```bash
node scripts/verify-regression-suite-registry.mjs
```

Execute every required command registered by the canonical regression suite. Expected: PASS.

- [ ] **Step 5: Run exact-revision Hatchable V8 verification on the same SHA**

Use the existing dist-aware exact-revision verifier. Record the candidate GitHub SHA and prove the materialized runtime source SHA is identical.

- [ ] **Step 6: Commit docs and record the cutover evidence**

```bash
git add README.md docs public/docs
git commit -m "docs: document compact execution correctness"
```

Record candidate SHA, strict TypeScript result, runtime mirror result, compact/legacy equivalence result, physical-history-independence result, regression/public-release result, and exact-revision Hatchable result. State explicitly that production history is not purge-eligible until the companion telemetry/archive plan is complete.
