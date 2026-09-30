# Semantic scaling falsification

This experiment asks whether Overcenter can govern increasingly semantic work without making the trusted authority path reproduce the same task-specific reasoning as the worker.

The hypothesis is deliberately falsifiable:

> As autonomous work becomes more semantically complex and consequential, the authority-bearing mechanism required to prevent false settlement can remain substantially smaller and more task-independent than the reasoning machinery that proposes the work.

The experiment does **not** treat raw repository size as the result. Existing property-scoped TCB measurement remains the source for trusted-surface size. This experiment adds semantic attribution: whether trusted machinery is reused and general, newly reusable, provider-specific, or task-specific, and whether any task-specific trusted rule is effectively equivalent to the candidate-producing judgment.

The preregistered classification has four outcomes:

- **convergent** — the authoritative claim is mechanically settleable without reproducing candidate reasoning or narrowing the claim;
- **frontier-limited** — the kernel remains mechanical by settling a narrower claim and retaining the residual semantic judgment explicitly;
- **semantic-mirroring** — trusted authority-bearing logic reproduces substantially the same task-specific judgment used to construct the candidate;
- **unsupported** — the requested truth cannot be established from the declared observation/authority assumptions.

`fixtures.json` contains synthetic controls across five rungs. They are not empirical evidence that the scaling thesis holds. In particular, `mirrored-bug-repair-negative-control` is intentionally bad architecture and must classify as semantic mirroring. `weakly-observable-external-effect` must remain unsupported rather than becoming terminal merely because more deterministic machinery is added.

Run:

```sh
npm run test:semantic-scaling
npm run experiment:semantic-scaling
```

The CLI emits a deterministic comparison artifact to stdout. Surface order does not affect the result.


## First empirical ladder

The first revision-bound measurement was produced at `7f95ca1c23ca089f7990e864d84ea61aaa4f6fc8` from the ordinary merge-gate TCB report.

| Task family | Trusted semantic LOC | Marginal LOC vs prior rung | Task-specific marginal | Provider-specific marginal |
| --- | ---: | ---: | ---: | ---: |
| Pure computation with independent observation | 9,281 | +9,281 baseline | 0 | 0 |
| Exact-base source integration | 9,285 | +4 | 0 | 0 |
| GitHub commit-status safe settlement | 9,285 | +0 | 0 | 0 |

The source-integration rung introduced the `source/integrate` architecture-effect scope and `broker-mutation-safety`; its four new trusted semantic lines are in `src/model.ts`. The GitHub rung added no new trusted source lines relative to the preceding union, but it introduced the provider-specific `github-commit-status-provider` property, the `github-commit-status/create` effect scope, and five GitHub/transport assumptions.

That distinction is important. A zero marginal LOC result means the measured trusted source lines were already present in the prior union. It does **not** mean the later task has zero additional semantics or assumptions. The generated result therefore records scope identities, authority roles, fingerprints, observation support, and external-assumption deltas separately from LOC.

This is evidence of strong reuse across the three exercised paths, not yet evidence that trusted semantic complexity generally converges. The completed behavioral bug-repair and behavior-preserving migration rungs below test two of those follow-ons; additional provider families remain useful attempts to falsify the apparent plateau.

To reproduce the marginal measurement:

```sh
npm run check:tcb -- --output /tmp/overcenter-tcb-report.json
npm run experiment:semantic-scaling:measure -- --tcb-report /tmp/overcenter-tcb-report.json
```

### Behavioral bug-repair frontier

At exact head `284bfdc891339dbf9fd26dc00675254d2004a671`, merge-gate run `36655390866` exercised the historical conflicting-effect failure shape as a current behavioral regression.

The added rung measured **9,285 trusted semantic LOC, +0 marginal LOC, +0 task-specific LOC, +0 provider-specific LOC, no new trusted scopes, and no new external assumptions**. The deterministic regression suite passed **424/424**.

That is not classified as convergent. It is **frontier-limited**:

- mechanically established: the exact regression is bound to the measured source and passes under the existing verification machinery;
- deliberately not established: no unordered incompatible operations targeting the same canonical effect coordinate can ever both obtain execution authority;
- residual judgment: whether the maintained regression and provider-specific conflict model completely characterize every relevant future conflicting-effect behavior.

This is the first exercised rung where trusted source complexity remains flat because the authoritative claim becomes narrower at the semantic boundary. A flat TCB therefore does not imply that semantic uncertainty disappeared.


### Behavior-preserving migration frontier

At exact head `37a20b2ba16d7f448f1a8d8cb412b1f18a37d0bf`, merge-gate run `36656387619` measured the projection-boundary migration lineage from PR #25.

The migration rung measured **9,285 trusted semantic LOC, +0 marginal LOC, +0 task-specific LOC, +0 provider-specific LOC, no new trusted scopes, and no new external assumptions**. The deterministic regression suite passed **424/424**.

It is also **frontier-limited**:

- mechanically established: the historical migration candidate passed its exact-head full regression and hostile readback proof, and current projection/backend-differential regressions remain green;
- deliberately not established: the migration preserved every externally observable behavior for every valid durable history and provider state;
- residual judgment: whether the historical and maintained regression/oracle corpus completely characterizes every behavior that could have changed across the migration.

This is a second semantic family in which the measured trusted source surface stays flat only by refusing to collapse finite regression evidence into a universal equivalence claim.

### Architectural/design frontier

At exact head `662fd2196a6c59e07d496e7f0b3894b6b6d8164d`, merge-gate run `36661144979` measured the relational architecture design boundary established by PR #449.

The architecture rung measured **9,285 trusted semantic LOC, +0 marginal LOC, +0 task-specific LOC, +0 provider-specific LOC, no new trusted scopes, and no new external assumptions**. The deterministic regression suite passed **424/424**.

It is **frontier-limited**:

- mechanically established: the exact historical concepts/logic/physics architecture satisfied repository structural separation and reconciliation checks, and its TCB roots were derived mechanically under exact-head hosted evidence;
- deliberately not established: that relational decomposition is the correct and sufficient architecture for Overcenter's intended future behavior;
- residual judgment: whether the declared layers capture every architecturally relevant intent and remain the right decomposition as the system evolves.

## Observed result

The preregistered outcome is **bounded support**.

Across all six rungs, trusted semantic LOC rose from **9,281** at the pure-computation baseline to **9,285** at source integration and then stayed flat. The consequential GitHub effect added provider-specific scopes and external assumptions without adding trusted source lines. Behavioral repair, migration, and architectural design also added no trusted source lines, but only because their authoritative claims remained explicitly narrower than universal semantic correctness, behavioral equivalence, or design correctness.

That is a useful boundary rather than a hidden success condition. The experiment supports reusable authority and settlement mechanics inside the mechanically witnessable region. It does **not** establish general semantic convergence beyond that region, and it found no need to reproduce candidate-generating semantic reasoning inside the trusted path for the exercised tasks.

The anti-cheating question for every new trusted task-specific rule remains:

> Why can this not instead be supplied as untrusted evidence checked by an existing or more general trusted primitive?

Moving semantic logic into a provider adapter, generated artifact, policy file, proof generator, or test harness does not remove it from the trusted surface when settlement depends on that logic being correct.

### Follow-on stress test: explicit judgment attestation

After the preregistered six-rung result was complete, exact head `4f45cd7f87ce6b9aee9287d7983cce4f07f62f66` exercised a deliberately new semantic primitive under merge-gate run `36663311438`.

The primitive does not decide whether an architectural judgment is correct. It certifies a durable judgment record: GitHub issue #460 comment `5903129961`, authored by `laurajoyhutchins`, with stable comment identity and exact body digest. That comment records the final architectural candidate and the bounded-support conclusion.

The measured `judgment-attestation-integrity` scope was **2,023 trusted semantic LOC**:

- **383 marginal semantic LOC**;
- **1,640 reused prior semantic LOC**;
- **383 new-reusable marginal LOC**;
- **0 task-specific marginal LOC**;
- **0 provider-specific marginal LOC**;
- three newly introduced external assumptions;
- **431/431 deterministic tests passed**.

The accepted pre-existing TCB scopes remained flat. This matters because the first attempted design did not: integrating architectural acceptance into ordinary settlement widened existing trusted scopes, and trying to rely on PR merge metadata crossed fields outside the pinned certified `pulls/get` response slice. Both failures were rejected before merge.

So the six-rung plateau should not be read as “new semantics are free.” A genuinely new mechanically checkable fact can require new trusted code. The stronger result is narrower: that growth can be isolated as reusable verification machinery while task-specific judgment remains outside the trusted path.

