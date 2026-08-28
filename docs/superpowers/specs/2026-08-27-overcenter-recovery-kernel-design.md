# Overcenter Recovery Kernel and Self-Healing Architecture

**Status:** Approved design  
**Date:** 2026-08-27  
**Authority:** GitHub issue #193  
**Scope:** Recovery, diagnosis, health, and bounded automated healing for Overcenter itself

## Summary

Overcenter already preserves much of the evidence needed to recover safely from faults: correlated command invocations, bounded request/result projections, idempotency identities, mutation-certainty flags, work leases, durable checkpoints, run receipts, typed failure classification, resume packets, deterministic maintenance, and domain-specific reconciliation receipts.

The remaining problem is compositional. Known coordination failures are often mechanically recoverable, but a fresh agent encountering a novel fault still has to reconstruct the causal chain across multiple surfaces. The system is recoverable, but debugging still consumes too much agent context and judgment.

This design adds a thin **recovery kernel** over existing primitives. It does not create a second incident authority and it does not replace `orchestration.diagnose`, `orchestration.resume_packet`, `orchestration.maintain`, the command journal, or domain reconcilers.

The recovery kernel has four responsibilities:

1. preserve exact runtime/software provenance with each command invocation;
2. assemble deterministic fault packets from existing evidence;
3. execute only pre-authorized deterministic recovery operations within a bounded budget;
4. evaluate explicit health invariants and quarantine only the affected fault domain when automated recovery cannot safely converge.

The intended operator and agent experience is:

```text
normal execution
      |
      v
    fault
      |
      v
orchestration.recover
      |
      +--> known + safe --> recover --> authoritative readback --> healed
      |
      +--> ambiguous/new --> fault packet --> narrow quarantine --> reasoning
```

A fresh agent should not need to know which database table contains a lease receipt, which retry identity was used, which Hatchable deployment executed the command, or which authority must be reread. Overcenter should package those facts and exhaust deterministic recovery before asking an agent to reason.

## Goals

- Make recovery from known faults mechanical and bounded.
- Give novel faults enough causal context for a fresh agent to investigate without reconstructing the system from scratch.
- Preserve evidence before claims: every `healed` result must be proven by fresh authoritative readback.
- Keep `unknown` distinct from both healthy and failed.
- Preserve exact mutation certainty. An indeterminate external effect must never be blindly retried.
- Capture the runtime/source revision that executed a command at execution time, rather than reconstructing it from current state later.
- Isolate faults by domain so a narrow failure does not disable unrelated work.
- Reuse existing diagnosis, resume, maintenance, receipts, branch roles, production promotion/materialization, and scheduled reconciliation machinery.
- Keep deterministic software responsible for repeated recovery choreography. Use reasoning only where facts do not determine a safe action.

## Non-goals

- A generic incident-management platform.
- A second log store containing copies of GitHub, Linear, or Hatchable state.
- Automatic semantic decisions such as choosing `completed` versus `requeue` versus `blocked`.
- Automatic rollback of source or external authority.
- Unlimited retries.
- AI-generated root-cause claims inside the recovery kernel.
- Treating current repository source as evidence of what code executed in a historical fault.
- Hiding unresolved authority conflicts behind a green health status.

## Authority boundaries

The recovery kernel does not change Overcenter's existing authority model.

| Concern | Authority |
| --- | --- |
| Repository contents, refs, commits, pull requests, releases | GitHub |
| Orchestration runs, leases, journals, checkpoints, recovery receipts | Overcenter |
| Runtime/deployment state | Hatchable |
| Executable work projection | Linear, while that projection remains configured |
| Runtime source identity | Exact GitHub revision bound to verified Hatchable deployment evidence |
| Recovery decisions | Deterministic Overcenter policy when facts fully determine a safe action; reasoning/operator otherwise |

Derived recovery data is evidence, not a competing authority.

## Existing substrate

The design is intentionally additive.

### `orchestration.diagnose`

`orchestration.diagnose` already combines durable run state, recent failures, lease/checkpoint state, current authoritative work state, repeated recovery count, typed failure classification, recovery operation, worker state, and escalation boundary.

It remains the canonical **failure classifier**.

### `orchestration.resume_packet`

`orchestration.resume_packet` already reconstructs the smallest mechanically safe continuation state and distinguishes continuations including:

- `recover_active_lease`
- `retry_same_request`
- `reconcile_authority`
- `recompute_frontier`
- `owner_action_required`
- `terminal_or_quiescent`

It remains the canonical **continuation reconstruction** surface.

### `orchestration.maintain`

`orchestration.maintain` already performs bounded deterministic cleanup of expired/stuck coordination state and resolvable journal residue without selecting or semantically editing work.

It remains a narrow **coordination janitor**, not a general healer.

### Command journal and receipts

The command journal already records correlated command identity, bounded request/result projections, outcome, error code, retryability, rejection, idempotency identity, target, and `may_have_mutated`. Domain receipts preserve stronger mutation-specific evidence where required.

They remain the canonical evidence substrate.

## Architecture

```text
                 authoritative systems
             GitHub / Hatchable / Linear
                       ^       |
                       | reads |
                       |       v
+------------------------------------------------------+
|                  Recovery kernel                     |
|                                                      |
|  runtime provenance                                  |
|         |                                            |
|         v                                            |
|  fault packet <--- diagnose + resume + journal       |
|         |                 + receipts + readback      |
|         v                                            |
|  recover executor ---> approved recovery registry    |
|         |                       |                    |
|         v                       v                    |
|  fresh diagnosis/readback     domain reconcilers     |
|         |                                            |
|         v                                            |
|  health invariants ---> quarantine / healed          |
+------------------------------------------------------+
             ^                         |
             |                         v
         agents/operators        scheduled healing
```

The layer is intentionally asymmetric:

- evidence may flow into the kernel from many authoritative sources;
- the kernel may mutate only through existing semantic/domain operations;
- a fault packet itself is read-only;
- a recovery executor cannot invent a semantic decision.

## 1. Runtime provenance on command invocations

### Problem

A fault packet must identify the software that actually executed the faulting command. Looking at current `dev`, current `main`, or the current Hatchable deployment later is insufficient because those coordinates can move after the fault.

### Required provenance

Every journaled command invocation must capture a bounded immutable projection such as:

```json
{
  "source_commit": "40-char Git SHA or null",
  "production_version": "immutable Hatchable deployment version or null",
  "runtime_integrity": "verified | unverified | indeterminate",
  "worker_transport_revision": "worker-transport-v2",
  "contract_revisions": {
    "project_instructions": "revision or null",
    "fast_forward_skill": "revision or null",
    "execution_ownership_skill": "revision or null"
  }
}
```

The exact field names may follow existing runtime-source integrity terminology, but the semantics are fixed:

- provenance is captured when the invocation begins;
- historical invocation provenance is never rewritten to current values;
- unknown provenance is represented explicitly as `null`/`unknown`;
- secrets, lease capability material, raw prompts, source blobs, and arbitrary provider objects are excluded;
- the projection is bounded and deterministic.

### Storage

Add runtime provenance to `orchestration_command_invocations` rather than creating a parallel fault log.

Historical rows remain valid and read as `historical_unknown` when the new field is absent.

### Relationship to runtime-source integrity

Runtime provenance does not itself prove that mutable Hatchable workspace state is safe. It records the integrity state observed by the executing boundary. Where runtime-source integrity is not proven, effecting semantic commands should continue to fail closed under the runtime-source integrity work.

## 2. Deterministic fault packets

### Command

```text
orchestration.fault_packet({
  run_id,
  invocation_id?   // optional exact fault coordinate
})
```

This command is read-only.

### Purpose

A fault packet is the smallest bounded causal object a fresh agent needs to troubleshoot a fault.

It is assembled from current durable evidence. It does not contain an AI-generated diagnosis.

### Inputs

- `run_id` is required.
- `invocation_id` is optional. If omitted, use the currently active/latest relevant failure selected using the same evidence ordering used by diagnosis.

### Output shape

```json
{
  "ok": true,
  "schema": "orchestration-fault-packet-v1",
  "fault_id": "sha256 of canonical packet identity",
  "run_id": "...",
  "observed_at": "...",

  "classification": {
    "failure_state": "STALE_LEASE",
    "error_code": "LEASE_EXPIRED",
    "may_have_mutated": false,
    "automatic_recovery_allowed": true,
    "escalation_required": false
  },

  "software": {
    "source_commit": "...",
    "production_version": "...",
    "runtime_integrity": "verified",
    "worker_transport_revision": "..."
  },

  "causal_chain": {
    "last_successful_command": {},
    "faulting_command": {},
    "recovery_failure_count": 0
  },

  "execution": {
    "run": {},
    "active_lease": null,
    "latest_lease": {},
    "checkpoint": {}
  },

  "authority": {
    "observations": []
  },

  "recovery": {
    "operation": {},
    "safe_to_execute": true,
    "requires_reasoning": false,
    "required_decisions": []
  },

  "evidence": []
}
```

### Assembly rules

The fault packet service composes, rather than duplicates:

1. `orchestration.diagnose`;
2. `orchestration.resume_packet`;
3. the exact journal invocation and preceding success;
4. latest lease/checkpoint state;
5. command/domain receipts keyed by invocation/idempotency identity when relevant;
6. runtime provenance captured on the invocation;
7. fresh authoritative observations required by the failure class.

The packet must never read a current source coordinate and present it as historical execution provenance.

### Identity

`fault_id` is derived from a canonical bounded identity including at least:

- run ID;
- faulting invocation ID;
- faulting invocation result hash/outcome;
- captured runtime provenance identity.

Repeated inspection of the same durable fault returns the same fault identity even when `observed_at` changes.

No persistent `faults` table is required initially.

## 3. Bounded recovery executor

### Command

```text
orchestration.recover({ run_id })
```

The caller expresses only recovery intent. It does not provide retry identities, lease tokens, observed branch heads, or a handwritten recovery recipe.

### Core loop

```text
diagnose
   |
   v
known deterministic recovery?
   | no
   +------> fault_packet --> stop
   |
  yes
   v
execute registered semantic recovery
   |
   v
fresh diagnosis + authoritative readback
   |
   +--> invariant restored --> HEALED
   |
   +--> still same fault and budget remains --> repeat
   |
   +--> changed/ambiguous/exhausted --> fault_packet --> stop
```

### Recovery registry

The executor uses an explicit server-owned registry mapping typed recovery classes to narrow operations.

Initial safe cases should reuse current classifier semantics:

| Failure | Deterministic recovery |
| --- | --- |
| stale/orphaned/expired lease | `orchestration.maintain` |
| transport unavailable with `may_have_mutated:false` | exact bounded retry of original semantic request |
| claim authority revision changed | re-observe authority and retry canonical `work.claim` when the classifier proves this is safe |
| heartbeat budget exhausted with durable checkpoint and lease reference | canonical `work.settle` requeue using `resume_progress` |
| unresolved effect with known domain reconciler | reconcile authoritative effect; do not replay mutation first |

### Hard stop cases

Recovery must stop and emit a fault packet when:

- `may_have_mutated:true` and the authoritative effect is not reconciled;
- the operation requires a semantic decision;
- authority reads conflict;
- required evidence is absent;
- the fault class is unknown;
- recovery attempts reach the configured maximum;
- the failure changes into a class that is not registered for automatic recovery;
- runtime source integrity is not verified for an effecting operation.

### Semantic decisions are never guessed

Examples:

- An active lease preventing run finish may require a settlement disposition. The recovery kernel may identify the required field, but cannot choose `completed`, `requeue`, or `blocked`.
- An authority conflict may identify both observed states, but cannot decide which authority should be edited.
- A policy rejection is not turned into a policy override.

### Recovery budget

The existing bounded automatic recovery policy remains authoritative. The initial maximum is three attempts for a repeated recoverable class.

Recovery attempts are correlated in the command journal and visible in the final fault packet.

### Proof of healing

A recovery operation succeeding is not enough.

`HEALED` requires:

1. fresh diagnosis no longer reports the original active failure;
2. all directly affected health invariants evaluate `satisfied`;
3. required external authority is reread at a post-recovery revision;
4. no unresolved journal effect remains for the recovery operation.

## 4. Explicit health invariants

### Command

```text
overcenter.health({
  scope?  // optional bounded repository/domain scope
})
```

This is read-only.

The existing `orchestration.status` remains useful operational telemetry. `overcenter.health` adds semantic invariant evaluation rather than replacing the status surface.

### Invariant result contract

Every health evaluator returns the same bounded shape:

```json
{
  "key": "coordination.no_stale_leases",
  "status": "satisfied | violated | unknown",
  "fault_domain": "work-acquisition",
  "severity": "info | degraded | blocked",
  "observed_at": "...",
  "evidence": [],
  "automatic_recovery_allowed": true,
  "recovery_operation": {}
}
```

### Three-valued state is mandatory

`unknown` is not a softer `violated`, and it is never treated as `satisfied`.

Examples:

- GitHub unavailable while checking `production.main_is_verified` -> `unknown`.
- Main known not to equal the verified production coordinate -> `violated`.
- Exact readback proves equality -> `satisfied`.

### Initial invariant families

#### Coordination

- `coordination.no_expired_active_slots`
- `coordination.no_stuck_claiming_leases`
- `coordination.no_stuck_settling_leases`
- `coordination.no_unresolved_indeterminate_effects`
- `coordination.no_overdue_active_runs`

These should reuse existing `orchestration.status`/maintenance queries where possible.

#### Scheduled execution

- `workers.scheduler_firing`
- `workers.cycle_reconciliation_current`

Use Hatchable scheduling evidence and scheduled-cycle receipts, not agent memory.

#### Repository integration

- `github.branch_roles_valid`
- `github.development_policy_valid`
- `github.production_policy_valid`

Use GitHub as authority.

#### Production convergence

- `production.candidate_verified`
- `production.main_matches_verified_candidate`
- `production.runtime_matches_main`
- `production.runtime_regression_verified`

These are described below.

### Aggregate health

Overall health is derived mechanically:

- `healthy` only when all required invariants are `satisfied`;
- `degraded` when at least one required invariant is `unknown` or a non-blocking invariant is violated;
- `blocked` when a blocking invariant is violated or quarantined.

The aggregate must retain per-invariant evidence. It may not collapse an unknown authority read into a green boolean.

## 5. Production convergence as a recoverable invariant

Overcenter's current source/runtime path is:

```text
work branch
   |
   v
  dev
   |
exact revision verification
   |
   v
 main
   |
production materialization
   |
   v
Hatchable runtime
```

The recovery kernel treats this as a convergence problem rather than a sequence an agent memorizes.

### Desired invariant

For the production coordinate being claimed healthy:

```text
verified candidate SHA
    ==
GitHub production branch SHA
    ==
materialized source receipt SHA
    ==
immutable Hatchable deployment source SHA
```

plus the canonical production regression result for that exact deployment.

### Recovery

A future narrow `production.reconcile(repo)` should:

1. observe stored repository branch roles;
2. observe exact development and production heads;
3. locate valid verification evidence for the candidate;
4. determine the first unmet convergence step;
5. execute only the required deterministic step;
6. preserve exact fences and non-force semantics;
7. verify immutable Hatchable deployment evidence;
8. reread all affected coordinates.

This consolidates existing promotion/materialization mechanics. It does not create a second production authority.

An indeterminate production mutation remains a hard reconciliation boundary.

## 6. Fault-domain quarantine

### Why quarantine

The current system can degrade or disable workers, but a fault often has a narrower blast radius.

A production promotion defect should not necessarily stop read-only research or work in another repository. A lease ownership invariant violation may justify stopping all new work acquisition.

### Domain model

Quarantine state is Overcenter-owned coordination state:

```text
domain
state: healthy | degraded | quarantined
source_fault_id
reason_code
created_at
last_observed_at
cleared_at
```

Example domains:

- `work-acquisition`
- `work-settlement`
- `github-mutation:laurajoyhutchins/overcenter`
- `production:laurajoyhutchins/overcenter`
- `portfolio-projection:Overcenter`

### Rules

- Quarantine never edits GitHub/Linear/Hatchable authority by itself.
- Quarantine is created only from a typed fault or violated invariant with an explicit quarantine policy.
- Effecting commands mapped to a quarantined domain fail before mutation with a typed `FAULT_DOMAIN_QUARANTINED`, `may_have_mutated:false`.
- Read-only diagnosis, health, fault-packet inspection, and authority reconciliation remain available.
- Clearing quarantine requires fresh invariant evaluation proving the fault condition is no longer active.
- A caller cannot bypass quarantine with a boolean request flag.
- Recovery internals can invoke only registered reconciliation operations needed to clear the domain. This capability is server-owned, not caller-supplied.

## 7. Scheduled deterministic healing

Scheduled healing sits above, not inside, `orchestration.maintain`.

The existing hourly maintenance task keeps its narrow coordination responsibilities.

A separate scheduled recovery pass:

1. evaluates bounded health invariants;
2. selects only violated invariants that explicitly permit automatic recovery;
3. invokes the registered recovery operation;
4. rereads the invariant;
5. records healed / still-violated / unknown;
6. quarantines when policy requires it;
7. never creates or prioritizes portfolio work.

No reasoning model is called by the scheduled healer.

If deterministic recovery stops, the durable fault packet is sufficient for a later reasoning agent.

## Error handling model

### Known safe transient

Example: transport unavailable, mutation impossible.

```text
fault -> bounded exact retry -> readback -> healed
```

### Known stale coordination

Example: expired lease slot.

```text
fault -> orchestration.maintain -> reread slot/lease -> healed
```

### Indeterminate external effect

```text
fault (may_have_mutated=true)
   |
   v
NO RETRY
   |
authoritative/domain reconciliation
   |
   +--> effect proven --> continue from proven state
   |
   +--> effect absent --> registered operation may retry with same semantic identity
   |
   +--> cannot prove --> quarantine + fault packet
```

### Unknown fault

```text
fault -> fault packet -> quarantine if blast-radius policy requires -> reasoning
```

### Semantic decision required

```text
fault -> fault packet(required_decisions=[...]) -> reasoning/operator
```

## Privacy and evidence minimization

The recovery kernel increases useful correlation without broadening durable data capture.

- Reuse command-owned safe request/result projections.
- Do not add raw request bodies to fault packets.
- Do not store lease tokens in runtime provenance or fault packets.
- Do not persist arbitrary GitHub/Hatchable provider responses.
- Evidence refs should identify authoritative objects/revisions, not copy their full contents.
- Unknown new command fields are omitted from durable recovery evidence unless explicitly admitted by the command owner.
- Packet size must be bounded by explicit list/count limits.

This design should align with the command-owned projection hardening tracked separately in GitHub #177.

## Data model changes

### Invocation runtime provenance

Add a nullable bounded JSON projection to `orchestration_command_invocations`, for example:

```sql
runtime_provenance jsonb
```

No historical rewrite is required.

### Quarantine state

Add a small Overcenter-owned table for active/cleared fault domains. It stores coordination decisions, not copies of external authority.

Fault packets themselves remain derived in the first version.

## Public semantic surfaces

Initial new semantic surfaces:

```text
orchestration.fault_packet
orchestration.recover
overcenter.health
```

A later production slice may add:

```text
production.reconcile
```

Each command must use the existing command-response envelope and orchestration journal conventions where applicable.

Read-only inspection commands must not create recursive journal noise that changes the fault they are inspecting. Follow the existing `diagnose`/`resume_packet` journal-exclusion pattern.

## Rollout

### Slice 1: Provenance and fault packet

Land runtime provenance and `orchestration.fault_packet`.

Success criterion: reproduce a novel semantic-boundary failure similar to GitHub #135 and produce a packet that identifies the faulting command, exact runtime/source provenance, mutation certainty, causal predecessor, authority observation, and the fact that reasoning is required.

No automatic recovery is added in this slice.

### Slice 2: Recovery executor

Land `orchestration.recover` for a deliberately small allowlist of already-encoded safe cases.

Success criterion: stale lease and safe transport retry recover mechanically; indeterminate external effect refuses blind retry.

### Slice 3: Health invariant registry

Land `overcenter.health` first for coordination and scheduled execution, then GitHub and production convergence.

Success criterion: authority unavailability returns `unknown`, not an inferred status.

### Slice 4: Quarantine and scheduled healing

Only after the previous slices demonstrate stable classification and readback.

Success criterion: a narrow fault blocks only its domain; deterministic scheduled recovery can clear quarantine only after invariant readback proves convergence.

## Testing strategy

Every recovery claim requires negative tests, not only happy paths.

### Provenance

- Invocation captures the executing source/deployment coordinate.
- Later source movement does not change historical provenance.
- Missing provenance returns explicit historical/unknown state.
- Secrets and capability material cannot enter the provenance projection.

### Fault packets

- Packet for a known failure contains causal predecessor, faulting invocation, lease/checkpoint evidence, runtime provenance, and recovery classification.
- Packet for an unknown `REQUEST_INVALID` does not invent a root cause.
- Packet identity is stable for the same durable fault.
- Read-only packet inspection does not change the inspected journal state.

### Recovery

- Stale lease self-heals and proves slot release.
- Retryable transport failure retries no more than the configured maximum.
- `may_have_mutated:true` never takes the exact-retry path before reconciliation.
- Settlement requiring disposition returns a required-decision boundary.
- Repeated recovery failure becomes `RECOVERY_FAILED`.
- Success without authoritative readback cannot return `HEALED`.

### Health

- Satisfied, violated, and unknown are independently tested.
- External authority read failure maps to unknown.
- Aggregate health cannot be healthy with required unknown invariants.
- Existing orchestration status telemetry remains available.

### Quarantine

- Quarantined domain blocks mapped mutation before external effect.
- Unrelated domain remains executable.
- Read-only diagnosis/reconciliation remains available.
- Caller cannot bypass quarantine.
- Clear requires fresh satisfied invariant evidence.

### Scheduled healing

- Only explicitly auto-recoverable invariants are attempted.
- No portfolio work is selected or created.
- Recovery budget is bounded.
- Failure leaves durable fault evidence and does not thrash.

## Acceptance criteria

The architecture is implemented when all of the following are true:

1. A command fault can be tied to the exact runtime/source provenance that executed it.
2. `orchestration.fault_packet` gives a fresh agent enough bounded evidence to begin investigation without reconstructing the run manually.
3. `orchestration.recover` exhausts deterministic safe recovery before escalating.
4. It is impossible for the recovery executor to choose a semantic disposition on behalf of an agent/operator.
5. Indeterminate external effects are reconciled before any retry.
6. `overcenter.health` represents required invariants with three-valued state.
7. Every `HEALED` result includes fresh authoritative readback proving convergence.
8. Fault-domain quarantine isolates the affected mutation surface without unnecessary worker-wide shutdown.
9. Scheduled healing performs only deterministic bounded operations.
10. Existing diagnosis, resume, maintenance, receipts, and authority boundaries remain canonical rather than being replaced by parallel state.

## Agent-facing operating model

Once these slices land, the expected debugging path becomes:

```text
1. overcenter.health
2. orchestration.recover(run_id) when a run is implicated
3. inspect the returned fault packet only if deterministic recovery stops
```

Protocol internals remain available for deep investigation, but they are no longer the entry fee for operating Overcenter.
