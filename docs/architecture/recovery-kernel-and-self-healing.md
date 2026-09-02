# Recovery Kernel and Self-Healing Architecture

**Status:** Approved design  
**Authority:** GitHub issue #193  
**Scope:** Recovery, diagnosis, health, and bounded automated healing for Overcenter

## Summary

Overcenter recovers from compact present-tense state: the current orchestration run, current execution authority and checkpoint, unresolved operation state, exact-revision proofs, and fresh observations of external authority. A bounded current-failure register on the run preserves only the failure class and streak needed for deterministic recovery policy.

Historical journals, horizons, heartbeat rows, superseded checkpoints, and legacy receipt ledgers are diagnostic telemetry or migration compatibility. They may be retention-bounded and are never required to decide what may safely happen next. The recovery kernel makes current-state interpretation and safe recovery choreography software responsibilities.

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

The recovery kernel is deliberately thin. It composes current compact state, exact proofs, fresh authority reads, and narrow reconciliation primitives rather than creating a second incident or historical state authority.

## Goals

- Make known-safe recovery deterministic and bounded.
- Give novel faults enough causal context for a fresh agent to investigate without rebuilding the run mentally.
- Require evidence before every healing claim.
- Keep `unknown` distinct from both healthy and failed.
- Preserve exact mutation certainty. An indeterminate external effect is reconciled before retry.
- Capture the software/runtime revision that actually executed each command.
- Quarantine the smallest affected mutation domain instead of disabling unrelated work.
- Keep repeated recovery choreography in software. Use reasoning only when facts do not determine a safe action.

## Non-goals

- A generic incident-management platform.
- A second copy of GitHub, Hatchable, or Linear state.
- Automatic semantic decisions such as choosing `completed`, `requeue`, or `blocked`.
- Automatic source rollback.
- Unlimited retries.
- AI-generated root-cause claims inside the kernel.

## Authority boundaries

| Concern | Authority |
| --- | --- |
| Repository contents, refs, commits, pull requests, releases | GitHub |
| Current runs and execution authority, unresolved operations, exact proofs, compact terminal receipts | Overcenter |
| Runtime and deployment state | Hatchable |
| Executable work projection | Linear, while configured |
| Runtime source identity | Exact GitHub revision bound to verified Hatchable deployment evidence |
| Recovery decision | Deterministic Overcenter policy when facts fully determine a safe action; reasoning/operator otherwise |

Derived recovery data is evidence, not a competing authority.

## Compact recovery substrate is canonical

`orchestration.diagnose` remains the failure classifier. `orchestration.resume_packet` remains the continuation surface. `orchestration.maintain` remains the bounded coordination janitor. Their correctness substrate is now `orchestration_runs` plus `execution_state`, unresolved `operation_state`, exact `proof_state`, and fresh authority reads. The command journal and historical domain receipts may support debugging or migration, but no correctness path may query them as a fallback.

## 1. Execution-time runtime provenance

Every journaled command invocation should capture a bounded immutable provenance projection at command start:

```json
{
  "source_commit": "40-char Git SHA or null",
  "production_version": "immutable deployment version or null",
  "runtime_integrity": "verified | unverified | indeterminate | unknown",
  "worker_transport_revision": "revision or null",
  "contract_revisions": {
    "project_instructions": "revision or null",
    "fast_forward_skill": "revision or null",
    "execution_ownership_skill": "revision or null"
  }
}
```

Historical provenance is never rewritten from current state. Missing historical provenance remains explicit. Lease capabilities, credentials, raw prompts, source blobs, and arbitrary provider payloads are excluded.

## 2. Deterministic fault packets

Add a read-only semantic command:

```text
orchestration.fault_packet({ run_id, invocation_id? })
```

The packet is the smallest bounded causal object needed to troubleshoot one fault. It composes:

1. current diagnosis;
2. current resume packet;
3. the current bounded run failure or unresolved operation;
4. current execution authority and checkpoint evidence;
5. relevant compact effect tombstones and exact proofs;
6. captured runtime provenance when required by the safety decision;
7. fresh authority observations required by the failure class;
8. optional historical diagnostic trace when it is retained.

It contains classification, mutation certainty, software identity, execution state, authority observations, recovery eligibility, required decisions, and evidence refs. It does not contain an AI-generated diagnosis.

`fault_id` is stable for the same durable fault and excludes observation time. Fault-packet inspection must not recursively change the journal being inspected.

## 3. Bounded recovery executor

Add:

```text
orchestration.recover({ run_id })
```

The caller expresses recovery intent only. Retry identities, capability material, authority coordinates, and recovery recipes stay inside the semantic boundary.

The executor uses a server-owned registry that maps typed failure states to existing narrow recovery operations. Initial safe classes include stale coordination cleanup, proven no-mutation transport retry, canonical claim re-observation, checkpoint-backed requeue when disposition is already determined, and authoritative reconciliation of indeterminate effects.

Recovery stops when the operation needs a semantic decision, authority conflicts, evidence is missing, the failure class is unknown, runtime integrity is not verified for an effecting command, or the bounded recovery budget is exhausted.

A successful recovery command is not sufficient for `HEALED`. Healing requires fresh diagnosis plus authoritative readback proving the affected invariant and no unresolved effect.

## 4. Three-valued health invariants

Add a read-only surface:

```text
overcenter.health({ scope? })
```

Every invariant returns:

```json
{
  "key": "coordination.no_expired_active_slots",
  "status": "satisfied | violated | unknown",
  "fault_domain": "work-acquisition",
  "severity": "info | degraded | blocked",
  "evidence": [],
  "automatic_recovery_allowed": true,
  "recovery_operation": {}
}
```

`unknown` is never coerced to healthy or failed. Initial invariant families cover coordination, scheduled execution, repository integration, and production convergence. Aggregate health is healthy only when all required invariants are satisfied.

## 5. Production convergence

Treat production as a reconciled invariant rather than a remembered sequence:

```text
work branch -> dev -> exact-revision verification -> main -> materialization -> Hatchable runtime
```

For a healthy production coordinate:

```text
verified candidate SHA
  == GitHub production branch SHA
  == materialized source receipt SHA
  == immutable Hatchable deployment source SHA
```

and the canonical production regression must pass for that exact deployment.

A future narrow `production.reconcile(repo)` should observe branch roles and exact heads, locate valid verification evidence, perform only the first unmet deterministic convergence step, preserve exact fencing/non-force semantics, then reread every affected coordinate. An indeterminate production effect remains a hard reconciliation boundary.

## 6. Fault-domain quarantine

Quarantine is Overcenter-owned coordination state, not an external authority mutation. Example domains include:

- `work-acquisition`
- `work-settlement`
- `github-mutation:<repo>`
- `production:<repo>`
- `portfolio-projection:<project>`

Effecting commands mapped to a quarantined domain fail before mutation with typed evidence and `may_have_mutated:false`. Read-only diagnosis, health, fault-packet inspection, and registered reconciliation remain available. Quarantine clears only after fresh invariant evaluation proves the fault condition is gone. Callers cannot bypass quarantine with a request flag.

## 7. Scheduled deterministic healing

Scheduled healing is separate from `orchestration.maintain` and contains no reasoning-model call. Each pass:

1. evaluates bounded health;
2. selects only violated invariants explicitly permitting automatic recovery;
3. invokes the registered recovery operation;
4. rereads the invariant;
5. records healed, still violated, or unknown;
6. quarantines where policy requires;
7. never creates or prioritizes portfolio work.

## Error model

- **Known safe transient:** bounded exact retry, then readback.
- **Known stale coordination:** maintenance, then reread coordination state.
- **Indeterminate external effect:** never blind retry; reconcile authority first.
- **Unknown fault:** produce fault packet and quarantine only if blast-radius policy requires it.
- **Semantic decision required:** produce required-decision evidence and stop for reasoning/operator input.

## Privacy and evidence minimization

The kernel preserves only the minimum state that can change a future safety decision. Active execution keeps one current checkpoint and bounded progress hashes; unresolved operations keep only the recovery material they still need; terminal operations collapse to compact tombstones; exact proofs are revision-scoped. Historical journals and traces are optional telemetry with bounded retention. Do not store raw request bodies, lease tokens, credentials, arbitrary provider responses, or copied authority contents.

## Rollout

1. **Provenance + fault packet.** No automatic healing yet.
2. **Recovery executor.** Small allowlist of already encoded safe cases.
3. **Health registry.** Coordination and scheduler first, then GitHub and production convergence.
4. **Quarantine + scheduled healing.** Only after earlier classification/readback behavior is stable.

## Acceptance criteria

The architecture is implemented when:

1. every relevant fault can be tied to the exact runtime/source provenance that executed it;
2. a bounded fault packet gives a fresh agent enough evidence to begin investigation;
3. deterministic safe recovery is exhausted before reasoning escalation;
4. recovery cannot choose semantic dispositions;
5. indeterminate effects reconcile before retry;
6. health is three-valued;
7. every `HEALED` result includes fresh authoritative readback;
8. quarantine isolates the affected mutation surface;
9. scheduled healing is deterministic and bounded;
10. diagnosis, resume, and maintenance depend only on compact current state, unresolved operations, exact proofs, and fresh authority; telemetry is never a correctness dependency.

## Agent-facing operating model

The intended entry path becomes:

```text
1. overcenter.health
2. orchestration.recover(run_id) when a run is implicated
3. inspect the returned fault packet only if deterministic recovery stops
```

Protocol internals remain available for deep investigation, but they are no longer the entry fee for operating Overcenter.
