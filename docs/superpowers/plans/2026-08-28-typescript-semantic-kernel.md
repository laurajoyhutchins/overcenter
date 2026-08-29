# TypeScript Semantic Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove TypeScript removes concrete invalid-state and contract-drift classes in Overcenter's command and project-graph semantic core without changing external runtime contracts.

**Architecture:** Keep JavaScript API/MCP shells stable. Introduce typed shared semantic modules under `lib/`, make the canonical command registry single-source, and use compile-only contract tests to prove branded identities and discriminated unions. Runtime validation remains in the existing JavaScript boundaries.

**Tech Stack:** Node.js 22, TypeScript 5.9, GitHub Actions, Hatchable V8 verification.

**Spec:** `docs/superpowers/specs/2026-08-28-typescript-semantic-kernel-design.md` and GitHub issue #236.

## Global Constraints

- Do not create a second canonical-command registry.
- Do not add a build artifact or checked-in generated JavaScript mirror.
- Do not change runtime validation semantics in this slice.
- Keep routed `api/` and `mcp/` entrypoints JavaScript.
- Require red-green evidence for each semantic type boundary.

---

### Task 1: Establish the type-checking proof harness

**Files:**
- Create: `tsconfig.semantic.json`
- Create: `type-tests/semantic-kernel.test.ts`
- Create: `.github/workflows/semantic-kernel-types.yml`

**Interfaces:**
- Consumes: the intended semantic type module names.
- Produces: a strict compile-only check that fails until those modules exist and later rejects identity mixups and invalid union states.

- [ ] Write the compile-only contract test referencing `command-contracts`, `semantic-identities`, and `project-graph-types`.
- [ ] Run the GitHub Actions type job and confirm RED because the semantic modules do not yet exist.
- [ ] Preserve the failing run as evidence before implementing production semantic types.

### Task 2: Port canonical commands and semantic identities

**Files:**
- Create: `lib/semantic-identities.ts`
- Create: `lib/command-contracts.ts`
- Create: `lib/command-contracts.js`
- Modify: `lib/command-response.js`

**Interfaces:**
- Produces: `CanonicalCommand`, `CANONICAL_COMMANDS`, branded `RunId`, `LeaseId`, `WorkRef`, `GitSha`, and `IdempotencyKey`.
- `command-response.js` consumes the canonical command array from the typed module through the thin JS compatibility shell.

- [ ] Add the minimal typed modules that satisfy the compile contract.
- [ ] Remove the duplicate command array from `command-response.js` and import the single typed source.
- [ ] Re-run the type job and existing repository verification; require GREEN.
- [ ] Run exact-revision Hatchable verification to prove the TypeScript-backed shared module loads in the deployed V8 path.

### Task 3: Port project-graph structural types

**Files:**
- Create: `lib/project-graph-types.ts`
- Modify: `lib/project-graph.js` only where type annotations can be added without changing runtime validation.

**Interfaces:**
- Produces: `Executor`, `PhaseInputSource`, `ProjectNodeState`, phase names, and JSON-compatible literal types.
- Existing project-graph runtime validators remain the authority for untrusted graph data.

- [ ] Add discriminated executor and phase-input unions.
- [ ] Prove operator/agent field mixing and `from`+`literal` ambiguity are compile errors.
- [ ] Add only useful JS type annotations; do not suppress compiler friction with broad `any` casts.
- [ ] Re-run type and runtime verification; require GREEN.

### Task 4: Evaluate the proof slice

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-typescript-semantic-kernel-design.md` only if findings refine the boundary.
- Update: GitHub issue #236 with evidence.

**Interfaces:**
- Produces: a go/no-go decision for the next typed semantic island.

- [ ] Record which invalid states the compiler now prevents.
- [ ] Record any Hatchable/runtime constraints discovered.
- [ ] Stop rather than expanding the migration if typing mostly produces casts, optional-property bags, or duplicate registries.