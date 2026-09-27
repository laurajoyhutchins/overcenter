# Settlement Observation Contract Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make contracts/observation-evidence/schema.json the only structural authority for SettlementObservation and generate the TypeScript runtime projection from it.

**Architecture:** A small pure TypeScript renderer turns the JSON Schema definition into the checked-in runtime projection. The CLI reads the authoritative contract, writes or checks the generated module, and never writes back to the contract. Existing runtime validation and semantic checks remain unchanged.

**Tech Stack:** TypeScript 7, Node.js 22 built-in test runner, JSON Schema, existing Overcenter structural validator.

**Spec:** docs/superpowers/specs/2026-09-27-research-lifecycle-contract-authority-design.md

**Plan base:** `main` at `6b8dceb65fc231279ec1f0bcf78beefb65ccf75c` (442 tracked files; 26 workflows). Reconfirm the base before execution.

## Global Constraints

- Preserve existing wire/data identity and settlement semantics.
- Preserve fail-closed structural validation, provider-owned evidence annotations, and the absence-evidence reference.
- Keep zero npm runtime dependencies; remove TypeBox only if no other repository use exists.
- The contract JSON is authoritative; generated TypeScript is a projection and must be reproducible.
- Do not change unrelated provider or broker behavior.

## Review Focus

- Missing or malformed $defs.SettlementObservation must fail generation with a stable error; test in Task 1.
- A change to verifier enums or required fields must change the runtime projection; test in Task 1.
- Provider-owned evidence and the AbsenceEvidenceEnvelope reference must survive generation; test in Task 1.
- Stale generated TypeScript must fail the check operation; test in Task 1 and Task 2.
- Runtime unknown-field and unsupported-verifier inputs must still fail closed; retain these assertions in Task 3.

---

## File Structure

- scripts/settlement-observation-generator.ts — pure rendering and projection comparison functions.
- scripts/generate-settlement-observation.ts — CLI reading the contract JSON and checking or writing only generated TypeScript.
- src/generated/settlement-observation-schema.ts — generated runtime projection.
- test/settlement-observation-generation.test.ts — generator behavior and stale-output checks.
- test/settlement-observation-contract.test.ts — production runtime admission and contract conformance.
- contracts/README.md, src/README.md, package.json — source-of-truth documentation and commands.

### Task 1: Specify and test the pure schema projection

**Files:**
- Create: test/settlement-observation-generation.test.ts
- Create: scripts/settlement-observation-generator.ts

**Interfaces:**
- Produces: renderSettlementObservationModule(definition: Readonly<Record<string, unknown>>): string
- Produces: settlementObservationProjectionIsCurrent(definition: Readonly<Record<string, unknown>>, generated: string): boolean

- [ ] Add tests named “renders SettlementObservation from the supplied contract definition”, “preserves provider ownership and absence evidence references”, “rejects a missing or non-object definition”, and “detects a stale generated module”.
- [ ] Run: node --experimental-strip-types --test test/settlement-observation-generation.test.ts
  Expected: FAIL because the projection functions do not exist.
- [ ] Implement the two exported pure functions. Render the same exported const module shape used by the current generated file; reject definitions without type=object, required fields, or properties.
- [ ] Run the test again; expect all four cases to pass.
- [ ] Commit the renderer and tests.

### Task 2: Make the CLI consume JSON and update the projection

**Files:**
- Modify: scripts/generate-settlement-observation.ts
- Modify: src/generated/settlement-observation-schema.ts
- Modify: package.json

**Interfaces:**
- Consumes: renderSettlementObservationModule and settlementObservationProjectionIsCurrent from Task 1.
- Produces: generate:settlement-observation and check:settlement-observation retain their current CLI names and use the contract JSON as their sole input.

- [ ] Replace the TypeBox dynamic import with reading contracts/observation-evidence/schema.json and selecting $defs.SettlementObservation.
- [ ] Keep --check and --write modes. --check compares the checked-in generated module with the pure renderer output; --write updates only src/generated/settlement-observation-schema.ts.
- [ ] Run: npm run check:settlement-observation
  Expected: PASS on synchronized files; after changing a byte in the generated file, expect a nonzero result; restore the file and expect PASS.
- [ ] Run: node --experimental-strip-types --test test/settlement-observation-generation.test.ts
  Expected: PASS.
- [ ] Commit the CLI and generated projection.

### Task 3: Remove the TypeBox authority path

**Files:**
- Rename: test/typebox-production-contract.test.ts to test/settlement-observation-contract.test.ts
- Delete: test/typebox-production-projection.test.ts
- Delete: contracts/observation-evidence/settlement-observation.typebox.ts
- Modify: package.json, contracts/README.md, src/README.md
- Modify: .overcenter/tcb-obligations.json only if its source inventory still names the deleted file

- [ ] Search the full repository for TypeBox imports and uses; keep the dependency if any supported consumer remains, otherwise delete the dev dependency and TypeBox-specific package scripts.
- [ ] Update the renamed production test to assert that the generated runtime schema equals the JSON contract definition and that existing hostile envelope inputs remain rejected.
- [ ] Remove source-only TypeBox mutation fixtures; equivalent schema-driven mutation and stale-output tests must live in Task 1.
- [ ] Document the one-way flow contract JSON -> generated TypeScript -> production consumers.
- [ ] Run: node --experimental-strip-types --test test/settlement-observation-contract.test.ts test/data-contracts.test.ts
  Expected: PASS.
- [ ] Run: npm run typecheck && npm run lint && npm run check:settlement-observation
  Expected: PASS.
- [ ] Regenerate the TCB report from the exact resulting source revision and update only stale evidence or removed paths.
- [ ] Commit tests, docs, dependency, and TCB inventory changes.

### Task 4: Verify the complete contract slice

- [ ] Run: npm test
  Expected: all deterministic unit tests pass.
- [ ] Run: npm run proof:production-boundary
  Expected: PASS for the current supported production boundary.
- [ ] Confirm git diff contains no change to runtime settlement semantics, verifier identity, or provider behavior.

