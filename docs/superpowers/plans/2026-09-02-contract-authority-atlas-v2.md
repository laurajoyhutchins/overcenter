# Contract Authority Atlas v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit lifecycle and cross-logical-contract relationship evidence to Contract Evidence and render it as a deterministic authority-flow atlas.

**Architecture:** Extend classification metadata rather than adding a second hand-authored graph. Resolve metadata into the existing logical-contract catalog, validate all targets after authorities are known, and derive incoming edges only from outgoing classified evidence.

**Tech Stack:** Node.js ESM, `node:test`, JSON classification metadata, deterministic Markdown generation.

**Spec:** `docs/superpowers/specs/2026-09-02-contract-authority-atlas-v2-design.md`

## Global Constraints

- Do not infer relationships not encoded by discoverers or classifications.
- Keep lifecycle separate from significance.
- Missing lifecycle remains unclassified.
- Preserve deterministic ordering and CI byte checks.
- TDD: observe RED before production changes.

---

### Task 1: Classification and resolution model

**Files:**
- Modify: `packages/contract-evidence/model.mjs`
- Modify: `packages/contract-evidence/resolver.mjs`
- Test: `scripts/contract-evidence/authority-atlas-v2.test.mjs`

**Interfaces:**
- Consumes: classification entries keyed by source identity.
- Produces: logical contracts with optional `lifecycle` and immutable `relationships` arrays.

- [ ] **Step 1: Write the failing tests** for valid/invalid lifecycle, valid/invalid relationship kinds, target resolution, duplicate normalization, and self-edge rejection.
- [ ] **Step 2: Run** `node --test scripts/contract-evidence/authority-atlas-v2.test.mjs` and verify failure is caused by unsupported metadata.
- [ ] **Step 3: Implement** exported lifecycle/relationship enums plus validation in `model.mjs`, then carry normalized metadata into `resolveLogicalContracts` and fail with `CONTRACT_RELATIONSHIP_TARGET_MISSING` for absent targets.
- [ ] **Step 4: Run** `node --test scripts/contract-evidence/authority-atlas-v2.test.mjs` and existing contract-evidence tests.
- [ ] **Step 5: Commit** the model/resolver change.

### Task 2: Flow-aware renderer

**Files:**
- Modify: `packages/contract-evidence/render-authority-atlas.mjs`
- Test: `scripts/contract-evidence/authority-atlas-v2.test.mjs`

**Interfaces:**
- Consumes: resolved logical contracts with lifecycle and outgoing relationships.
- Produces: deterministic Markdown with a global flow index plus incoming/outgoing relationship sections.

- [ ] **Step 1: Extend the failing renderer assertions** to require lifecycle, a sorted `source -> kind -> target` flow index, and reverse-derived incoming edges.
- [ ] **Step 2: Run** the focused test and verify the old renderer fails those assertions.
- [ ] **Step 3: Implement** deterministic flow indexing without synthesizing new relationships.
- [ ] **Step 4: Run** the focused and full contract-evidence test suites.
- [ ] **Step 5: Commit** the renderer change.

### Task 3: Prove the project.advance path

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Modify generated: `generated/contracts/catalog.json`
- Modify generated: `docs/generated/data-contracts.md`
- Modify generated: `docs/generated/data-contract-authority-atlas.md`

**Interfaces:**
- Consumes: Atlas v2 classification schema.
- Produces: first real authority-flow trace for `project.advance` and compact execution persistence.

- [ ] **Step 1: Add only the seven approved cross-contract edges and lifecycle `current` to their source/target authority classifications.**
- [ ] **Step 2: Run** the generator and inspect the `project.advance` flow for unsupported inferred arrows.
- [ ] **Step 3: Regenerate all committed contract artifacts.**
- [ ] **Step 4: Run** the complete repository verification matrix and exact freshness checks.
- [ ] **Step 5: Commit** classifications and generated artifacts.
