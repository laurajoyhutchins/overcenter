# Project Graph Frontier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic Busbar project-graph kernel that validates prerequisite graphs and derives the ready execution frontier above the existing five-stage lifecycle.

**Architecture:** `lib/project-graph.js` is a pure evaluator. It validates graph/node/executor structure, composes `resolveWorkLifecycle` for each node, rejects invalid prerequisite topology, derives per-node execution state, and returns a deterministic frontier. It does not persist or execute nodes.

**Tech Stack:** JavaScript ES modules, existing Busbar lifecycle kernel, existing custom regression harness.

**Spec:** `docs/superpowers/specs/2026-08-23-project-graph-runtime-design.md`

## Global Constraints

- GitHub repository state remains authoritative.
- Reuse `lib/work-lifecycle.js`; do not duplicate lifecycle resolution.
- Project prerequisite edges must be acyclic and fail closed when invalid.
- Agent executors must name a skill.
- Do not add persistence, a public API, Linear mutation, a scheduler, or dispatch in this slice.
- Register focused tests in the canonical regression-suite registry.

---

### Task 1: Project graph evaluator

**Files:**
- Create: `lib/project-graph.test.js`
- Create: `lib/project-graph.js`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- Consumes: `resolveWorkLifecycle(input)` from `lib/work-lifecycle.js`.
- Produces: `evaluateProjectGraph(input)` returning `{ complete, frontier, nodes }`.
- Produces node states: `DONE`, `OFF_NOMINAL`, `WAITING`, `READY`.

- [ ] **Step 1: Write the failing focused test suite**

Create `lib/project-graph.test.js` with direct assertions covering completed dependency enablement, exact unmet dependencies, off-nominal exclusion, deterministic priority/ID ordering, lifecycle resolution preservation, valid operator/agent executors, required agent skills, missing dependencies, duplicate IDs, self-dependencies, cycles, invalid priorities, invalid executors, and whole-graph completion.

The test module exports `runProjectGraphTests()` in the same `{ ok, passed, failed, tests }` shape as `runWorkLifecycleTests()`.

- [ ] **Step 2: Run the focused test and verify RED**

Run in an isolated Node 22-compatible ES-module harness:

```bash
node --input-type=module -e "import('./lib/project-graph.test.js').then(async m => { const r = await m.runProjectGraphTests(); console.log(JSON.stringify(r,null,2)); if (r.ok) process.exit(0); process.exit(1); })"
```

Expected before implementation: module load fails because `lib/project-graph.js` does not exist.

- [ ] **Step 3: Implement the minimal pure evaluator**

Create `lib/project-graph.js` with:

```js
import { resolveWorkLifecycle } from './work-lifecycle.js';

export const PROJECT_NODE_STATES = Object.freeze(['DONE','OFF_NOMINAL','WAITING','READY']);
export function evaluateProjectGraph(input = {}) { /* validated deterministic evaluation */ }
```

Validation requirements:

- input must contain `nodes` as an array;
- IDs are non-empty unique strings;
- priority defaults to `0` and must be an integer;
- `requires` defaults to `[]`, contains unique non-empty node IDs, and cannot contain self;
- every dependency must resolve to a graph node;
- dependency topology must be acyclic;
- operator executor requires non-empty `command` and no unsupported kind;
- agent executor requires non-empty `role` and non-empty `skill`;
- lifecycle is delegated unchanged to `resolveWorkLifecycle`.

Evaluation requirements:

- `DONE` when lifecycle is complete;
- `OFF_NOMINAL` when lifecycle condition is not `NOMINAL`;
- `WAITING` when any prerequisite is not `DONE`;
- `READY` otherwise;
- `unmet_requirements` is a sorted array of exact prerequisite IDs not `DONE`;
- `frontier` contains `READY` node evaluations sorted by descending priority then ascending ID;
- graph `complete` is true only when every node is `DONE`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same isolated command as Step 2. Expected: all focused cases pass.

- [ ] **Step 5: Register the suite**

Modify `lib/regression-suite-registry.js` to import `runProjectGraphTests` and add:

```js
suite('orchestration', 'project_graph', 'lib/project-graph.test.js', runProjectGraphTests),
```

immediately after the existing `work_lifecycle` suite.

- [ ] **Step 6: Run focused tests again after registry integration**

Run the focused project-graph test command. If a full canonical regression runner is available in the current environment, run it too; otherwise record that hosted Actions verification remains external/unavailable rather than claiming full-suite proof.

- [ ] **Step 7: Commit the production slice**

Commit the implementation, tests, and registry update to `feat/project-graph-frontier` with a focused message such as:

```bash
git commit -m "Add deterministic project graph frontier"
```

### Task 2: Reviewable integration boundary

**Files:**
- No additional production files unless review exposes a defect.

**Interfaces:**
- Consumes: exact Task 1 branch head.
- Produces: one draft pull request against `main` documenting the kernel boundary and verification evidence.

- [ ] **Step 1: Compare against current `main`**

Confirm the branch still descends from the expected authoritative main revision or explicitly reconcile a moved base before opening the pull request.

- [ ] **Step 2: Inspect overlap with open Busbar pull requests**

Verify no active PR implements the same project-graph/frontier primitive. Treat incidental regression-registry overlap as merge choreography, not a reason to duplicate functionality.

- [ ] **Step 3: Open a draft pull request**

Describe the deterministic graph/frontier kernel, its deliberate non-goals, exact focused verification, and any unavailable hosted verification. Keep the PR draft until canonical verification can actually run.
