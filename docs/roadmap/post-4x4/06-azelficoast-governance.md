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

- [ ] Existing Azelficoast promotion/evaluation decisions can be represented without extending the kernel vocabulary.
- [ ] Exact experiment and candidate identities prevent evidence migration.
- [ ] Insufficient or ambiguous playing-strength evidence cannot permit promotion.
- [ ] Shadow comparison explains every disagreement before any authority transfer.
- [ ] Fresh exact-head evidence exists in both repositories for the tested boundary.

## Initial shadow slice

The first implementation keeps Azelficoast's `settle_battle_panel()` result authoritative and projects that decision into a generic, read-only 4×4 snapshot.

The domain adapter binds one Coordinate to the exact Azelficoast repository revision, candidate checkpoint digest, incumbent checkpoint digest, frozen deployment routing, frozen policy, evidence schema/version, and raw-results digest. The generic evaluator then derives the shadow decision only from exact-coordinate `permits`, `asserts`, `supports`, and transitive `requires` relations.

The current mapping is:

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

The adapter owns Azelficoast vocabulary. `src/governance/promotion-shadow.ts` contains no Pokémon, battle, rating, or experiment-policy semantics.

Current hostile cases cover:

- stale promotion permission;
- candidate identity migration;
- experiment/results identity migration;
- missing or failed playing-strength evidence;
- incomplete panel evidence;
- a forged legacy `admitted: true` decision;
- noncanonical external evidence schema or checkpoint identity.

Every disagreement is returned explicitly with fail-closed reasons. The shadow result cannot replace Azelficoast authority in this slice.

## Current handoff

Implementation base at mutation start:

`post-4x4/05-sqlite-calculus@865faf5e23731dd89da6f19acbb52b2df0d63540`

Pre-change Stage 6 head:

`5a06d814d4e05182fe71f522ec4483919a339882`

External boundary inspected:

`laurajoyhutchins/azelficoast@806630728b472ebaa11d5f991e72d306da90628a`

Files in the initial implementation slice:

- `src/governance/promotion-shadow.ts`
- `src/integrations/azelficoast-promotion.ts`
- `test/azelficoast-promotion-shadow.test.ts`
- this handoff

Semantic claim: the current Azelficoast candidate-promotion decision can be represented in shadow using only Object, Event, Proposition, Coordinate, permits, asserts, supports, and requires. No production authority is transferred.

Local evidence before push:

- strict TypeScript check using repository compiler semantics: PASS;
- focused Node test suite: 7/7 PASS.

Hosted evidence: pending the exact pushed head. Azelficoast's current main has mixed workflow history at its exact revision, so no cross-repository green claim is made here.

Deletion ledger:

```text
old owner: none; Azelficoast settle_battle_panel remains authoritative
new deterministic owner: none in this shadow stage
4×4 relation/query: exact permit + transitive requirements satisfied by exact assertions/supports
equivalence evidence: local shadow/hostile tests only so far
hostile invariant preserved: stale, incomplete, ambiguous, or migrated evidence cannot permit promotion
remaining agent judgment: none in the projected decision; authority transfer remains a later reviewed choice
```

Remaining uncertainty: fresh hosted evidence must demonstrate the exact Overcenter head and a relevant exact Azelficoast boundary before any authority transfer. The exact pushed Stage 6 head is recorded in the PR conversation after Git creates it, avoiding a self-referential commit hash in this file.

Smallest next action: run the Stage 6 exact-head checks, obtain a focused Azelficoast exact-head promotion proof, then compare real promotion evidence through the shadow before considering authority transfer.

## Deletion / generation ledger

Delete no Azelficoast production authority in the initial shadow slice. Record any bespoke machinery that becomes a later deletion candidate.

For each semantic deletion or generated replacement, record:

```text
old owner:
new deterministic owner:
4×4 relation/query:
equivalence evidence:
hostile invariant preserved:
remaining agent judgment:
```

## Stop condition

Stop if Pokémon-specific semantics must enter the kernel. Capture the counterexample and keep the domain rule in Azelficoast instead.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
