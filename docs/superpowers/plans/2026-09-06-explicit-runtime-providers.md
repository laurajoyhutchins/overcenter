# Explicit Runtime Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ambient Hatchable/provider resolution from Overcenter's semantic execution cone and make runtime capabilities explicit at composition roots.

**Architecture:** Keep semantic command code provider-neutral. A small provider contract receives DB, secrets/config, GitHub App auth/client, storage, and compatibility host services explicitly; Hatchable and Node/GCP composition roots construct those capabilities. Provider SDK imports are mechanically fenced to explicit adapter/root modules, and missing capabilities fail closed rather than resolving from context, globals, dynamic imports, or hidden defaults.

**Tech Stack:** Node.js 22, node:test, JavaScript runtime adapters, TypeScript semantic kernel, PostgreSQL, GitHub App auth.

**Spec:** Authoritative Overcenter transition `make-runtime-providers-explicit-at-composition-root` at graph authority `e25c76c2b101443d885df9be3c8eb65c400cbebe`.

## Global Constraints

- Preserve GitHub exact-revision authority, Overcenter lease/settlement authority, mutation certainty, receipts, and recovery semantics.
- Keep current Hatchable production behavior working through an explicit adapter.
- Do not introduce a generic CloudProvider abstraction.
- Do not use process globals, ctx-or-ambient fallbacks, dynamic provider imports, or hidden defaults below the composition root.
- Canonical node:test and exact-revision verification must pass on the final head.

---

### Task 1: Mechanically fence the provider boundary

**Files:**
- Create: `scripts/verify-runtime-provider-composition.test.mjs`
- Modify: `scripts/test.mjs`

**Interfaces:**
- Consumes: repository source tree.
- Produces: a transitive import-graph invariant over semantic/MCP/worker entrypoints.

- [ ] Write the failing architecture test that walks local static imports from semantic execution roots and rejects provider SDK imports outside explicit adapters.
- [ ] Run canonical tests and record the expected RED evidence from current ambient Hatchable imports.
- [ ] Keep the guard in the maintained node:test path.

### Task 2: Add the explicit runtime capability contract

**Files:**
- Create: `lib/semantic-runtime.js`
- Create: `lib/hatchable-runtime-providers.js`

**Interfaces:**
- Consumes: explicit `db`, `secrets`, `githubAuth`, `storage`, and optional compatibility capabilities.
- Produces: a frozen runtime object consumed by semantic command composition.

- [ ] Add RED coverage for provider substitution and incomplete composition.
- [ ] Implement a provider-neutral capability validator with typed `RUNTIME_PROVIDER_REQUIRED` failures.
- [ ] Implement the Hatchable adapter that maps SDK capabilities into the contract.
- [ ] Verify the tests turn GREEN without adding ambient fallback paths.

### Task 3: Invert worker and MCP composition

**Files:**
- Modify: `lib/worker-transport.js`
- Modify: `api/worker-command.js`
- Modify: relevant `mcp/*.js` semantic entrypoints.
- Modify: narrowly required semantic/runtime modules reached by the guard.

**Interfaces:**
- Consumes: explicit runtime capability object.
- Produces: semantic commands whose dependencies are derived only from that object.

- [ ] Remove `hatchableDb` and other SDK fallbacks from worker transport.
- [ ] Make worker/MCP entrypoints obtain Hatchable capabilities from the explicit adapter rather than importing the SDK directly.
- [ ] Push explicit DB/store/service arguments through semantic constructors; missing required dependencies fail closed.
- [ ] Keep provider-specific glue only in explicit adapter/composition modules.
- [ ] Run focused and canonical tests after each coherent slice.

### Task 4: Make GitHub auth and storage explicit

**Files:**
- Modify: `lib/github-app-auth.js` or split a provider-neutral core plus Hatchable adapter.
- Modify: GitHub mutation/content-storage callers reached from the semantic command cone.

**Interfaces:**
- Consumes: injected secret/config provider and storage capability.
- Produces: GitHub App client/token operations and object transport with no Hatchable config/storage import in provider-neutral code.

- [ ] Add RED tests proving substituted secret/auth and storage providers are used.
- [ ] Remove ambient Hatchable config/storage reads from provider-neutral paths.
- [ ] Preserve token scope, revocation, mutation fencing, and transport uncertainty semantics.
- [ ] Verify current Hatchable adapter behavior remains functional.

### Task 5: Wire portable composition and verify exact head

**Files:**
- Modify: `scripts/cloud-run.mjs` / `scripts/cloud-run-host.mjs` only as required to construct equivalent explicit providers.
- Modify: documentation if the runtime boundary changes materially.

**Interfaces:**
- Consumes: Node/Postgres/config environment and provider-neutral capabilities.
- Produces: portable composition that can enter semantic code without Hatchable SDK knowledge.

- [ ] Prove provider substitution with ordinary Node fakes/Postgres adapter boundaries.
- [ ] Run `npm test`, build/typecheck, canonical verification, and exact-revision CI on the final Git SHA.
- [ ] Inspect the final import graph and diff for provider leakage or weakened authority/recovery behavior.
- [ ] Settle only with exact final revision and verification evidence.