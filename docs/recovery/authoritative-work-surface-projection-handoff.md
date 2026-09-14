# Recovery handoff: authoritative work-surface projection

Status: recovery bookmark only. **Do not merge this branch.**

Repository: `laurajoyhutchins/overcenter`

Recovery branch: `chore/authoritative-work-surface-projection`

Branch baseline before this note: exact current `dev` commit `34c8c8279555b8f35ea59b59211ba2b0f39cdc71`.

The branch previously contained an unsafe accidental rewrite of `.overcenter/definitions/target-architecture.json` that collapsed roughly 3,050 lines. That history was intentionally discarded by force-resetting the branch to the exact `dev` commit above before writing this handoff. Do not recover or cherry-pick the discarded graph edit.

## Objective

Amend the Overcenter project graph through the **published semantic `project.amend` path**, not by hand-editing the derived graph definition.

Add one obligation-shaped node immediately downstream of artifact lineage and upstream of work-surface drift diagnosis/reconciliation:

`authoritative-work-surface-projection`

Desired condition:

> Machine-managed external work surfaces are deterministic, bounded projections of authoritative project meaning. Transient execution telemetry and coordination cannot directly accumulate as durable public provider state; equivalent machine observations converge on stable semantic projection identities, publication is authority-fenced and verifiably read back, and human-authored discussion remains protected by default.

This is the shift-left form of the recent #732 cleanup lesson: prevent machine-generated public sediment at publication time rather than routinely compacting it afterward.

## Intended graph placement

The relevant branch was previously inspected as approximately:

```text
establish-project-artifact-lineage
        |
        +--> add-project-artifact-binding
        |             |
        |             v
        |   diagnose-project-work-surface-drift
        |             |
        +--> add-github-work-surface-retirement-commands
                      |
                      +----------+
                                 v
                  add-project-work-surface-reconcile
                                 |
                                 v
            backfill-and-reconcile-overcenter-work-surface
```

Insert the new obligation after `establish-project-artifact-lineage` and before drift diagnosis/reconciliation. Preserve the provider retirement primitive as a narrow execution mechanism, not a semantic publication authority.

A reasonable target shape is:

```text
establish-project-artifact-lineage
        |
        v
authoritative-work-surface-projection
        |\
        | +--> add-project-artifact-binding
        |              |
        |              v
        +----> diagnose-project-work-surface-drift
                       |
        add-github-work-surface-retirement-commands
                       |
                       +----------+
                                  v
                   add-project-work-surface-reconcile
                                  |
                                  v
             backfill-and-reconcile-overcenter-work-surface
```

Re-read the current graph before mutation and preserve any newer dependency changes. The topology above is intent, not authority.

## Acceptance contract

The obligation should establish at least these truths:

1. Machine-managed provider surfaces derive from authoritative graph/runtime/evidence truth, not prior comments or agent memory.
2. Projection identity is semantic, such as `project + subject + projection-kind`, not a provider comment ID.
3. Equivalent machine observations do not append duplicate public artifacts.
4. Meaningfully changed authoritative state updates the canonical machine-owned projection rather than creating chatter.
5. Stale authority cannot overwrite a newer projection.
6. Publication uses the same exact-revision, mutation-certainty, readback, settlement/receipt discipline as other uncertain external effects.
7. Raw execution and coordination records remain durable internally and traceable without needing to be pasted onto public GitHub discussion.
8. Human-authored discussion remains protected by default unless explicitly and semantically bound/authorized.
9. Drift diagnostics can detect missing, duplicate, stale, or obsolete-authority machine projections.
10. Legacy compaction remains repair/reconciliation machinery, not the normal publication path.

## Do not create implementation-shaped graph nodes

Do **not** add graph obligations such as:

- `implement-surface-publish`
- `add-comment-upsert`
- `add-comment-compaction`
- `add-publication-dedup`

Those are realization machinery beneath the obligation. Possible implementation concepts such as `surface.publish`, semantic keys, upsert-vs-append policy, renderers, provider comment IDs, or `surface.compact` should remain software mechanisms rather than obligation identity.

## Execution boundary

Use Overcenter's published semantic command contracts. Re-read implementation or contract documentation only when the command is unfamiliar, its contract may have changed, or validation rejects the request. Always re-establish dynamic authority and exact-revision fencing before mutation.

The stable outer `project.amend` request shape was confirmed as:

- `project`
- `expectedRevision`
- `amendment`

However, the nested amendment vocabulary and active carrier must be re-read before invoking because command ingress changed recently. In particular, `dev` at the time of this handoff contains `Retire legacy Issue semantic command ingress (#1026)`, and the replacement exact-revision command-branch ingress is now the live path.

Do not invent the nested amendment object and do not fall back to Hatchable or the retired Issue ingress.

## Resume procedure

1. Re-read current `dev`; do not assume the SHA in this note is still authoritative.
2. Re-read the published `project.amend` nested amendment vocabulary and the exact-revision command-branch ingress contract.
3. Inspect the authoritative project and obtain the current project revision.
4. Re-read the relevant work-surface nodes in the current graph so the amendment preserves newer changes.
5. Invoke exactly one bounded `project.amend` against that exact authoritative project revision.
6. Read the project back and prove `authoritative-work-surface-projection` exists with the intended dependencies and acceptance semantics.
7. Confirm no unintended graph changes occurred.
8. Treat this recovery branch as disposable afterward; it is not an implementation candidate and should not be merged.

Fail closed on revision drift, validation rejection, ambiguous mutation outcome, or readback mismatch.
