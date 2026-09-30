# Experiments

Only maintained executable research lives in this tree. Git history is the archive for retired experiments; old experiment prose, result snapshots, and registry records are not carried forward once their useful conclusions have either graduated into production machinery or been rejected.

`experiments/registry.json` catalogs the maintained set. It is an explainability aid, not project authority or a merge-gate input.

## Maintained experiments

- `assignment-capsule` (supported) — Can Overcenter claim real work and deliver a self-contained byte-complete assignment to an empty disposable worker?
- `authority-flow-analysis` (supported) — Can a small static abstract interpreter reject mutation paths where untrusted agent data, exact revision identity, or current execution authority cross a trust boundary incorrectly, while accepting the real GitHub mutation paths without per-path suppressions?
- `authority-storage-decomposition` (supported) — Can Overcenter factor durable project authority into immutable content-addressed fact objects plus a separately linearizable authority-head CAS without changing project semantics?
- `codex-closed-loop` (pending) — Can Overcenter delegate implementation judgment to a disposable Codex worker while retaining claim, verification, settlement, publication, and readback authority outside the worker?
- `disposable-agent` (supported) — Can a fresh worker recover after the original worker disappears?
- `distributed-authority-chaos` (supported) — Does the Postgres-free remote-CAS authority architecture survive repeated controller turnover, concurrent unrelated authority updates, unresolved-effect handoff, and repeated execution-authority rotation rather than only one staged transaction?
- `distributed-authority-handoff` (supported) — Can independent disposable controllers share authoritative Overcenter project truth without a shared application database by using immutable Git facts plus one remote exact-head CAS coordinate?
- `github-object-transport` (supported) — Can a worker receive exactly declared GitHub bytes without a checkout or repository credential?
- `production-criticality-ranking` (mixed) — Can Overcenter maintain a reproducible total ordering of production-code importance from quantitative facts?
- `production-latency` (supported) — For one successful production GitHub status transaction, how much latency belongs to Overcenter local correctness machinery versus provider I/O?
- `semantic-scaling` (pending) — Does marginal trusted semantic complexity converge as supported autonomous work becomes more semantic?
- `substrate-capability-admission` (supported) — Can signed, context-bound substrate capability evidence safely affect admission for one exact provider capability without trusting environment declarations?
- `verified-generated-output` (supported) — Can trusted validation establish authoritative identity for generated artifact bytes that were not known when the obligation was defined, while downstream work consumes only retained evidence and an authoritative settlement receipt?

## Evidence rules

- Freeze material design before outcome-bearing execution when a claim is confirmatory.
- Bind hosted evidence to an exact Git revision and preserve only evidence still needed by a live claim.
- Promote durable correctness properties into `src/`, `test/`, or `formal/`; do not keep a second historical implementation alive in `experiments/`.
- A falsified hypothesis is a valid result. Once its design lesson is captured by current machinery or Git history, retire the working-tree scaffolding.

## Statistical evidence

Statistical requirements belong to the executable experiment design, not to the registry. When
sampling or stochastic behavior is material, the frozen experiment should state the estimand,
sampling unit and count, uncertainty method, stopping rule, and any confirmatory decision threshold
before outcome-bearing execution.

The experiment's scorer owns those calculations from raw observations. `experiments/registry.json`
remains explanatory metadata and has no authority over merge or promotion decisions. Deterministic
and exhaustive claims should continue to report their bounded corpus or state space directly.

Hosted proofs remain thin workflows under `.github/workflows/` and invoke the maintained experiment
or production proof they exercise.
