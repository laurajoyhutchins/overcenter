# TypeScript Semantic Kernel Implementation Plan

**Goal:** Prove TypeScript removes concrete invalid-state and contract-drift classes in Overcenter's command and project-graph semantic core without changing external runtime contracts.

**Architecture:** Author typed semantic source under `src/semantic/`. Hatchable currently does not transpile TypeScript syntax in synchronized runtime files, so only runtime-bearing modules are mechanically emitted to plain JavaScript under `lib/`, and CI rejects drift between TS source and emitted JS. Type-only semantic declarations have no runtime mirror. API/MCP shells remain JavaScript and runtime validation remains authoritative.

**Tech Stack:** Node.js 22, TypeScript 5.9, GitHub Actions, Hatchable V8 verification.

**Spec:** `docs/design/2026-08-28-typescript-semantic-kernel.md` and GitHub issue #236.

## Global Constraints

- Do not create a second canonical-command registry.
- Do not hand-maintain generated runtime JavaScript; generation drift must fail CI.
- Do not generate runtime files for type-only modules.
- Do not change runtime validation semantics in this slice.
- Keep routed `api/` and `mcp/` entrypoints JavaScript.
- Require red-green evidence for each semantic type boundary.

### Task 1: Establish the type-checking proof harness

**Files:** `tsconfig.semantic.json`, `type-tests/semantic-kernel.test.ts`, `.github/workflows/semantic-kernel-types.yml`

- [x] Write the compile-only contract test referencing command, identity, and project-graph semantic types.
- [x] Confirm RED before semantic modules exist.
- [x] Preserve the failing GitHub Actions run as evidence.

### Task 2: Port command admission and semantic identities

**Files:** `src/semantic/semantic-identities.ts`, `src/semantic/canonical-commands.ts`, `src/semantic/command-contracts.ts`, generated `lib/canonical-commands.js`, generated `lib/command-contracts.js`, `tsconfig.semantic.runtime.json`

- [x] Add branded `RunId`, `LeaseId`, `WorkRef`, `GitSha`, and `IdempotencyKey`.
- [x] Derive `CanonicalCommand` from one typed literal registry.
- [x] Remove the duplicate command list from `lib/command-response.js`.
- [x] Remove the duplicate canonical success-envelope list from `lib/command-response.test.js`.
- [x] Confirm compile-time rejection of identity mixups and unknown command literals.
- [x] Confirm generated JS exactly matches TypeScript emission.
- [x] Confirm exact-revision Hatchable verification passes with no TypeScript syntax in the synchronized runtime tree.

### Task 3: Port project-graph structural types

**Files:** `src/semantic/project-graph-types.ts`, `src/semantic/project-graph-contracts.ts`, generated `lib/project-graph-contracts.js`, `lib/project-graph.js`

- [x] Add discriminated executor and phase-input unions.
- [x] Prove operator/agent field mixing and `from`+`literal` ambiguity are compile errors.
- [x] Route existing project-graph executor and phase-binding normalization through the typed generated boundary without weakening runtime validation.
- [x] Re-run type, repository, and exact Hatchable V8 verification; require GREEN.

### Task 4: Evaluate the proof slice

- [x] Record the invalid states the compiler now prevents.
- [x] Record the Hatchable runtime constraint and mechanically generated JS boundary.
- [x] Confirm the approach removes duplication rather than creating another registry.
- [x] Stop this proof slice before expanding into a third subsystem.
- [x] Select execution authority, leases, and runs as the next typed semantic island.
