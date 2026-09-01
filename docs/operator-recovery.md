# Operator recovery guide

**Document status: Current operator guide.** This page describes the recovery and diagnosis surfaces that are implemented now. The broader recovery-kernel architecture is an approved future-state design and includes commands that are not yet part of the shipped operator surface.

Overcenter recovery follows the same rule as normal execution: preserve authority and evidence first, then automate only what deterministic facts can prove safe.

## The current path

When a run is stuck, failed, stale, or otherwise suspicious, start here:

```text
orchestration.diagnose({ run_id })
          |
          v
 typed failure + recovery boundary
          |
          +-- deterministic recovery is identified
          |        |
          |        v
          |   run the exact bounded operation
          |   (often orchestration.maintain)
          |        |
          |        v
          |   authoritative readback
          |
          +-- continuation context is needed
          |        |
          |        v
          |   orchestration.resume_packet({ run_id })
          |
          +-- semantic decision / ambiguous effect / unknown fault
                   |
                   v
              stop for judgment
```

Do not begin by replaying the last mutation, guessing a settlement disposition, or reconstructing the run from chat history.

## 1. Diagnose before acting

Use:

```text
orchestration.diagnose({ run_id })
```

`orchestration.diagnose` reads durable orchestration state and returns the typed failure class, the deterministic recovery operation when one is known, and the escalation boundary. It is read-only diagnosis. It does not select project work or invent a recovery plan.

Treat the returned recovery classification as the control-plane answer to “what can software safely do next?” Do not replace it with a remembered recipe from a prior incident.

A diagnosis can tell you that a deterministic operation is available, that more evidence is required, or that the situation has crossed into a semantic decision that must be made by a reasoning agent or operator.

## 2. Reconstruct continuation state when needed

For a prior run, use the conceptual command:

```text
orchestration.resume_packet({ run_id })
```

The MCP transport name is currently `orchestration_resume_packet`.

The resume packet reconstructs the smallest mechanically safe continuation state for the run, including its immutable target and current target evaluation when available. It is read-only and does not claim, select, or execute work.

Use it when you need to answer questions such as:

- What target was this run actually created to advance?
- What durable continuation state survived the previous worker?
- Has the target changed or completed since the run stopped?
- What should a fresh session know without possessing the old session transcript?

The resume packet is a continuation aid, not completion evidence by itself.

## 3. Use maintenance only for maintenance-class faults

The current bounded janitor is:

```text
orchestration.maintain({ run_id })
```

`orchestration.maintain` performs deterministic cleanup of expired or stuck coordination state and resolvable orchestration-journal residue. It does not select, create, prioritize, or semantically edit project work. Project-transition lease expiry is recovered without treating Linear as authority.

Do not use maintenance as a generic “make the run green” button. Prefer it when diagnosis identifies a maintenance-class recovery or when the relevant deterministic contract explicitly says maintenance owns the fault.

Maintenance must not choose semantic facts such as whether work should be marked completed, requeued, or blocked merely because a worker disappeared. Those decisions require existing authoritative evidence or explicit judgment.

## 4. Preserve mutation certainty

Recovery must distinguish a failed attempt from an uncertain external effect.

```text
may_have_mutated: false
    -> a bounded retry may be possible if the command contract permits it

may_have_mutated: true / indeterminate
    -> reconcile authoritative external state before any retry
```

Never blind-retry a GitHub, production, settlement, or other external mutation whose effect is uncertain. A duplicate effect can be worse than a stopped run.

When a command owns idempotency or reconciliation semantics, use that command's deterministic path rather than manufacturing a new retry key or guessing from provider prose.

## 5. Confirm recovery with fresh authority

A successful maintenance or reconciliation call is not the same fact as “the incident is healed.”

After a recovery operation, reread the authority that owns the affected fact. Depending on the failure this may mean:

- run, lease, journal, or settlement state in Overcenter;
- repository, pull-request, check, or ref state in GitHub;
- current project state through `project.inspect` when the graph is implicated;
- deployment/runtime evidence from the runtime host for production faults.

The minimum recovery evidence chain is:

```text
failure observation
   -> diagnosis
   -> authorized deterministic operation
   -> operation result
   -> fresh authoritative readback
```

If the final readback is unavailable, the safe state is unknown, not healed-by-assumption.

## When to stop for judgment

Stop deterministic recovery when any of these is true:

- the diagnosis requires a semantic disposition rather than mechanical cleanup;
- an external effect may have occurred and authoritative reconciliation cannot resolve it;
- the authority required for a safe mutation is unavailable;
- two materially different recovery choices are both valid;
- the failure class is unknown and no registered deterministic operation owns it;
- recovery would require changing the meaning of the project transition rather than restoring execution correctness.

At that point, preserve the evidence and return the decision to a reasoning agent or operator. The objective is not to keep the machinery moving at all costs.

## What is implemented now

| Surface | Current role |
| --- | --- |
| `orchestration.diagnose` | Read-only typed failure classification and recovery/escalation boundary. |
| `orchestration.resume_packet` | Read-only reconstruction of the smallest safe continuation state. MCP transport name: `orchestration_resume_packet`. |
| `orchestration.maintain` | Bounded deterministic cleanup of stale coordination and resolvable journal residue. |
| Command journal and receipts | Durable evidence of invocations, outcomes, mutation certainty, settlement, and external effects. |
| `project.inspect` | Fresh authoritative project-state read when recovery affects or depends on the project graph. |

These surfaces are the current substrate for operating a failed or interrupted run.

## Approved design, not yet the current entry path

The approved [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) design moves more of this choreography behind higher-level semantic boundaries. It describes:

- `overcenter.health`;
- `orchestration.recover`;
- `orchestration.fault_packet`;
- fault-domain quarantine;
- scheduled deterministic healing;
- broader production-convergence reconciliation.

Do not treat those names as shipped merely because they appear in the approved design. The executable `mcp/` contracts and runtime source are authoritative for what is currently available.

The active implementation breakdown lives in [`implementation/recovery-kernel-plan.md`](implementation/recovery-kernel-plan.md).

## Operator rule of thumb

```text
inspect before mutation
classify before recovery
reconcile before retry
read back before claiming healed
reason only where facts stop determining the answer
```

That is the recovery boundary Overcenter is trying to make progressively more automatic without making it less truthful.
