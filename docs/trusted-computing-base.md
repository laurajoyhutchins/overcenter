# Trusted computing base

Overcenter measures safety complexity by **property-scoped trusted computing base (TCB)** rather than total repository size.

A TCB entry means: if this code is wrong in a relevant way, the named safety property may fail. Code outside that property's TCB is permitted to be buggy without invalidating the property, subject to the listed external assumptions.

The machine-readable policy is [`tcb-policy.json`](../tcb-policy.json). Reproduce the current report with:

```sh
npm run check:tcb
```

CI runs the same reporter on every evidence candidate and writes a compact analysis to the GitHub job summary: property and composition sizes, accepted-base deltas, transition classifications, symbol-closure status, and hostile-evidence freshness. The workflow also materializes the complete JSON report at `$RUNNER_TEMP/overcenter-tcb-report.json` for later steps without introducing a second analysis implementation.

The report gives every trusted slice an exact path, symbol or whole-file boundary, source-line range, semantic LOC count, and SHA-256 fingerprint. It then computes two independent dependency views: a transitive runtime-import envelope and a TypeScript-checker runtime-symbol closure. The import envelope is **not** an upper bound: hosted measurement falsified that assumption because injected runtime objects can call trusted code without importing its module. The ratcheted hybrid envelope therefore charges whole runtime-imported files plus runtime declarations reached across those non-import symbol edges.

## Properties

### Broker mutation safety

A broker-owned provider mutation must not cross the Overcenter effect boundary until current execution authority and exact claimed revision have been checked, an effect reservation has been durably appended, and no unresolved prior effect exists.

This property does **not** claim that an uncontrolled worker lacks ambient provider credentials. Physical effect confinement is a separate property with a different TCB.

### No false `DONE`

A run must not become `DONE` from worker assertion. `DONE` must arise from an admitted receipt whose authoritative observation proves the exact postcondition, with replay and historical realization reuse preserving those constraints.

### GitHub commit-status provider profile

The generic core depends on provider-specific facts being interpreted correctly. GitHub commit status therefore has a separately charged provider TCB covering repository identity, request dispatch certainty, response certification, pagination, and status-coordinate semantics.

## Derived ratchet

The policy declares safety meaning, external assumptions, exclusions, and hostile-evidence requirements. The architecture SQL derives trusted roots, runtime bindings, and assurance composition. Neither encodes an allowed TCB size.

For candidate admission, Overcenter measures three views with the same analyzer: the accepted source under the accepted policy, the candidate source under the accepted policy, and the candidate source under the candidate policy. Growth already visible under the accepted policy is architectural growth and is rejected. Growth that appears only after an explicit roots, runtime-binding, composition, or external-assumption change is attributed to that declared scope change. A smaller surface is a reduction.

This also handles analyzer improvements without copying measurements into policy. The candidate analyzer is applied to both source revisions, so newly discovered trust in the accepted base is treated as corrected measurement before candidate changes are compared. Changing prose alone does not create a growth exemption because the ratchet is keyed to structural trust inputs, not the property description.

The hybrid SHA-256 fingerprint remains evidence of the exact measured surface, but it is not a checked-in expected value. Semantic LOC remains a useful complexity projection, not an authority source. The accepted Git revision is the baseline.

CI writes the current report and accepted-base reconciliation to the job summary and an ephemeral JSON report. No generated TCB baseline or obligation manifest is committed to the repository.

Hostile-evidence freshness remains separate from TCB-size admission. A stale mutation probe remains visible in the report but does not make unrelated source changes fail the merge gate; an unknown configured probe still fails closed. `unconfigured` means the property does not yet have a dedicated hostile mutation probe.

## External assumptions

External assumptions are part of the TCB even though they have no repository LOC. The report keeps them visible instead of allowing a small source-code number to imply that SQLite, Node.js, the operating system, TLS, the system `curl` executable used by GitHub certified reads, or provider API semantics are somehow irrelevant. The report also lists external runtime modules and symbols reached by the analysis; those lists are dependency evidence, not repository LOC.

## Direction

Prefer changes that:

1. remove trusted symbols or whole-file entries;
2. replace whole-file entries with mechanically justified symbol slices;
3. eliminate external assumptions;
4. move fallible orchestration and reasoning outside the TCB; and
5. preserve or strengthen the safety property while shrinking the trusted surface.

The target is not the smallest repository. It is the smallest piece of software that must be right.
