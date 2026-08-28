# Recovery Kernel Implementation Plan

**Goal:** Implement the architecture in `docs/architecture/recovery-kernel-and-self-healing.md` as independently reviewable slices while preserving existing authority, evidence, exact-revision, lease, and idempotency semantics.

## Global constraints

- GitHub remains source authority; Hatchable remains runtime authority; Overcenter owns orchestration and recovery evidence; Linear remains projection only.
- Do not create a second incident authority or generic logging framework.
- Do not persist capability material, credentials, raw prompts, arbitrary provider objects, or source blobs in recovery evidence.
- `unknown` is distinct from `satisfied` and `violated`.
- Never blindly retry an invocation with `may_have_mutated:true`.
- Automatic recovery cannot choose semantic dispositions or resolve authority conflicts.
- Recovery is bounded by the existing automatic-recovery budget.
- Command success is insufficient for `HEALED`; authoritative readback must prove convergence.
- Reuse `orchestration.diagnose`, `orchestration.resume_packet`, `orchestration.maintain`, command/domain receipts, branch roles, and production reconciliation primitives.
- Follow repository TDD and regression-registration conventions for each implementation slice.

## Task 1: Persist execution-time runtime provenance

**Primary files:**
- create a migration after the current highest migration number;
- create `lib/orchestration-runtime-provenance.js` and its tests;
- modify `lib/orchestration-journal.js`;
- register the focused suite in `lib/regression-suite-registry.js`.

**Required behavior:**
- capture bounded source/deployment/runtime-integrity provenance before semantic execution;
- use an explicit allowlist;
- derive contract revisions from stored run provenance where available;
- never reconstruct historical execution identity from current `dev` or current runtime state;
- expose explicit historical unknowns;
- exclude secrets and capability material.

**Verification:** focused provenance/journal tests, then canonical regressions.

## Task 2: Add read-only `orchestration.fault_packet`

Create a shared semantic service plus MCP and HTTP surfaces. The packet composes diagnosis, resume state, exact journal invocation and predecessor, lease/checkpoint state, relevant receipts, runtime provenance, and fresh authority observations.

Tests must prove:
- stable `fault_id` across observation times;
- unknown failures do not acquire invented root causes;
- runtime provenance is the captured execution provenance;
- read-only packet inspection does not recursively alter the inspected journal.

## Task 3: Add bounded `orchestration.recover`

Create a server-owned recovery-operation registry and a narrow recover loop. The caller supplies only `run_id`.

Initial tests and registry cases:
- stale lease -> `orchestration.maintain`;
- safe transport failure with `may_have_mutated:false` -> exact bounded retry;
- checkpoint-backed heartbeat exhaustion -> canonical requeue only when disposition is already determined;
- indeterminate external effect -> reconciliation only, never mutation replay;
- semantic decision required -> stop with required-decision evidence;
- repeated safe fault -> stop at configured recovery-attempt limit;
- successful operation without invariant/readback convergence -> not `HEALED`.

## Task 4: Add three-valued `overcenter.health`

Create a registry whose evaluators return `satisfied`, `violated`, or `unknown` plus fault domain, severity, evidence, and recovery metadata.

Start with existing coordination and scheduled-cycle queries:
- expired active slots;
- stuck claiming/settling leases;
- unresolved indeterminate effects;
- overdue active runs;
- scheduler firing and cycle-reconciliation recency.

Authority-read failure maps to `unknown`. Aggregate health cannot be healthy when a required invariant is unknown.

## Task 5: Add GitHub and production convergence invariants

Before editing, locate the actual current production materialization owner in `dev`; do not create a parallel service.

Evaluate:
- branch-role validity;
- development and production policy validity;
- verified candidate existence;
- production branch equality with verified candidate;
- runtime equality with production source;
- exact deployment regression verification.

Tests require exact-coordinate happy path, isolated drift, and authority-unavailable `unknown` behavior.

## Task 6: Add fault-domain quarantine

Add a small Overcenter-owned persistence model for active degraded/quarantined domains and a command-to-domain mapping.

Tests must prove:
- affected mutations fail before external effect with `FAULT_DOMAIN_QUARANTINED` and `may_have_mutated:false`;
- unrelated domains remain executable;
- read-only diagnosis/health/fault-packet and registered reconciliation remain available;
- callers cannot bypass quarantine;
- clearing requires fresh satisfied invariant evidence.

Put the guard at existing semantic effect boundaries rather than introducing a second dispatcher.

## Task 7: Add scheduled deterministic healing

Create a scheduled recovery handler separate from ordinary maintenance. It contains no AI call and never selects or edits portfolio work.

Each pass reads health, attempts only explicitly auto-recoverable violated invariants, rereads the invariant, records the result, and quarantines where policy requires. Add anti-thrash tests and verify the actual Hatchable scheduler registration after deployment.

## Task 8: Add end-to-end recovery acceptance scenarios

Cover at least:
- novel semantic-boundary defect with exact causal context and no invented automatic fix;
- stale lease self-heal with slot-release readback;
- bounded safe transport retry;
- indeterminate effect that never blind-retries;
- semantic-decision boundary;
- production drift;
- authority outage producing `unknown`;
- quarantine isolation;
- full canonical regression suite.

## Task 9: Live dogfood and lifecycle completion

After integration:

1. promote the exact integrated `dev` revision through normal production promotion/materialization;
2. prove immutable Hatchable deployment evidence binds runtime to that exact revision;
3. invoke `overcenter.health` and retain invariant evidence;
4. exercise a reproducible stale-coordination fixture and prove recovery by authoritative readback;
5. exercise a non-auto-recoverable fault and prove deterministic fault-packet output;
6. prove an indeterminate-effect fixture does not blind-retry;
7. prove scheduled deterministic recovery is registered and firing;
8. attach exact evidence coordinates to owning GitHub issues and Overcenter settlements;
9. close implementation work only when GitHub source, deployed runtime, and recovery acceptance evidence agree.

## Completion criteria

Do not call the recovery kernel implemented until provenance is captured at execution time, fault packets are bounded/read-only, recovery uses a server-owned registry, semantic decisions stop for reasoning, indeterminate effects reconcile before retry, health is three-valued, quarantine is fault-domain scoped, scheduled healing is bounded/deterministic, every healing claim has fresh readback, and canonical plus live dogfood verification pass.
