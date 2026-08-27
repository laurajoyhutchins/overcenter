# execution-evidence-v1 Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #150 as a deterministic, read-only `execution-evidence-v1` projector over existing durable Overcenter execution evidence, with no duplicate execution ledger and no provider mutation.

**Architecture:** Add a pure projector that accepts already-loaded durable rows and returns a stable run-centric semantic projection. Reuse one canonical bounded-evidence redaction helper for journal-derived data, and add a narrow Postgres source adapter that loads only evidence attributable to the requested run. Do not add an API/MCP surface, ODCS artifact, integrity verifier, or new persistence table in this plan.

**Tech Stack:** JavaScript ES modules, Hatchable Postgres binding, Node built-in test runner, existing Overcenter command/journal conventions.

**Spec:** `docs/superpowers/specs/2026-08-27-execution-evidence-v1-design.md`

## Global Constraints

- `execution-evidence-v1` is a deterministic read projection, not a second execution ledger.
- Every projected fact is either Overcenter-owned execution evidence or a bounded observation of an explicitly named external authority.
- GitHub and Linear remain authoritative for their own state; projection never promotes cached provider facts into authority.
- Preserve original command outcomes even when later resolution changes mutation certainty.
- Unknown remains unknown until durable evidence resolves it.
- Do not add a read-time `generated_at` field inside the native projection.
- Do not add a new execution-evidence persistence table.
- Do not expose prompts, chain of thought, credentials, API tokens, lease tokens, token hashes, full patches, complete source files, binaries, arbitrary request/response bodies, or complete provider objects.
- Verification is included only when an exact durable execution reference attributes it to the requested run; work-ref coincidence alone is insufficient.
- V1 remains run-centric; transport and query expansion belong to #151.

---

## File structure

- Create `lib/bounded-evidence.js`: canonical bounded/redacted object projection helper reused by orchestration receipts and execution evidence.
- Create `lib/bounded-evidence.test.js`: focused regression tests for redaction, depth, item limits, and deterministic key handling.
- Modify `lib/orchestration-runs.js`: replace the local bounded receipt/object helper with the shared helper without changing existing receipt semantics.
- Create `lib/execution-evidence.js`: pure entity projection, stable ordering, command effect certainty derivation, and top-level `execution-evidence-v1` construction.
- Create `lib/execution-evidence.test.js`: synthetic evidence fixtures for success, pre-mutation rejection, indeterminate/resolved effects, incomplete evidence, stable ordering, and redaction.
- Create `lib/execution-evidence-store.js`: Postgres source adapter that loads exact-run durable evidence and only explicitly attributable verification receipts.
- Create `lib/execution-evidence-store.test.js`: fake-DB tests proving query boundaries, run attribution, stable source shapes, and no provider rereads.
- Create `scripts/verify-execution-evidence-projector.test.mjs`: Node test wrapper used by repository verification.
- Modify `.github/workflows/regression-suite-registry.yml`: add the focused projector test command so PR verification exercises #150.

---

### Task 1: Extract one canonical bounded-evidence projection helper

**Files:**
- Create: `lib/bounded-evidence.js`
- Create: `lib/bounded-evidence.test.js`
- Modify: `lib/orchestration-runs.js`

**Interfaces:**
- Consumes: arbitrary values already admitted to an Overcenter bounded evidence path.
- Produces:
  - `boundedEvidenceText(value, max = 512): string | null`
  - `boundedEvidenceProjection(value, depth = 0): JSON-safe bounded value`
- Later tasks import `boundedEvidenceProjection` to defensively re-bound journal request/result projections.

- [ ] **Step 1: Write the failing helper tests**

Create `lib/bounded-evidence.test.js` with the repository's existing exported test-runner style. Cover all of these cases:

```js
import { boundedEvidenceProjection, boundedEvidenceText } from 'lib/bounded-evidence.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

export async function runBoundedEvidenceTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('drops secret-bearing and body/content keys at every object level', async () => {
    const projected = boundedEvidenceProjection({
      safe: 'yes',
      token: 'drop',
      credential: 'drop',
      nested: { password: 'drop', body: 'drop', keep: 'ok' },
    });
    assert(projected.safe === 'yes', 'safe field missing');
    assert(projected.token === undefined && projected.credential === undefined, 'top-level secret leaked');
    assert(projected.nested.keep === 'ok', 'nested safe field missing');
    assert(projected.nested.password === undefined && projected.nested.body === undefined, 'nested secret leaked');
  });

  await test('bounds strings, arrays, keys, and object breadth deterministically', async () => {
    const projected = boundedEvidenceProjection({
      long: 'x'.repeat(5000),
      list: Array.from({ length: 40 }, (_, index) => index),
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index).padStart(2, '0')}`, index])),
    });
    assert(projected.long.length === 1024, 'string was not bounded');
    assert(projected.list.length === 25, 'array was not bounded');
    assert(Object.keys(projected).length <= 30, 'object breadth was not bounded');
  });

  await test('bounds excessive nesting instead of traversing indefinitely', async () => {
    const projected = boundedEvidenceProjection({ a: { b: { c: { d: { e: 'value' } } } } });
    assert(typeof projected.a.b.c.d === 'string', 'deep value was not collapsed');
  });

  await test('normalizes receipt text consistently', async () => {
    assert(boundedEvidenceText('  abc  ', 10) === 'abc', 'text was not trimmed');
    assert(boundedEvidenceText('', 10) === null, 'empty text was not null');
    assert(boundedEvidenceText('abcdefghijk', 4) === 'abcd', 'text was not bounded');
  });

  return { ok: results.every((entry) => entry.ok), passed: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length, total: results.length, results };
}
```

- [ ] **Step 2: Add a Node wrapper and run the test to verify red**

Temporarily create `scripts/verify-execution-evidence-projector.test.mjs` with only the bounded-evidence test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedEvidenceTests } from '../lib/bounded-evidence.test.js';

test('bounded execution evidence projection', async () => {
  const result = await runBoundedEvidenceTests();
  assert.equal(result.ok, true, JSON.stringify(result.results.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});
```

Run in CI or an environment with Overcenter's module resolution:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
```

Expected: FAIL because `lib/bounded-evidence.js` does not exist.

- [ ] **Step 3: Implement the shared helper**

Create `lib/bounded-evidence.js` by extracting the semantics currently embedded in `lib/orchestration-runs.js`:

```js
export function boundedEvidenceText(value, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

export function boundedEvidenceProjection(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : String(value).slice(0, 1024);
  if (typeof value === 'string') return value.slice(0, 1024);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => boundedEvidenceProjection(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1024);
  const result = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    if (/token|secret|password|credential|content|body/i.test(key)) continue;
    result[String(key).slice(0, 128)] = boundedEvidenceProjection(value[key], depth + 1);
  }
  return result;
}
```

- [ ] **Step 4: Reuse the helper in orchestration run receipts**

In `lib/orchestration-runs.js`:

1. Import `boundedEvidenceProjection` and `boundedEvidenceText` from `lib/bounded-evidence.js`.
2. Remove local `boundedReceiptText` and `boundedReceiptProjection` implementations.
3. Replace `boundedReceiptText(...)` calls with `boundedEvidenceText(...)`.
4. Replace `boundedReceiptProjection(...)` calls with `boundedEvidenceProjection(...)`.
5. Do not alter journal evidence shape, array limits, key filters, or receipt hashes beyond the helper rename/extraction.

- [ ] **Step 5: Run focused and existing orchestration tests**

Run:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
node --test scripts/verify-project-horizon.test.mjs
```

Expected: PASS. The second command is a guard against receipt/run behavior changing during helper extraction.

- [ ] **Step 6: Commit**

```bash
git add lib/bounded-evidence.js lib/bounded-evidence.test.js lib/orchestration-runs.js scripts/verify-execution-evidence-projector.test.mjs
git commit -m "refactor: centralize bounded execution evidence projection"
```

---

### Task 2: Implement the pure `execution-evidence-v1` projector

**Files:**
- Create: `lib/execution-evidence.js`
- Create: `lib/execution-evidence.test.js`
- Modify: `scripts/verify-execution-evidence-projector.test.mjs`

**Interfaces:**
- Consumes one source bundle:

```js
{
  run,
  leases: [],
  checkpoints: [],
  heartbeats: [],
  invocations: [],
  resolutions: [],
  verifications: []
}
```

- Produces:
  - `projectExecutionEvidence(source): ExecutionEvidenceV1`
  - `deriveMutationCertainty(invocation, resolutions): 'not_applicable' | 'definitively_absent' | 'confirmed_present' | 'unknown'`
  - `executionEvidenceInternals` only for deterministic unit-test seams such as sorting/reference helpers; do not expose database access through this object.

- [ ] **Step 1: Write the failing semantic fixtures**

Create `lib/execution-evidence.test.js`. Use compact synthetic rows and assert these exact semantics:

1. **Clean verified success**
   - run status/disposition are projected without equating terminal run state to verification;
   - settled lease is projected without token/token-hash fields;
   - successful mutation with explicit durable `verified: true` in its bounded result projects `effect.mutation_certainty = 'confirmed_present'`;
   - explicit exact-run verification remains separate and projects `status = 'verified'`.

2. **Pre-mutation request failure**
   - `outcome = 'failed'`, `error_code = 'REQUEST_INVALID'`, `may_have_mutated = false` projects `definitively_absent`;
   - no lease or settlement is fabricated.

3. **Indeterminate then externally confirmed**
   - original `outcome` remains `indeterminate`;
   - `externally_confirmed` resolution changes only mutation certainty to `confirmed_present`;
   - `resolution_refs` contains the stable resolution reference.

4. **Indeterminate then definitively not applied**
   - original outcome remains `indeterminate`;
   - mutation certainty becomes `definitively_absent`.

5. **Unresolved potentially-mutating command**
   - `may_have_mutated = true` with no conclusive resolution projects `unknown`.

6. **Read-only command**
   - a known observational command such as `github.review_packet` projects `not_applicable` even though generic mutation fields are absent.

7. **Resolution precedence**
   - conclusive `externally_confirmed` or `definitively_not_applied` dominates unresolved historical status;
   - `superseded` and `abandoned` without independent conclusive evidence remain `unknown`.

8. **Stable ordering**
   - shuffled leases, checkpoints, invocations, resolutions, and verifications produce identical projection ordering.

9. **Defensive redaction**
   - request/result projections containing nested `token`, `password`, `body`, `content`, or `credential` keys cannot appear in serialized output.

10. **No read-time clock**
    - projected object contains no `generated_at` and two calls over the same source are deep-equal.

Use representative assertions such as:

```js
const projected = projectExecutionEvidence(source);
assert(projected.schema === 'execution-evidence-v1', 'wrong schema');
assert(projected.commands[0].outcome === 'indeterminate', 'original outcome was rewritten');
assert(projected.commands[0].effect.mutation_certainty === 'confirmed_present', 'resolution did not resolve effect certainty');
assert(JSON.stringify(projected).includes('super-secret') === false, 'secret leaked');
assert(JSON.stringify(projectExecutionEvidence(source)) === JSON.stringify(projectExecutionEvidence(source)), 'projection is not deterministic');
```

- [ ] **Step 2: Update the Node wrapper and verify red**

Extend `scripts/verify-execution-evidence-projector.test.mjs`:

```js
import { runExecutionEvidenceTests } from '../lib/execution-evidence.test.js';

test('execution-evidence-v1 projector semantics', async () => {
  const result = await runExecutionEvidenceTests();
  assert.equal(result.ok, true, JSON.stringify(result.results.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});
```

Run:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
```

Expected: FAIL because `lib/execution-evidence.js` does not exist.

- [ ] **Step 3: Implement stable entity references and ordering**

In `lib/execution-evidence.js`, use deterministic references that are derivable from durable identity:

```js
function leaseRef(lease) { return lease?.lease_id ? `lease:${lease.lease_id}` : null; }
function invocationRef(invocation) { return invocation?.invocation_id ? `invocation:${invocation.invocation_id}` : null; }
function checkpointRef(checkpoint) { return checkpoint?.checkpoint_id ? `checkpoint:${checkpoint.checkpoint_id}` : null; }
function resolutionRef(resolution) { return resolution?.resolution_id ? `resolution:${resolution.resolution_id}` : null; }
function verificationRef(verification) { return verification?.predicate_key ? `verification:${verification.predicate_key}` : null; }
```

Sort with explicit durable fields and stable ID tie-breakers. Do not rely on input order.

- [ ] **Step 4: Implement mutation-certainty derivation conservatively**

Use this order of precedence:

```js
const READ_ONLY_COMMANDS = new Set([
  'github.review_packet',
  'github.capabilities',
  'orchestration.resume_packet',
  'orchestration.diagnose',
  'orchestration.status',
  'orchestration.horizon_resolve',
]);

export function deriveMutationCertainty(invocation, resolutions = []) {
  if (READ_ONLY_COMMANDS.has(invocation?.command)) return 'not_applicable';
  const matching = resolutions.filter((resolution) => resolution.invocation_id === invocation?.invocation_id);
  if (matching.some((resolution) => resolution.resolution_kind === 'externally_confirmed')) return 'confirmed_present';
  if (matching.some((resolution) => resolution.resolution_kind === 'definitively_not_applied')) return 'definitively_absent';
  if (invocation?.may_have_mutated === false) return 'definitively_absent';
  if (invocation?.outcome === 'indeterminate' || invocation?.may_have_mutated === true) return 'unknown';
  if (invocation?.outcome === 'succeeded' && invocation?.result_projection?.verified === true) return 'confirmed_present';
  return 'unknown';
}
```

Do not treat `succeeded` generically as proof of resulting-state verification. `result_projection.verified === true` only proves the immediate command effect where the command already emits that durable semantic; explicit verification records stay separate.

- [ ] **Step 5: Implement the top-level pure projection**

`projectExecutionEvidence(source)` must return exactly these top-level keys in stable construction order:

```js
{
  schema: 'execution-evidence-v1',
  run,
  target,
  work_observations,
  leases,
  checkpoints,
  commands,
  settlements,
  verifications,
  recoveries,
  integrity: { status: 'not_evaluated', violations: [] },
}
```

Key requirements:

- `run` projects identity, worker/mode/scope, lifecycle, disposition, timestamps, stop reason, predecessor, and durable target metadata where present.
- `target` comes from `orchestration_runs.target` and related hashes only; do not synthesize a provider target.
- `work_observations` are derived only from safe durable claim/settlement receipt projections and explicit source evidence already present in the source bundle. If a field is not durably present, omit or set it to `null`; never reread Linear here.
- `leases` never contain `lease_token`, `token_hash`, `claim_idempotency_key`, or raw claim request data.
- `checkpoints` contain checkpoint identity, lease identity, checkpoint digest, durable timestamp, and `boundedEvidenceProjection(checkpoint.checkpoint)`.
- `heartbeats` are not a mandatory top-level entity in v1. Use them only if needed to derive lease chronology; do not expose progress hashes as a new consumer contract unless a test demonstrates semantic need.
- `commands` preserve `outcome`, error metadata, `may_have_mutated`, bounded request/result projections, derived `effect.mutation_certainty`, and stable `resolution_refs`.
- `settlements` are projected only from leases with settlement evidence; unresolved/settling leases are not reported as clean settlements.
- `verifications` include only rows supplied as explicitly attributable by the source adapter.
- `recoveries` project durable invocation resolution rows and preserve original invocation identity.
- `integrity` remains `not_evaluated` in #150; #152 owns completeness violations.

- [ ] **Step 6: Run the projector tests**

Run:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
```

Expected: PASS with both bounded-evidence and projector semantic tests green.

- [ ] **Step 7: Commit**

```bash
git add lib/execution-evidence.js lib/execution-evidence.test.js scripts/verify-execution-evidence-projector.test.mjs
git commit -m "feat: project canonical execution evidence"
```

---

### Task 3: Add the exact-run Postgres source adapter and repository verification

**Files:**
- Create: `lib/execution-evidence-store.js`
- Create: `lib/execution-evidence-store.test.js`
- Modify: `scripts/verify-execution-evidence-projector.test.mjs`
- Modify: `.github/workflows/regression-suite-registry.yml`

**Interfaces:**
- Produces:
  - `createPostgresExecutionEvidenceStore(dbBinding): { loadRunEvidence(runId): Promise<SourceBundle | null> }`
- `loadRunEvidence` returns `null` when the run does not exist. #151 will own request validation and stable transport errors.
- No provider client/API dependency is accepted by this store.

- [ ] **Step 1: Write the failing store tests**

Create `lib/execution-evidence-store.test.js` with a fake `dbBinding.query(sql, params)` that records calls and returns deterministic rows by SQL pattern.

Assert all of the following:

1. The first query is exact run lookup by `run_id`.
2. Missing run returns `null` and performs no lease/checkpoint/journal/verification queries.
3. Existing run loads:
   - leases by exact `run_id`;
   - checkpoints through `work_lease_checkpoints JOIN work_leases` fenced by exact `run_id`;
   - heartbeats through `work_lease_heartbeats JOIN work_leases` fenced by exact `run_id`;
   - invocations by exact `run_id` ordered by sequence and invocation ID;
   - resolutions through `orchestration_invocation_resolutions JOIN orchestration_command_invocations` fenced by exact `run_id`.
4. Verification receipts are loaded only through an exact durable execution reference. Accept rows where `evidence->>'run_id' = $1`, or where evidence contains an exact lease/invocation identifier owned by the requested run. Do not query all receipts for matching `work_ref` alone.
5. The store never imports/calls GitHub, Linear, `api`, or another provider client.
6. Returned source arrays default to `[]` rather than `undefined`.

Representative fake DB seam:

```js
const calls = [];
const db = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM orchestration_runs')) return { rows: [{ run_id: 'run-1', status: 'finished' }] };
    if (sql.includes('FROM work_leases')) return { rows: [] };
    if (sql.includes('work_lease_checkpoints')) return { rows: [] };
    if (sql.includes('work_lease_heartbeats')) return { rows: [] };
    if (sql.includes('orchestration_command_invocations') && !sql.includes('orchestration_invocation_resolutions')) return { rows: [] };
    if (sql.includes('orchestration_invocation_resolutions')) return { rows: [] };
    if (sql.includes('portfolio_verification_receipts')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  },
};
```

- [ ] **Step 2: Extend the Node wrapper and verify red**

Add:

```js
import { runExecutionEvidenceStoreTests } from '../lib/execution-evidence-store.test.js';

test('execution evidence source adapter', async () => {
  const result = await runExecutionEvidenceStoreTests();
  assert.equal(result.ok, true, JSON.stringify(result.results.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});
```

Run:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
```

Expected: FAIL because `lib/execution-evidence-store.js` does not exist.

- [ ] **Step 3: Implement the Postgres adapter**

Create `lib/execution-evidence-store.js` with no provider dependencies:

```js
import { db } from 'hatchable';

export function createPostgresExecutionEvidenceStore(dbBinding = db) {
  async function rows(sql, params = []) {
    const result = await dbBinding.query(sql, params);
    return result.rows || [];
  }
  async function row(sql, params = []) {
    const result = await rows(sql, params);
    return result[0] || null;
  }

  return {
    async loadRunEvidence(runId) {
      const run = await row('SELECT * FROM orchestration_runs WHERE run_id = $1', [runId]);
      if (!run) return null;

      const leases = await rows(`SELECT lease_id,work_ref,gate,run_id,status,created_at,expires_at,previous_state,previous_lane,claim_revision,active_revision,claim_receipt,settle_plan,settle_receipt,settled_at,reconciliation,updated_at FROM work_leases WHERE run_id=$1 ORDER BY created_at ASC, lease_id ASC`, [runId]);
      const checkpoints = await rows(`SELECT c.* FROM work_lease_checkpoints c JOIN work_leases l ON l.lease_id=c.lease_id WHERE l.run_id=$1 ORDER BY c.created_at ASC, c.checkpoint_id ASC`, [runId]);
      const heartbeats = await rows(`SELECT h.* FROM work_lease_heartbeats h JOIN work_leases l ON l.lease_id=h.lease_id WHERE l.run_id=$1 ORDER BY h.created_at ASC, h.heartbeat_id ASC`, [runId]);
      const invocations = await rows(`SELECT * FROM orchestration_command_invocations WHERE run_id=$1 ORDER BY sequence ASC, invocation_id ASC`, [runId]);
      const resolutions = await rows(`SELECT r.* FROM orchestration_invocation_resolutions r JOIN orchestration_command_invocations i ON i.invocation_id=r.invocation_id WHERE i.run_id=$1 ORDER BY r.created_at ASC, r.resolution_id ASC`, [runId]);

      const leaseIds = leases.map((lease) => String(lease.lease_id)).filter(Boolean);
      const invocationIds = invocations.map((invocation) => String(invocation.invocation_id)).filter(Boolean);
      const verifications = await rows(`SELECT * FROM portfolio_verification_receipts WHERE evidence->>'run_id'=$1 OR ($2::text[] <> '{}'::text[] AND evidence->>'lease_id'=ANY($2::text[])) OR ($3::text[] <> '{}'::text[] AND evidence->>'invocation_id'=ANY($3::text[])) ORDER BY satisfied_at ASC, predicate_key ASC`, [runId, leaseIds, invocationIds]);

      return { run, leases, checkpoints, heartbeats, invocations, resolutions, verifications };
    },
  };
}
```

If Postgres rejects the empty-array comparison syntax in repository CI/tests, use `cardinality($2::text[]) > 0` and `cardinality($3::text[]) > 0` instead. The semantic rule is fixed: no work-ref-only attribution.

- [ ] **Step 4: Run all focused tests**

Run:

```bash
node --test scripts/verify-execution-evidence-projector.test.mjs
```

Expected: PASS with bounded-evidence, projector, and store tests green.

- [ ] **Step 5: Add the focused test to repository verification**

In `.github/workflows/regression-suite-registry.yml`, add directly after the syntax-check step:

```yaml
      - name: Test execution evidence projector
        run: node --test scripts/verify-execution-evidence-projector.test.mjs
```

Do not add #150 to the canonical regression-suite registry yet. The approved design assigns evidence-integrity/canonical regression registration to #152.

- [ ] **Step 6: Run the full repository-static command set**

Run the same commands required by `.github/workflows/regression-suite-registry.yml`, at minimum:

```bash
node scripts/verify-regression-suite-registry.mjs
find api lib mcp pages -type f -name '*.js' -print0 | xargs -0 -n1 node --check
node --test scripts/verify-execution-evidence-projector.test.mjs
node --test scripts/verify-work-lease-config.test.mjs
node --test scripts/verify-project-horizon.test.mjs
node --test scripts/verify-project-transition-leases.test.mjs
node --test scripts/verify-mcp-admission-contract.test.mjs
node --test scripts/verify-repository-metadata-command.test.mjs
node --test scripts/verify-repository-register-command.test.mjs
node --test scripts/verify-milestone-command.test.mjs
node --test scripts/verify-overcenter-terminology.test.mjs
node --test scripts/exact-revision-v8-verification*.test.mjs
node --test scripts/verify-public-release.test.mjs
node --test scripts/verify-public-github-metadata.test.mjs
node --test scripts/verify-repository-registration-policy.test.mjs
```

Expected: all commands exit 0. If local execution is unavailable, the implementation PR's required `repository-static` check is the authoritative verification gate; do not claim completion before it reports success.

- [ ] **Step 7: Commit**

```bash
git add lib/execution-evidence-store.js lib/execution-evidence-store.test.js scripts/verify-execution-evidence-projector.test.mjs .github/workflows/regression-suite-registry.yml
git commit -m "feat: load exact-run execution evidence"
```

- [ ] **Step 8: Open/update the #150 implementation PR**

PR body must state:

- implements #150 only;
- based on the approved `execution-evidence-v1` design;
- no new persistence table;
- no API/MCP/ODCS surface;
- verification receipts require exact execution attribution, never work-ref coincidence;
- original command outcomes remain immutable while mutation certainty is derived from resolutions;
- required `repository-static` check is the completion gate.

## Plan self-review

- **Spec coverage:** #150's native model, deterministic projection, safe redaction, effect certainty, exact-run sourcing, explicit verification attribution, stable ordering, no new table, and focused tests are covered. Transport (#151), integrity semantics (#152), operator checkpoint (#153), and ODCS (#154) are intentionally excluded.
- **Placeholder scan:** no TBD/TODO/"implement later" steps remain.
- **Type consistency:** all tasks use the same source bundle keys and `projectExecutionEvidence(source)` interface; store output is directly consumable by the projector.
- **Authority check:** no task reads live provider authority or writes runtime/provider state.
- **Privacy check:** redaction is centralized and lease/token/request-body fields are excluded by construction.
