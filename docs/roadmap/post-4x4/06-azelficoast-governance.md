# Post-4×4 exploitation stack

This work begins only after the strangler migration through PR #522 has landed or has been reconciled into this branch.

Canonical semantic kernel:

```text
Object      permits   Event
Event       asserts   Proposition
Object      supports  Proposition
Proposition requires  Proposition

Coordinate situates the world.
```

## Agent operating contract

- Refresh the exact predecessor branch/head before mutation. Do not trust stale SHAs.
- Do not add a fifth kernel primitive for implementation convenience.
- A proposed new primitive requires a counterexample: two worlds with identical existing 4×4 representation but different required safe behavior.
- Keep provider/domain vocabulary above the kernel.
- Prefer deterministic software over agent judgment whenever the result follows mechanically from the relations.
- Do not weaken fail-closed behavior, protected-code policy, exact-coordinate binding, or hosted exact-head evidence.
- Preserve the distinction between historical truth and current state.
- Treat uncertainty as a set of possible worlds unless formal evidence forces another representation.
- Every semantic deletion must name the surviving relation/query that now owns the behavior.
- Every authority transfer must be preceded by shadow/equivalence evidence unless the predecessor already provides exact proof.

## Required handoff

Record exact base/head, files changed, semantic claim, local proof/test results, hostile cases, hosted evidence, deletions, remaining uncertainty, and the smallest next action.

# Stage 6: Govern an Azelficoast promotion boundary with 4×4

Use Azelficoast as the first external falsification test without adding Pokémon-specific primitives to Overcenter.

## Scope

- Choose one consequential Azelficoast boundary, initially candidate evaluation/promotion, rather than integrating the whole bot.
- Represent candidate artifacts as Objects, evaluation actions as Events, playing-strength claims as Propositions, and exact experiments/revisions as Coordinates.
- Map battle/result evidence to asserts/supports and promotion prerequisites to requires.
- Run Overcenter in shadow against Azelficoast's existing promotion decision before transferring any authority.
- Keep Pokémon mechanics, rating models, and experiment policy outside the Overcenter kernel.

## Required evidence

- [x] Existing Azelficoast promotion/evaluation decisions can be represented without extending the kernel vocabulary.
- [x] Exact experiment, candidate, result, policy, deployment, and repository identities are bound into the Coordinate.
- [ ] Stage 5's SQLite calculus proves insufficient or ambiguous playing-strength evidence cannot permit promotion.
- [ ] A real shadow comparison explains every disagreement before any authority transfer.
- [ ] Fresh exact-head Merge-gate evidence is green for this Overcenter head and the tested Azelficoast boundary.

## Dependency boundary

PR #527 is the semantic dependency for this stage. At the latest refresh,
`post-4x4/05-sqlite-calculus` is still a contract-only branch at
`865faf5e23731dd89da6f19acbb52b2df0d63540`; it has not yet introduced the authoritative SQLite API for permitted-event, unsupported-requirement, transitive-requirement, stale-support, or stale-permission queries.

Therefore Stage 6 deliberately does **not** implement those queries in TypeScript.

The temporary TypeScript shadow evaluator created during this draft was deleted after refreshing #527. Keeping it would make Stage 6 a second semantic owner and violate Stage 5's requirement that TypeScript remain a typed boundary around relational authority.

## Current projection slice

Azelficoast's existing `settle_battle_panel()` result remains authoritative. The Stage 6 adapter only converts that frozen external evidence into a typed 4×4 relation projection suitable for the Stage 5 SQLite calculus once it exists.

The domain adapter binds one Coordinate to:

- exact Azelficoast repository revision;
- evidence schema and schema version;
- candidate checkpoint digest;
- incumbent checkpoint digest;
- deployment routing;
- frozen promotion policy; and
- raw-results digest.

The mapping is:

```text
Azelficoast promotion policy        Object
candidate checkpoint               Object
incumbent checkpoint               Object
raw battle-result evidence         Object
panel evaluation                   Event
candidate promotion                Event
playing-strength checks            Propositions
panel completeness                 Proposition
promotion admissibility            Proposition
exact experiment/revision identity Coordinate
```

The adapter emits only:

```text
Object permits Event
Event asserts Proposition
Object supports Proposition
Proposition requires Proposition
```

A failed or missing Azelficoast check is not projected as an assertion. An incomplete battle panel does not project support for panel completeness. The legacy `admitted` value is retained only for later shadow comparison and never synthesizes missing 4×4 evidence.

## Hostile cases covered

- candidate checkpoint identity changes;
- raw-results identity changes;
- repository revision changes;
- missing playing-strength checks;
- failed playing-strength checks;
- incomplete panel evidence;
- forged legacy `admitted: true` with missing relational evidence;
- noncanonical evidence schema/version;
- identical candidate and incumbent checkpoint identities.

These cases prove projection behavior, not promotion admission. Admission remains intentionally blocked on the Stage 5 SQLite calculus.

## Current handoff

Stage 5 base at the latest refresh:

`post-4x4/05-sqlite-calculus@865faf5e23731dd89da6f19acbb52b2df0d63540`

Pre-correction Stage 6 head:

`9d917baadedb5b25d5cc1784ed371e21e6df0c7d`

External boundary inspected:

`laurajoyhutchins/azelficoast@806630728b472ebaa11d5f991e72d306da90628a`

Files in the corrected implementation slice:

- `src/integrations/azelficoast-promotion.ts`
- `test/azelficoast-promotion-shadow.test.ts`
- this handoff

Deleted from the draft:

- `src/governance/promotion-shadow.ts`, because Stage 6 must not own a parallel TypeScript 4×4 calculus.

Semantic claim: the current Azelficoast candidate-promotion evidence can be losslessly projected into the closed 4×4 vocabulary with exact identity binding. No promotion decision is derived in Stage 6 until Stage 5 supplies the authoritative SQLite calculus. No production authority is transferred.

Local focused runtime smoke after removing the parallel evaluator: PASS, 5/5 representative tests. Full repository verification is delegated to the exact pushed head because this environment cannot fetch the repository dependency graph directly.

Hosted Azelficoast evidence:

- exact source revision `806630728b472ebaa11d5f991e72d306da90628a`;
- rerun attempt 2 of workflow run `36587607383`;
- job `test` / `110617906581`: SUCCESS, including the normal test suite and fast hostile correctness gate;
- job `static`: SUCCESS;
- the workflow as a whole remains red because the separate `Overcenter project.advance` integration job fails, so no whole-workflow green claim is made.

Hosted Overcenter evidence before this correction:

- Stage 6-local formatting defects were fixed;
- exact head `9d917baadedb5b25d5cc1784ed371e21e6df0c7d` still failed candidate certification only on inherited predecessor formatting in `src/authority/engine.ts` and `src/authority/transaction-admission.ts`;
- Static authority-flow differential: SUCCESS;
- PR preflight consequently failed because exact-head candidate evidence was not successful.

The corrected exact head is recorded in the PR conversation after Git creates it, avoiding a self-referential commit hash here.

## Deletion / generation ledger

```text
old owner: draft src/governance/promotion-shadow.ts TypeScript evaluator
new deterministic owner: Stage 5 SQLite 4×4 calculus, once #527 implements it
4×4 relation/query: permitted-event + transitive requirements + exact assertions/supports
equivalence evidence: no authority transfer attempted; projection tests only
hostile invariant preserved: legacy admission cannot manufacture absent relational evidence
remaining agent judgment: whether/when to transfer promotion authority after real shadow comparison
```

## Remaining uncertainty

The integration is intentionally incomplete until #527 provides the SQLite calculus. The next implementation must consume that API rather than reintroduce a local evaluator.

The Overcenter stack also has inherited formatting debt in `src/authority/engine.ts` and `src/authority/transaction-admission.ts` that blocks fresh candidate certification independently of this Stage 6 slice.

## Smallest next action

Implement and certify #527's SQLite calculus. Then wire this Azelficoast projection directly into that authority, run a real exact-coordinate shadow comparison over promotion evidence, and only then consider transferring promotion authority.

## Stop condition

Stop if Pokémon-specific semantics must enter the kernel. Capture the counterexample and keep the domain rule in Azelficoast instead.

## Completion note

Do not mark ready until the exact-head handoff above is complete and the Stage 5 dependency is authoritative.
