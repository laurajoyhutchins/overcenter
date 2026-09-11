# Unified Execution Correctness Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Overcenter's duplicated lease, effect, evidence, mutation-certainty, settlement, recovery, and provider ceremony with one TypeScript-authored execution transaction kernel backed by the existing compact PostgreSQL substrate, then delete the superseded paths.

**Architecture:** The kernel is ordinary TypeScript functions and typed values, compiled into the runtime JavaScript consumed by Cloud Run. execution_state owns one lifecycle and one fenced lease; operation_state records one idempotent external-effect ledger; proof_state records exact immutable proof; orchestration_runs remains correlation-only. GitHub, GCP, and other providers expose preflight/invoke/readback capabilities and do not implement generic transaction semantics.

**Tech Stack:** TypeScript 5.9.2, Node 22, npm 10.9.2, PostgreSQL via pg 8.13.1, existing scripts/build.mjs runtime mirror generation, Node test runner, GitHub Actions/GCP verification.

**Spec:** docs/superpowers/specs/2026-09-11-unified-execution-correctness-kernel-design.md

## Global Constraints

- Semantic correctness code is authored in src/semantic and compiled into lib; hand-maintained JS/TS semantic duplicates are not allowed.
- Use execution_state, operation_state, and proof_state as the migration substrate; do not create a parallel v2 authority.
- GitHub remains repository/source authority; Overcenter on GCP and Cloud SQL remain run, lease, claim, settlement, receipt, recovery, and orchestration authority.
- Hatchable remains transport/hosting only and must not write or interpret Overcenter semantic state.
- Every external effect is fenced by exact repository revision, authority epoch, lease epoch, execution identity, and idempotency identity.
- may_have_mutated never grants blind retry permission.
- Stale workers must fail through compare-and-set and must not mutate or settle newer executions.
- Provider-specific SHA, conditional-write, permission, and readback safety remains in provider capabilities.
- No compatibility facade, parallel v2 API, or framework-shaped KernelInterface/Adapter/Manager is introduced.
- Historical migration files may remain as immutable schema history, but live correctness code must stop reading or writing superseded tables.
- Local full-checkout execution may be unavailable; use the repository's scratch TypeScript harness when necessary and rely on GitHub Actions for the complete suite after each pushed checkpoint.

---

## File map

The implementation uses these canonical files after migration:

| File | Responsibility |
|---|---|
| src/semantic/execution-transaction.ts | Execution identity, lifecycle facts, certainty lattice, provider capability types, pure transition/recovery rules |
| src/semantic/execution-transaction-runtime.ts | Prepare, claim, fence, invoke, confirm, proof, and settle protocol |
| src/ports/execution-transaction-store.ts | One typed persistence port for the kernel |
| src/adapters/postgres/execution-transaction-store.ts | One PostgreSQL adapter implementing the port with transactions and compare-and-set |
| migrations/060_execution_transaction_identity.sql | Minimal identity, lifecycle, attempt, certainty, proof, and constraint migration |
| scripts/measure-execution-correctness.mjs | Before/after measurement of production execution-correctness machinery |
| scripts/execution-transaction-kernel.test.mjs | In-memory conformance tests for the kernel invariants |
| scripts/execution-transaction-postgres.test.mjs | PostgreSQL adapter and constraint tests |
| scripts/verify-unified-execution-boundary.test.mjs | Source/import audit proving generic protocol is not duplicated in providers or orchestration |
| lib/execution-transaction.js and lib/execution-transaction-runtime.js | Generated runtime mirrors only |
| docs/architecture/recovery-kernel-and-self-healing.md | Updated authority/recovery documentation after deletion |
| docs/command-reference.md | Updated semantic/advanced command boundary after callers migrate |

The existing compact TypeScript port and adapter are moved into these canonical files rather than wrapped. The old files are removed when all imports have moved.

---

### Task 1: Establish the baseline and characterization guard

**Files:**
- Create: scripts/measure-execution-correctness.mjs
- Create: scripts/execution-correctness-baseline.test.mjs
- Modify: scripts/test.mjs
- Modify: scripts/verify-regression-suite-registry.mjs if the registry requires the new maintained test
- Test: scripts/execution-correctness-baseline.test.mjs

**Interfaces:**
- Produces a JSON measurement object with source revision, production line/byte counts, test line/byte counts, implementation counts, lifecycle enum counts, and live-table references.
- Produces characterization assertions for the existing compact store's idempotency, exact revision fence, stale lease rejection, proof binding, and uncertain-operation non-compaction. Later tasks must preserve these assertions while replacing their implementation.

- [ ] **Step 1: Write the failing measurement test**

Create a test that imports the measurement function and asserts that its result has every required numeric field.

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureExecutionCorrectness } from './measure-execution-correctness.mjs';

test('measurement reports every execution-correctness dimension', async () => {
  const result = await measureExecutionCorrectness({ root: new URL('../', import.meta.url) });
  for (const field of [
    'production_lines',
    'production_bytes',
    'test_lines',
    'test_bytes',
    'lease_implementations',
    'recovery_implementations',
    'settlement_implementations',
    'mutation_certainty_implementations',
    'provider_generic_protocol_implementations',
    'compatibility_modules',
    'lifecycle_models',
  ]) {
    assert.equal(typeof result[field], 'number', field);
  }
});
~~~

Run: node --test scripts/execution-correctness-baseline.test.mjs

Expected: FAIL because the measurement module does not exist.

- [ ] **Step 2: Implement the measurement function**

Walk only tracked production files under src, lib, api, and scripts, excluding dist, node_modules, historical migrations, and the measurement test itself. Classify files using explicit path/name sets copied from the inventory in the design spec. Count line endings and UTF-8 bytes. Count lifecycle models by extracting enum/state literals from the named state modules, not by counting arbitrary occurrences of the word state.

Expose:

~~~js
export async function measureExecutionCorrectness({ root, sourceRevision = null } = {}) {
  return {
    source_revision: sourceRevision,
    production_lines: 0,
    production_bytes: 0,
    test_lines: 0,
    test_bytes: 0,
    lease_implementations: 0,
    recovery_implementations: 0,
    settlement_implementations: 0,
    mutation_certainty_implementations: 0,
    provider_generic_protocol_implementations: 0,
    compatibility_modules: 0,
    lifecycle_models: 0,
    active_correctness_tables: [],
  };
}
~~~

The returned zero values are only the initialized shape; the implementation must replace them with computed values before the test is run.

- [ ] **Step 3: Add compact characterization assertions**

Use the existing compact store test helpers and add assertions that:

~~~js
assert.equal(await store.resumeIndeterminate(operationId), null);
assert.equal(await store.compactRun(runId), false);
assert.equal(await store.settleExecution(staleFence), null);
assert.equal(await store.getProof(mismatchedRevisionProof), null);
~~~

Keep the assertions against current public store behavior at this stage. Do not change production behavior in this task.

- [ ] **Step 4: Run the baseline checks**

Run:

~~~bash
node --test scripts/execution-correctness-baseline.test.mjs
node scripts/measure-execution-correctness.mjs --json
npm run typecheck
~~~

Expected: the new test passes, the command prints all dimensions, and the existing TypeScript build remains clean.

- [ ] **Step 5: Commit the baseline guard**

~~~bash
git add scripts/measure-execution-correctness.mjs scripts/execution-correctness-baseline.test.mjs scripts/test.mjs scripts/verify-regression-suite-registry.mjs
git commit -m "test: record execution correctness baseline"
~~~

---

### Task 2: Define the TypeScript kernel facts and pure transitions

**Files:**
- Create: src/semantic/execution-transaction.ts
- Create: type-tests/execution-transaction.types.ts
- Create: scripts/execution-transaction-kernel.test.mjs
- Modify: tsconfig.semantic.runtime.json
- Modify: scripts/build.mjs
- Test: scripts/execution-transaction-kernel.test.mjs
- Test: type-tests/execution-transaction.types.ts

**Interfaces:**
- Consumes: canonical JSON/hash utilities and existing project authority/revision values.
- JsonValue and JsonObject are imported from src/semantic/project-graph-types.ts; no second JSON model is introduced.
- ProviderPreflight is defined beside ProviderEffect as:

~~~ts
export interface ProviderPreflight {
  provider: string;
  observed_revision: string;
  provider_identity: JsonObject;
}
~~~


- Produces the following exact types and functions for Tasks 3 through 8:

~~~ts
export type ExecutionLifecycle =
  | 'prepared'
  | 'executing'
  | 'effect_uncertain'
  | 'effect_confirmed'
  | 'effect_absent'
  | 'settled'
  | 'rejected'
  | 'escalated';

export type MutationCertainty =
  | 'definitely_not_mutated'
  | 'may_have_mutated'
  | 'confirmed_mutated';

export interface ExecutionAuthority {
  project_ref: string;
  repository: string;
  revision: string;
  epoch: number;
  graph_fingerprint: string;
  transition_fingerprint: string;
}

export interface ExecutionIntent<TPayload = JsonValue> {
  project_ref: string;
  subject_key: string;
  authority: ExecutionAuthority;
  operation: {
    kind: string;
    idempotency_scope: string;
    idempotency_key: string;
    payload: TPayload;
  };
}

export interface ExecutionIdentity {
  execution_id: string;
  operation_id: string;
  project_ref: string;
  subject_key: string;
  run_id: string;
  lease_ref: string;
  lease_epoch: number;
  authority_epoch: number;
  authority_repository: string;
  authority_revision: string;
  graph_fingerprint: string;
  transition_fingerprint: string;
  idempotency_scope: string;
  idempotency_key: string;
  intent_sha256: string;
}

export interface ExecutionSnapshot {
  identity: ExecutionIdentity;
  lifecycle: ExecutionLifecycle;
  attempt_epoch: number;
  mutation_certainty: MutationCertainty;
  effect_ref: string | null;
  proof_ids: readonly string[];
  settled: boolean;
}

export interface ProviderInvocationFacts {
  transport: 'rejected' | 'accepted' | 'unknown';
  committed: boolean | null;
  effect_ref: string | null;
  response_sha256: string | null;
  evidence: JsonObject | null;
}

export interface ProviderConfirmationFacts {
  status: 'confirmed' | 'absent' | 'unknown';
  effect_ref: string | null;
  predicate: string;
  evidence: JsonObject;
}

export interface SettlementReceipt {
  schema: 'settlement-receipt-v1';
  execution_id: string;
  operation_id: string;
  authority_revision: string;
  authority_epoch: number;
  lifecycle: 'settled';
  disposition: 'completed' | 'no_effect' | 'rejected' | 'escalated';
  effect_ref: string | null;
  evidence_sha256: string;
}

export type RecoveryDecision =
  | 'retry_before_effect'
  | 'confirm_only'
  | 'settle_confirmed'
  | 'settle_no_effect'
  | 'escalate';

export function canTransition(
  from: ExecutionLifecycle,
  to: ExecutionLifecycle,
): boolean;

export function mutationCertaintyFromFacts(
  facts: ProviderInvocationFacts | ProviderConfirmationFacts,
): MutationCertainty;

export function classifyRecovery(snapshot: ExecutionSnapshot): RecoveryDecision;
~~~

- [ ] **Step 1: Write failing transition and certainty tests**

Add tests for legal/illegal transitions, monotonic certainty, and recovery decisions.

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  classifyRecovery,
  mutationCertaintyFromFacts,
} from '../lib/execution-transaction.js';

test('uncertain effects permit confirmation but not blind retry', () => {
  assert.equal(canTransition('executing', 'effect_uncertain'), true);
  assert.equal(canTransition('effect_uncertain', 'effect_confirmed'), true);
  assert.equal(classifyRecovery({
    identity: {},
    lifecycle: 'effect_uncertain',
    attempt_epoch: 1,
    mutation_certainty: 'may_have_mutated',
    effect_ref: null,
    proof_ids: [],
    settled: false,
  }), 'confirm_only');
});

test('certainty cannot regress', () => {
  assert.equal(mutationCertaintyFromFacts({
    status: 'unknown',
    effect_ref: null,
    predicate: 'exact-effect',
    evidence: {},
  }), 'may_have_mutated');
  assert.equal(canTransition('effect_confirmed', 'effect_absent'), false);
});
~~~

Run: npm run build:runtime && node --test scripts/execution-transaction-kernel.test.mjs

Expected: FAIL because the new semantic module does not exist.

- [ ] **Step 2: Implement the pure value and transition layer**

Implement the types, exhaustive lifecycle transition table, certainty ordering, and recovery classifier. The classifier must return confirm_only for may_have_mutated and must not infer retry permission from a provider success-shaped object without exact confirmation facts.

Reject malformed revisions, negative epochs, empty identities, and unknown lifecycle values with typed errors. Keep all functions deterministic and side-effect free.

- [ ] **Step 3: Add TypeScript compile assertions**

In type-tests/execution-transaction.types.ts, assert that a provider payload cannot supply lease_ref, lease_epoch, authority_epoch, or settlement fields. Assert that SettlementReceipt requires execution_id, operation_id, authority_revision, authority_epoch, effect_ref, and evidence_sha256.

Run: npm run typecheck

Expected: PASS with strict, exactOptionalPropertyTypes, and noUncheckedIndexedAccess enabled.

- [ ] **Step 4: Add the runtime mirror**

Add execution-transaction.js to the mirror list in scripts/build.mjs and add src/semantic/execution-transaction.ts to tsconfig.semantic.runtime.json. Generate lib/execution-transaction.js with the build; do not hand-author it.

Run:

~~~bash
npm run build:runtime
node --test scripts/execution-transaction-kernel.test.mjs
~~~

Expected: PASS and no generated semantic runtime drift.

- [ ] **Step 5: Commit the pure kernel facts**

~~~bash
git add src/semantic/execution-transaction.ts type-tests/execution-transaction.types.ts scripts/execution-transaction-kernel.test.mjs tsconfig.semantic.runtime.json scripts/build.mjs lib/execution-transaction.js
git commit -m "feat: define execution transaction kernel facts"
~~~

---

### Task 3: Replace the compact store port with one transaction store

**Files:**
- Create: src/ports/execution-transaction-store.ts
- Create: src/adapters/postgres/execution-transaction-store.ts
- Create: migrations/060_execution_transaction_identity.sql
- Create: scripts/execution-transaction-postgres.test.mjs
- Create: scripts/backfill-execution-transaction-identity.mjs
- Modify: tsconfig.portable-runtime.json
- Modify: scripts/test-integration.mjs
- Test: scripts/execution-transaction-postgres.test.mjs

**Interfaces:**
- Consumes: ExecutionIdentity, ExecutionSnapshot, SettlementReceipt, and the pure kernel values from Task 2.
- Produces the one persistence interface used by the runtime:

~~~ts
export interface ExecutionTransactionStore {
  prepareExecution(input: PrepareExecutionInput): Promise<ExecutionSnapshot>;
  claimExecution(input: ClaimExecutionInput): Promise<ClaimResult>;
  heartbeatExecution(input: HeartbeatExecutionInput): Promise<ExecutionSnapshot>;
  recordAttempt(input: RecordAttemptInput): Promise<OperationAttempt>;
  recordInvocation(input: RecordInvocationInput): Promise<OperationAttempt>;
  appendProof(input: AppendProofInput): Promise<ExecutionProof>;
  settleExecution(input: SettleExecutionInput): Promise<SettlementReceipt>;
  readExecution(executionId: string): Promise<ExecutionSnapshot | null>;
}

export type ClaimResult =
  | { kind: 'claimed'; snapshot: ExecutionSnapshot }
  | { kind: 'replayed'; snapshot: ExecutionSnapshot }
  | { kind: 'busy'; snapshot: ExecutionSnapshot };
~~~

Every mutating method accepts execution_id, lease_ref, lease_epoch, and authority_epoch. A stale compare-and-set returns a typed stale-execution result and changes zero rows.

The port owns these input/output values; define them in the same file before implementing methods:

~~~ts
export interface PrepareExecutionInput {
  identity: ExecutionIdentity;
  lifecycle: 'prepared';
}

export interface ClaimExecutionInput {
  execution_id: string;
  lease_ref: string;
  lease_epoch: number;
  authority_epoch: number;
  lease_expires_at: string;
}

export interface HeartbeatExecutionInput {
  execution_id: string;
  lease_ref: string;
  lease_epoch: number;
  authority_epoch: number;
  lease_expires_at: string;
}

export interface OperationAttempt {
  operation_id: string;
  execution_id: string;
  attempt_epoch: number;
  request_sha256: string;
  mutation_certainty: MutationCertainty;
  effect_ref: string | null;
}

export interface RecordAttemptInput {
  identity: ExecutionIdentity;
  attempt_epoch: number;
  request_sha256: string;
}

export interface RecordInvocationInput {
  identity: ExecutionIdentity;
  attempt_epoch: number;
  facts: ProviderInvocationFacts;
}

export interface ExecutionProof {
  proof_id: string;
  execution_id: string;
  operation_id: string;
  attempt_epoch: number;
  authority_repository: string;
  authority_revision: string;
  authority_epoch: number;
  predicate: string;
  evidence_sha256: string;
}

export interface AppendProofInput extends ExecutionProof {}

export interface SettleExecutionInput {
  identity: ExecutionIdentity;
  attempt_epoch: number;
  disposition: SettlementReceipt['disposition'];
  effect_ref: string | null;
  evidence_sha256: string;
}
~~~

- [ ] **Step 1: Write failing PostgreSQL constraint tests**

Add tests that create the compact schema and assert:

~~~js
assert.rejects(
  store.settleExecution({
    execution_id: executionId,
    lease_ref: oldLease,
    lease_epoch: oldEpoch,
    authority_epoch: currentEpoch,
  }),
  /STALE_EXECUTION/,
);

assert.rejects(
  store.appendProof({
    execution_id: executionId,
    operation_id: operationId,
    authority_revision: differentRevision,
  }),
  /PROOF_IDENTITY_MISMATCH/,
);
~~~

Also assert that two claims for the same subject produce one claimed row and one busy/replayed result, and that an operation with may_have_mutated cannot be compacted or settled.

Run: npm run build:portable && node --test scripts/execution-transaction-postgres.test.mjs

Expected: FAIL because the new port, adapter, migration, and constraints do not exist.

- [ ] **Step 2: Add the additive identity migration**

Create migration 060 with these concrete operations:

1. Add execution_id, operation_id, lifecycle, and current_attempt_epoch to execution_state.
2. Add execution_id, attempt_epoch, and mutation_certainty to operation_state.
3. Add execution_id, operation_id, and attempt_epoch to proof_state.
4. Add foreign keys from operation_state and proof_state to execution_state where the existing schema permits them.
5. Add unique indexes for active subject ownership, operation idempotency identity, and one settlement receipt per execution.
6. Add checks for lifecycle values, non-negative epochs, allowed certainty values, and the rule that may_have_mutated cannot be compacted.
7. Add immutable-identity and monotonic-certainty triggers using the existing authoritative-state-freeze pattern.

The migration must fail closed if an existing active compact row cannot be assigned a collision-free execution identity.

- [ ] **Step 3: Add deterministic backfill**

Implement backfill-execution-transaction-identity.mjs using canonicalJson and sha256Text. For every existing execution_state row, derive:

~~~text
execution_id = sha256({
  schema: "execution-identity-backfill-v1",
  subject_key,
  run_id,
  authority_epoch,
  authority_revision,
  lease_ref
})
~~~

Write the derived identity in one database transaction, verify uniqueness, and make the operation idempotent. Do not invent new lease or settlement state during backfill.

- [ ] **Step 4: Move SQL into the canonical TypeScript adapter**

Move the SQL currently spread across compact-execution-state-store.ts and the project-transition lease store into execution-transaction-store.ts. Implement claim, heartbeat, attempt, proof, and settlement with explicit transactions and compare-and-set predicates. Do not import the old store from the new adapter.

- [ ] **Step 5: Run adapter integration checks**

Run:

~~~bash
npm run build:portable
node --test scripts/execution-transaction-postgres.test.mjs
npm run typecheck
~~~

Expected: all new constraints and CAS tests pass, and the portable runtime compiles.

- [ ] **Step 6: Commit the canonical store**

~~~bash
git add src/ports/execution-transaction-store.ts src/adapters/postgres/execution-transaction-store.ts migrations/060_execution_transaction_identity.sql scripts/backfill-execution-transaction-identity.mjs scripts/execution-transaction-postgres.test.mjs tsconfig.portable-runtime.json scripts/test-integration.mjs
git commit -m "feat: make PostgreSQL execution state the transaction store"
~~~

---

### Task 4: Implement the kernel execution protocol and conformance suite

**Files:**
- Create: src/semantic/execution-transaction-runtime.ts
- Create: scripts/execution-transaction-conformance.test.mjs
- Modify: tsconfig.semantic.runtime.json
- Modify: scripts/build.mjs
- Test: scripts/execution-transaction-conformance.test.mjs

**Interfaces:**
- Consumes: ExecutionTransactionStore from Task 3 and the pure types from Task 2.
- Produces:

~~~ts
export interface ProviderEffect<TPayload> {
  preflight(input: {
    identity: ExecutionIdentity;
    payload: TPayload;
  }): Promise<ProviderPreflight>;
  invoke(input: {
    identity: ExecutionIdentity;
    payload: TPayload;
    preflight: ProviderPreflight;
  }): Promise<ProviderInvocationFacts>;
  readback(input: {
    identity: ExecutionIdentity;
    payload: TPayload;
    preflight: ProviderPreflight;
  }): Promise<ProviderConfirmationFacts>;
}

export interface ExecutionTransactionDependencies {
  store: ExecutionTransactionStore;
  readAuthority(input: ExecutionAuthority): Promise<ExecutionAuthority>;
  now(): string;
  createId(kind: 'execution' | 'operation' | 'lease' | 'proof'): string;
}

export async function executeExecutionTransaction<TPayload>(
  intent: ExecutionIntent<TPayload>,
  effect: ProviderEffect<TPayload>,
  dependencies: ExecutionTransactionDependencies,
): Promise<SettlementReceipt | ExecutionSnapshot>;

export async function recoverExecutionTransaction(
  executionId: string,
  effect: ProviderEffect<JsonValue>,
  dependencies: ExecutionTransactionDependencies,
): Promise<SettlementReceipt | ExecutionSnapshot>;
~~~

- [ ] **Step 1: Write the twelve failing conformance tests**

Use a fake store and controllable provider effect. Each test must assert both the returned classification and the durable fake-store calls. Cover:

1. crash before invoke;
2. crash after invoke before settle;
3. unknown provider timeout;
4. duplicate idempotency delivery;
5. stale settlement after lease replacement;
6. source revision drift;
7. evidence revision mismatch;
8. concurrent claim race;
9. provider readback confirms an already-completed effect;
10. database failure after provider mutation;
11. recovery with may_have_mutated;
12. authority epoch crossing.

Use the provider call counter to prove no uncertain effect is invoked twice.

- [ ] **Step 2: Run the conformance tests to verify failure**

Run: npm run build:runtime && node --test scripts/execution-transaction-conformance.test.mjs

Expected: FAIL because executeExecutionTransaction and recoverExecutionTransaction are not implemented.

- [ ] **Step 3: Implement prepare/claim/fence**

Prepare the canonical intent hash and identity before any provider call. Claim through the store. Re-read authority and reject if project_ref, repository, revision, graph fingerprint, transition fingerprint, or epoch differs. Reject caller-supplied provider coordinates.

- [ ] **Step 4: Implement attempt/invoke/confirmation**

Persist an operation attempt before invoke. Map provider invocation facts through mutationCertaintyFromFacts. For may_have_mutated or unknown transport, persist effect_uncertain and call readback on recovery. Never call invoke twice for one idempotency identity.

- [ ] **Step 5: Implement proof and settlement**

Create exact proof only from the same execution_id, operation_id, attempt_epoch, authority_revision, and authority_epoch. Call settleExecution only after the current fence and proof are revalidated. Return a SettlementReceipt whose hash is durable in the store.

- [ ] **Step 6: Run all conformance tests**

Run:

~~~bash
npm run build:runtime
node --test scripts/execution-transaction-conformance.test.mjs
node --test scripts/execution-transaction-kernel.test.mjs
npm run typecheck
~~~

Expected: PASS for all twelve scenarios, including zero duplicate provider effects and zero stale settlement writes.

- [ ] **Step 7: Commit the protocol**

~~~bash
git add src/semantic/execution-transaction-runtime.ts scripts/execution-transaction-conformance.test.mjs tsconfig.semantic.runtime.json scripts/build.mjs lib/execution-transaction-runtime.js
git commit -m "feat: execute effects through one transaction protocol"
~~~

---

### Task 5: Migrate project-transition execution to the kernel

**Files:**
- Modify: lib/project-transition-authoritative-effect.js
- Modify: lib/project-transition-authoritative-effect-github-runtime.js
- Modify: src/semantic/project-transition-github-workspace.ts
- Generated: lib/project-transition-github-workspace.js
- Modify: lib/project-transition-github-recovery.js
- Modify: src/semantic/project-advance-operation.ts
- Modify: src/adapters/project-advance/runtime-adapter.ts
- Modify: src/ports/project-advance-runtime-host.ts
- Modify: lib/project-advance-overcenter-host.js
- Modify: lib/project-transition-runtime.js
- Modify: lib/worker-command-handler.js
- Modify: mcp/project.advance.js
- Modify: scripts/verify-project-transition-authoritative-effect-settlement.test.mjs
- Modify: scripts/verify-project-transition-authoritative-effect-runtime.test.mjs
- Modify: scripts/verify-project-transition-settlement-atomicity.test.mjs
- Modify: scripts/verify-project-transition-mutation-workspace-authority.test.mjs
- Create: scripts/verify-project-transition-kernel-adapter.test.mjs
- Test: scripts/verify-project-transition-kernel-adapter.test.mjs

**Interfaces:**
- Consumes: executeExecutionTransaction and the PostgreSQL transaction store.
- Produces: project-transition intent construction only. Transition selection, graph dependency evaluation, and agent judgment remain semantic concerns; lease, effect, confirmation, recovery, and settlement leave this module.

- [ ] **Step 1: Write the failing adapter test**

Construct a project-transition intent with exact project_ref, repository, authority_revision, authority_epoch, graph_fingerprint, and transition_fingerprint. Assert that the adapter passes only payload and kernel identity to the provider effect and never accepts caller-selected branch, base SHA, lease token, or idempotency key.

Before changing the JavaScript host, change project-advance-operation.ts, runtime-adapter.ts, and project-advance-runtime-host.ts so the semantic operation hands one validated ProjectAdvanceIntent to the host and the host returns the kernel result. Remove startOrResumeProjectRun and advanceRun from the TypeScript port; the kernel creates and resumes the durable execution identity. Keep project_ref validation and run/result identity validation in TypeScript.

- [ ] **Step 2: Implement the project-transition effect adapter**

Replace the project-transition authoritative-effect orchestration with a thin ProviderEffect adapter. Keep GitHub workspace derivation and exact SHA comparison as preflight/provider safety. Call executeExecutionTransaction for all claim, effect, confirmation, and settlement work.

- [ ] **Step 3: Remove the legacy acquire branch**

In project-transition-leases.js and its callers, delete the hasAtomicAcquire/hasLegacyAcquire branch and the insertLease/insertSlot fallback. The only claim path is the transaction store's CAS claim.

- [ ] **Step 4: Move expiry recovery**

Make project-transition expiry recovery call recoverExecutionTransaction. An expired execution with no attempted effect may be claimed by a replacement; an execution with may_have_mutated may only confirm. Remove project-transition-specific retry recipes.

- [ ] **Step 5: Run focused project-transition tests**

Run:

~~~bash
node --test scripts/verify-project-transition-kernel-adapter.test.mjs
node --test scripts/verify-project-transition-authoritative-effect-settlement.test.mjs
node --test scripts/verify-project-transition-authoritative-effect-runtime.test.mjs
node --test scripts/verify-project-transition-settlement-atomicity.test.mjs
node --test scripts/verify-project-transition-mutation-workspace-authority.test.mjs
~~~

Expected: PASS with all settlement and stale-work protections now exercised through the kernel.

- [ ] **Step 6: Commit the project-transition migration**

~~~bash
git add lib/project-transition-runtime.js lib/project-transition-authoritative-effect.js lib/project-transition-authoritative-effect-github-runtime.js lib/project-transition-github-workspace.js lib/project-transition-github-recovery.js api/project-advance.js scripts/verify-project-transition-kernel-adapter.test.mjs scripts/verify-project-transition-authoritative-effect-settlement.test.mjs scripts/verify-project-transition-authoritative-effect-runtime.test.mjs scripts/verify-project-transition-settlement-atomicity.test.mjs scripts/verify-project-transition-mutation-workspace-authority.test.mjs
git commit -m "refactor: route project transitions through execution kernel"
~~~

---

### Task 6: Make GitHub and production providers thin capabilities

**Files:**
- Modify: lib/github-apply-changeset.js
- Modify: lib/github-lease-scoped-changeset.js
- Modify: lib/github-branch-role-runtime.js
- Modify: api/github-apply-changeset.js
- Modify: lib/github-release.js
- Modify: lib/github-production-promotion.js
- Modify: lib/github-production-promotion-runtime.js
- Modify: lib/production-reconcile.js
- Create: lib/github-execution-effects.js
- Create: scripts/verify-provider-effect-contract.test.mjs
- Modify: scripts/verify-github-pull-request-mark-ready-semantic-worker.test.mjs
- Modify: scripts/production-reconcile-operation.test.mjs
- Test: scripts/verify-provider-effect-contract.test.mjs

**Interfaces:**
- Consumes: ProviderEffect and executeExecutionTransaction.
- Produces: provider capabilities that accept kernel-derived identity and return ProviderInvocationFacts/ProviderConfirmationFacts.

- [ ] **Step 1: Write provider contract tests**

For each GitHub capability, assert:

~~~js
const effect = createGithubChangesetEffect(fakeGithub);
const result = await effect.preflight({ identity, payload });
assert.equal(result.repository, identity.authority_repository);
assert.equal(result.expected_head, identity.authority_revision);
assert.equal('lease_ref' in result, false);
~~~

Also assert that a stale SHA fails before the fake mutation method is called and that a timeout returns unknown facts rather than a retry instruction.

- [ ] **Step 2: Implement GitHub effect capabilities**

Move only GitHub API translation, exact SHA comparison, branch-role enforcement, permission checks, conditional writes, and authoritative readback into github-execution-effects.js. The kernel supplies operation identity, idempotency identity, authority revision, and lease fence. Do not import orchestration recovery or settlement code into this file.

- [ ] **Step 3: Route changesets through the kernel**

Keep the bounded github.apply_changeset input contract lease-scoped during migration, but resolve its lease into an ExecutionIntent and invoke the GitHub changeset capability through executeExecutionTransaction. Remove executeCorrelatedCommand and provider-local operation state from this path.

- [ ] **Step 4: Route release, promotion, and materialization**

Convert release creation, production promotion, and runtime materialization to the same intent/effect shape. Preserve exact target commit, expected state, idempotency, provider readback, and post-mutation uncertainty behavior. Delete pseudo-leases that exist only to emulate execution authority.

- [ ] **Step 5: Run provider tests**

Run:

~~~bash
node --test scripts/verify-provider-effect-contract.test.mjs
node --test scripts/verify-github-pull-request-mark-ready-semantic-worker.test.mjs
node --test scripts/production-reconcile-operation.test.mjs
node --test scripts/production-reconcile-host.test.mjs
node --test scripts/production-runtime-observation-http.test.mjs
~~~

Expected: provider-specific safety remains green while no provider test asserts a provider-owned lease, retry, recovery, or settlement implementation.

- [ ] **Step 6: Commit the provider migration**

~~~bash
git add lib/github-execution-effects.js lib/github-apply-changeset.js lib/github-lease-scoped-changeset.js lib/github-branch-role-runtime.js api/github-apply-changeset.js lib/github-release.js lib/github-production-promotion.js lib/github-production-promotion-runtime.js lib/production-reconcile.js scripts/verify-provider-effect-contract.test.mjs scripts/verify-github-pull-request-mark-ready-semantic-worker.test.mjs scripts/production-reconcile-operation.test.mjs
git commit -m "refactor: make GitHub effects kernel capabilities"
~~~

---

### Task 7: Migrate authoring, portfolio reconciliation, and orchestration recovery

**Files:**
- Modify: src/semantic/project-authoring-runtime.ts
- Modify: src/semantic/project-authoring-github-runtime.ts
- Modify: src/semantic/project-definition-mutation-authority.ts
- Modify: src/semantic/project-definition-changeset-writer.ts
- Generated: lib/project-authoring-runtime.js
- Generated: lib/project-authoring-github-runtime.js
- Generated: lib/project-definition-mutation-authority.js
- Generated: lib/project-definition-changeset-writer.js
- Modify: lib/deterministic-work-settlement.js
- Modify: lib/compact-portfolio-reconcile-receipt-store.js
- Modify: lib/orchestration-journal.js
- Modify: lib/orchestration-recovery.js
- Modify: lib/orchestration-finish-runtime.js
- Modify: lib/orchestration-runs.js
- Modify: scripts/gcp-semantic-project-amend-bridge.test.mjs
- Modify: scripts/verify-project-authoring-mutation-authority.test.mjs
- Modify: scripts/verify-project-authoring-readback-contract.test.mjs
- Modify: scripts/verify-execution-evidence-projector.test.mjs
- Create: scripts/verify-orchestration-kernel-recovery.test.mjs
- Test: scripts/verify-orchestration-kernel-recovery.test.mjs

**Interfaces:**
- Consumes: ExecutionIntent and executeExecutionTransaction.
- Produces: project-definition, portfolio-reconcile, and orchestration-maintenance intents. orchestration_runs stores correlation and unresolved operation pointers only.

- [ ] **Step 1: Write the failing authoring/recovery tests**

Assert that project.amend builds one intent containing exact expected_revision and that the authoring runtime does not call a separate mutation-certainty classifier. Assert that orchestration maintenance delegates may-have-mutated work to confirm-only recovery.

~~~js
assert.equal(result.intent.authority.revision, expectedRevision);
assert.equal(result.recovery, 'confirm_only');
assert.equal(result.settlement_source, 'execution_transaction');
~~~

- [ ] **Step 2: Route project authoring through the kernel**

Keep canonicalProjectDefinition and applyProjectDefinitionAmendment as pure graph validation. Replace the authoring runtime's independent mutate/readback/recovery ceremony with a project-definition ExecutionIntent and the GitHub changeset capability. The refreshed definition and graph readback become proof for the same execution identity.

- [ ] **Step 3: Route portfolio reconciliation through the kernel**

Delete the compact portfolio receipt store's claim/recovery/succeed implementation. Build a portfolio-reconcile intent and use one provider capability plus one SettlementReceipt. Preserve exact source revision and authoritative readback.

- [ ] **Step 4: Reduce orchestration to correlation and recovery dispatch**

Remove correctness decisions from orchestration-journal.js and orchestration-finish-runtime.js. Keep run creation, continuation correlation, bounded diagnostics, and receipt projection. Make orchestration-recovery.js call classifyRecovery/recoverExecutionTransaction and return its typed decision without inventing a provider retry.

- [ ] **Step 5: Run focused authoring and recovery tests**

Run:

~~~bash
node --test scripts/gcp-semantic-project-amend-bridge.test.mjs
node --test scripts/verify-project-authoring-mutation-authority.test.mjs
node --test scripts/verify-project-authoring-readback-contract.test.mjs
node --test scripts/verify-execution-evidence-projector.test.mjs
node --test scripts/verify-orchestration-kernel-recovery.test.mjs
~~~

Expected: authoring, reconciliation, and maintenance all produce or inspect kernel transactions rather than their own receipt/lease protocols.

- [ ] **Step 6: Commit the semantic caller migration**

~~~bash
git add lib/project-authoring-runtime.js lib/project-authoring-github-runtime.js lib/project-definition-mutation-authority.js lib/project-definition-changeset-writer.js lib/deterministic-work-settlement.js lib/compact-portfolio-reconcile-receipt-store.js lib/orchestration-journal.js lib/orchestration-recovery.js lib/orchestration-finish-runtime.js lib/orchestration-runs.js scripts/gcp-semantic-project-amend-bridge.test.mjs scripts/verify-project-authoring-mutation-authority.test.mjs scripts/verify-project-authoring-readback-contract.test.mjs scripts/verify-execution-evidence-projector.test.mjs scripts/verify-orchestration-kernel-recovery.test.mjs
git commit -m "refactor: centralize authoring and recovery semantics"
~~~

---

### Task 8: Delete duplicate authority, evidence, lease, receipt, and compatibility paths

**Files:**
- Delete: lib/work-leases.js
- Delete: lib/work-lifecycle.js
- Delete: lib/work-settle-contract.js
- Delete: lib/project-transition-leases.js
- Delete: lib/project-transition-lease-store.js
- Delete: lib/project-transition-certificate.js
- Delete: lib/execution-authority.js
- Delete: lib/execution-authority-core.js
- Delete: lib/execution-authority-contracts.js
- Delete: lib/legacy-work-execution-authority-contracts.js
- Delete: lib/execution-evidence.js
- Delete: lib/execution-evidence-store.js
- Delete: lib/execution-evidence-contracts.js
- Delete: lib/bounded-evidence.js
- Delete: lib/deterministic-work-settlement.js
- Delete: lib/compact-provider-operation-store.js
- Delete: lib/compact-github-changeset-receipt-store.js
- Delete: lib/compact-github-release-receipt-store.js
- Delete: lib/compact-github-production-promotion-receipt-store.js
- Delete: lib/compact-portfolio-reconcile-receipt-store.js
- Delete: lib/compact-proof-state-store.js
- Delete: src/semantic/execution-authority-core.ts
- Delete: src/semantic/execution-authority-contracts.ts
- Delete: src/semantic/legacy-work-execution-authority-contracts.ts
- Delete: src/semantic/execution-evidence.ts
- Delete: src/semantic/execution-evidence-contracts.ts
- Delete: src/semantic/mutation-certainty.ts
- Delete: src/semantic/compact-execution-state.ts
- Delete: src/ports/compact-execution-state-store.ts
- Delete: src/adapters/postgres/compact-execution-state-store.ts
- Modify: scripts/build.mjs
- Modify: tsconfig.semantic.runtime.json
- Modify: tsconfig.portable-runtime.json
- Create: scripts/verify-unified-execution-boundary.test.mjs
- Test: scripts/verify-unified-execution-boundary.test.mjs

**Interfaces:**
- Consumes: all migrated callers from Tasks 5 through 7.
- Produces: one imported execution transaction module, one store port, one PostgreSQL adapter, and zero production imports of deleted paths.

- [ ] **Step 1: Write the deletion-boundary test**

Create a source audit that fails when any production file imports a deleted module or declares generic lease, settlement, recovery, or mutation-certainty policy outside the canonical kernel.

Implement productionImporters(reference) by recursively reading api, lib, mcp, pages, and src/adapters, then counting import/export specifiers that resolve to reference. Implement providerFilesContainingGenericRecovery() and providerFilesContainingGenericSettlement() by scanning provider path prefixes (github, gcp, production, release, portfolio) for the canonical policy function names and returning matching file counts.

~~~js
const forbidden = [
  'lib/work-leases.js',
  'lib/project-transition-leases.js',
  'lib/execution-authority-core.js',
  'lib/execution-evidence-store.js',
  'lib/compact-provider-operation-store.js',
];
for (const reference of forbidden) {
  assert.equal(await productionImporters(reference), 0, reference);
}
assert.equal(await providerFilesContainingGenericRecovery(), 0);
assert.equal(await providerFilesContainingGenericSettlement(), 0);
~~~

- [ ] **Step 2: Move remaining types into the kernel**

Move any still-used exact identity/evidence/certainty types into execution-transaction.ts or the execution-transaction store port. Update imports in one commit without changing behavior. Preserve runtime-generated names until the build succeeds.

- [ ] **Step 3: Delete compatibility APIs**

Remove legacy work lease exports, insertLease/insertSlot persistence methods, compatibility transition bindings used only by the old acquire path, legacy authority contracts, and compatibility command exposure. Remove their tests when they assert only deleted behavior; retain tests that prove the kernel replacement invariant.

- [ ] **Step 4: Delete provider receipt stores and evidence reconstruction**

Remove compact provider receipt stores and execution-evidence-store reconstruction from historical journals. Keep proof_state readback and SettlementReceipt inspection. Historical migrations remain untouched.

- [ ] **Step 5: Remove generated mirror entries**

Delete old files from scripts/build.mjs and both runtime tsconfig include lists. Add only execution-transaction.ts and execution-transaction-runtime.ts to the semantic runtime mirror. Generate lib output and verify that no stale generated module remains imported.

- [ ] **Step 6: Run the deletion audit**

Run:

~~~bash
npm run build
node --test scripts/verify-unified-execution-boundary.test.mjs
node scripts/verify-regression-suite-registry.mjs
npm run typecheck
~~~

Expected: the source audit reports one lifecycle model, one certainty implementation, one settlement implementation, one recovery classifier, one lease claim implementation, and no deleted-module import.

- [ ] **Step 7: Commit the deletion wave**

~~~bash
git add -A
git commit -m "refactor: delete duplicated execution correctness paths"
~~~

---

### Task 9: Update command contracts, docs, and graph obligations

**Files:**
- Modify: mcp/project.advance.js if its contract still exposes manual execution bookkeeping
- Modify: mcp/project.amend.js if its contract still exposes separate mutation semantics
- Modify: src/semantic/semantic-command-descriptors.ts
- Generated: lib/semantic-command-descriptors.js
- Modify: docs/command-reference.md
- Modify: docs/agent-session-contract.md
- Modify: docs/architecture/recovery-kernel-and-self-healing.md
- Modify: docs/architecture/ontology-and-authority.md
- Create: docs/architecture/execution-transaction-kernel.md
- Test: scripts/verify-mcp-admission-contract.test.mjs
- Test: scripts/verify-semantic-command-descriptors.test.mjs
- Test: scripts/verify-unified-execution-boundary.test.mjs

**Interfaces:**
- Consumes: the final kernel lifecycle and command caller behavior.
- Produces: agent-facing contracts that describe intent and bounded judgment only; no manual inspect/claim/lease/effect/retry/settle choreography.

- [ ] **Step 1: Write the contract regression tests**

Assert that ordinary project.advance accepts project intent and bounded execution judgment but does not expose lease_token, authority_epoch, mutation_certainty, evidence certification, or settlement fields as agent-owned inputs. Assert that advanced provider commands are internal capabilities, not peer ordinary-agent commands.

- [ ] **Step 2: Update semantic descriptors**

Make the descriptors say that Overcenter derives run identity, lease identity, exact revision, idempotency, evidence, recovery, and settlement. Remove compatibility command discovery where the underlying path is deleted.

- [ ] **Step 3: Update architecture documentation**

Document one lifecycle, one store, the provider capability boundary, the certainty/recovery matrix, and the fact that orchestration_runs is correlation-only. Remove references that describe legacy work leases or provider receipt stores as live authorities.

- [ ] **Step 4: Add the canonical kernel architecture document**

Create execution-transaction-kernel.md with:

~~~text
semantic intent
  -> prepare identity and exact authority
  -> fenced lease claim
  -> provider preflight/invoke
  -> certainty and confirmation
  -> exact proof
  -> durable settlement receipt
  -> fresh authoritative project state
~~~

Also include the stale-worker and may-have-mutated rules in the document so a fresh agent can act correctly from the repository.

- [ ] **Step 5: Run contract tests**

Run:

~~~bash
node --test scripts/verify-mcp-admission-contract.test.mjs
node --test scripts/verify-semantic-command-descriptors.test.mjs
node --test scripts/verify-unified-execution-boundary.test.mjs
~~~

Expected: ordinary agents see semantic intent; generic execution bookkeeping is not exposed as a required caller protocol.

- [ ] **Step 6: Commit the contract/docs update**

~~~bash
git add mcp/project.advance.js mcp/project.amend.js lib/semantic-command-descriptors.js docs/command-reference.md docs/agent-session-contract.md docs/architecture/recovery-kernel-and-self-healing.md docs/architecture/ontology-and-authority.md docs/architecture/execution-transaction-kernel.md scripts/verify-mcp-admission-contract.test.mjs scripts/verify-semantic-command-descriptors.test.mjs scripts/verify-unified-execution-boundary.test.mjs
git commit -m "docs: make execution transaction boundary authoritative"
~~~

---

### Task 10: Run the complete verification and measure the deletion

**Files:**
- Modify: scripts/test.mjs
- Modify: scripts/test-integration.mjs
- Modify: scripts/verify.mjs
- Modify: scripts/measure-execution-correctness.mjs
- Modify: docs/architecture/execution-transaction-kernel.md
- Test: all maintained repository tests and integration tests

**Interfaces:**
- Consumes: all migrated code and deletion-boundary checks.
- Produces: before/after metrics, CI evidence, exact-revision runtime evidence, and a final tree with one execution correctness mechanism.

- [ ] **Step 1: Register the kernel and deletion tests**

Add execution-transaction-kernel.test.mjs, execution-transaction-conformance.test.mjs, verify-unified-execution-boundary.test.mjs, and all retained provider/authoring tests to the maintained test registry. Remove test entries whose only behavior was deleted compatibility.

- [ ] **Step 2: Run focused local or scratch verification**

When a full checkout is available, run:

~~~bash
npm install
npm run typecheck
npm run build
node --test scripts/execution-transaction-kernel.test.mjs
node --test scripts/execution-transaction-conformance.test.mjs
node --test scripts/verify-unified-execution-boundary.test.mjs
~~~

When the full checkout is unavailable, run the pure TypeScript kernel and fake-store conformance suite in the scratch workspace, record the exact Node version and source revision, and leave PostgreSQL/GitHub Actions verification to CI. Do not claim the complete suite passed from a scratch-only run.

- [ ] **Step 3: Run PostgreSQL integration verification**

Run:

~~~bash
npm run test:integration
~~~

Expected: migration, CAS fencing, idempotency, proof binding, compacting, recovery, project-transition, production-promotion, and portfolio tests pass against PostgreSQL.

- [ ] **Step 4: Run the repository verification**

Run:

~~~bash
npm test
npm run verify
~~~

Expected: the maintained regression suite, generated runtime mirror checks, public-release checks, source-boundary checks, and JavaScript syntax checks all pass.

- [ ] **Step 5: Produce before/after metrics**

Run the measurement script at the pinned pre-refactor revision and final head using the same classification rules:

~~~bash
node scripts/measure-execution-correctness.mjs --json > execution-metrics-after.json
~~~

Compare against the baseline captured in Task 1. Record the actual counts in docs/architecture/execution-transaction-kernel.md and the final handoff. The final report must state the number of deleted production lines, test-line change, lease/recovery/settlement/certainty/lifecycle implementations before and after, provider-specific generic concepts before and after, compatibility modules before and after, and active correctness tables before and after.

- [ ] **Step 6: Verify exact source/runtime and deployment revision**

Run the repository's exact-revision verification workflow. Confirm:

- generated lib mirrors the TypeScript source;
- dev and the authoritative deployment target point to the same full SHA;
- Cloud SQL migrations applied successfully;
- a normal project transition can inspect -> advance/claim -> execute -> confirm -> settle -> inspect;
- zero stranded active leases remain;
- an uncertain effect is confirm-only;
- stale workers cannot settle;
- the final receipt and evidence are durable and inspectable.

- [ ] **Step 7: Amend the Overcenter graph through the semantic command**

Once the implementation branch is at its final exact SHA and the graph authoring path is healthy, use project.amend with the published mcp/project.amend contract to add or amend only obligation-shaped nodes:

~~~text
unified-execution-identity
single-lease-authority
central-mutation-certainty
evidence-bound-settlement
deterministic-recovery
provider-semantic-thinness
legacy-execution-path-elimination
~~~

Bind the amendment to the exact final source revision. If the command reports may_have_mutated=true, stop and use the returned recovery operation before retrying. Do not edit .overcenter directly.

- [ ] **Step 8: Request review before integration**

Open the review path from the implementation branch with the exact final SHA, include test/CI/metric evidence, and explicitly list every deleted module and every intentional remaining provider-specific safety path. Do not merge or promote until the final source revision, database revision, and settlement evidence are all exact and inspectable.

---


## Spec-to-task coverage

| Design-spec obligation | Plan tasks that implement or verify it |
|---|---|
| Inventory duplication and planned survivor/deletion | Task 1 baseline measurement; Tasks 5 through 8 caller migration and deletion |
| TypeScript semantic source and generated runtime boundary | Task 2 kernel source; Tasks 3 and 4 runtime/portable builds; Task 8 mirror deletion |
| Execution identity and idempotency | Tasks 2, 3, and 4 |
| Authority fencing and exact revision binding | Tasks 2, 4, 5, and 6 |
| Single lease ownership and stale-worker fencing | Tasks 3, 4, and 5 |
| Effect execution and provider capability boundary | Tasks 4 and 6 |
| Mutation certainty and confirm-only recovery | Tasks 2, 4, 6, and 7 |
| Exact evidence and proof binding | Tasks 2, 3, 4, and 7 |
| Durable settlement and inspectable receipts | Tasks 3, 4, 5, and 7 |
| Centralized recovery classification | Tasks 2, 4, 5, and 7 |
| Project-transition, authoring, promotion, and reconciliation callers | Tasks 5, 6, and 7 |
| Compatibility and migration-path deletion | Task 8 |
| Database constraints and transaction boundaries | Task 3 |
| Twelve required failure scenarios | Task 4 conformance suite and Task 10 PostgreSQL/CI verification |
| Kernel/provider/end-to-end testing strategy | Tasks 1, 2, 4, 6, and 10 |
| Before/after metrics | Tasks 1 and 10 |
| Obligation-shaped graph representation | Task 9 contract/docs and Task 10 semantic graph amendment |
| Hatchable transport-only and GCP authority boundary | Global Constraints; Tasks 7, 9, and 10 |


## Completion definition

The plan is complete only when all of these are true:

- TypeScript contains the authoritative generic transaction lifecycle.
- lib is generated runtime output, not an independent semantic implementation.
- execution_state owns one lifecycle and one fenced lease.
- operation_state owns one idempotent effect ledger.
- proof_state owns exact immutable evidence.
- orchestration_runs is correlation-only.
- project transitions, authoring, GitHub effects, release, promotion, materialization, and reconciliation invoke the same kernel.
- uncertain effects cannot be blindly retried.
- stale workers cannot mutate or settle newer executions.
- provider modules contain provider safety, not generic transaction semantics.
- old lease, evidence, settlement, recovery, mutation-certainty, receipt, and compatibility paths are deleted or retained only as immutable migration history.
- the twelve required failure scenarios are proven in the conformance suite.
- full CI and PostgreSQL integration verification pass at one exact final revision.
- before/after metrics demonstrate fewer active concepts and less execution-correctness code.
