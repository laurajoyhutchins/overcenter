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

## Predecessor consumed

Stage 5 moved while this draft was in progress. This branch was refreshed against:

`post-4x4/05-sqlite-calculus@01da32b15d2964adc6f4cbbf20461972155e0c3c`

That predecessor now owns the deterministic 4×4 execution semantics in
`src/authority/sqlite-calculus.ts`. Stage 6 consumes its
`SqliteFourByFourCalculus` and frozen `FourByFourProjection` types directly.

A temporary TypeScript 4×4 evaluator created earlier in this draft was deleted. Stage 6 does not recompute transitive requirements, exact support, stale support, or stale permission semantics.

## Implementation

Azelficoast's existing `settle_battle_panel()` result remains production authority. The adapter in
`src/integrations/azelficoast-promotion.ts` projects one candidate promotion into the closed kernel:

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

The Coordinate binds:

- exact Azelficoast repository revision;
- evidence schema and schema version;
- candidate checkpoint digest;
- incumbent checkpoint digest;
- deployment routing;
- frozen promotion policy; and
- raw-results digest.

For each true Azelficoast check, the evaluation Event asserts the corresponding Proposition and the raw result Object supports it. A complete panel is represented the same way. Promotion admissibility requires panel completeness plus every playing-strength Proposition.

`shadowAzelficoastPromotion()` then does only orchestration around Stage 5's SQL authority:

1. materialize the typed projection at the caller-supplied durable Overcenter head;
2. ask `permittedEvents(coordinate)` whether the promotion Event is permitted;
3. ask `unsupportedRequirements(promotion)` for the transitive evidence deficit;
4. ask `staleSupports(coordinate)` and `stalePermissions(coordinate)`;
5. compare the resulting SQL decision with Azelficoast's legacy `admitted` bit.

No closure walk or support calculation exists in the Stage 6 TypeScript path.

## Shadow decision

The shadow admits only when all of the following SQL-derived conditions hold:

```text
promotion event is permitted
AND unsupported requirements = {}
AND stale supports = {}
AND stale permissions = {}
```

The legacy Azelficoast decision is comparison evidence only. It cannot synthesize a missing assertion, support, requirement, or permission.

## Hostile cases

The Stage 6 tests cover:

- a passing promotion that agrees with the SQLite shadow;
- a failed superiority check;
- a missing/ambiguous superiority check;
- forged legacy `admitted: true` with missing relational evidence;
- candidate identity change;
- results identity change;
- repository revision change;
- support migrated from a prior Coordinate;
- incomplete panel evidence; and
- noncanonical external schema or identical candidate/incumbent identity.

The migrated-support case deliberately keeps an old result Object while moving the candidate to a new Coordinate. Stage 5's exact-support query leaves the promotion requirement unsupported and its stale-support query reports the migrated evidence.

## Required evidence

- [x] Existing Azelficoast promotion/evaluation decisions are represented without extending the kernel vocabulary.
- [x] Exact experiment, candidate, result, policy, deployment, and repository identities are bound into the Coordinate.
- [x] Insufficient or ambiguous playing-strength evidence cannot satisfy the SQL promotion requirements.
- [x] Shadow comparison reports disagreement instead of inheriting the legacy admission decision.
- [ ] Fresh exact-head Merge-gate evidence is green for the final Stage 6 head and the tested Azelficoast boundary.

## External evidence

External boundary inspected:

`laurajoyhutchins/azelficoast@806630728b472ebaa11d5f991e72d306da90628a`

Fresh rerun evidence on that exact revision:

- workflow run `36587607383`, attempt 2;
- `test` job `110617906581`: SUCCESS, including the normal test suite and fast hostile correctness gate;
- `static`: SUCCESS;
- the workflow as a whole remains red because the separate `Overcenter project.advance` integration job fails, so no whole-workflow green claim is made.

## Overcenter evidence and dependency state

Stage 5's exact head currently has successful proof, preflight, and static authority-flow checks, but candidate certification fails with
`SOURCE_PROFILE_PROTECTED_PATH_CHANGED` because the new SQLite calculus is itself protected-code work. PR #527 remains draft and is therefore still a merge dependency for this stage.

Earlier Stage 6 heads also exposed inherited formatting failures before Stage 5 moved. This branch must be judged only at the final rebased head recorded in the PR conversation.

## Deletion / generation ledger

```text
old owner: draft Stage 6 TypeScript promotion-shadow evaluator
new deterministic owner: Stage 5 SqliteFourByFourCalculus
4×4 relation/query: permittedEvents + unsupportedRequirements + staleSupports + stalePermissions
equivalence evidence: Stage 5 SQL/reference tests plus Stage 6 Azelficoast shadow cases
hostile invariant preserved: legacy or migrated evidence cannot manufacture exact support
remaining agent judgment: whether and when to transfer Azelficoast promotion authority after shadow evidence
```

No Azelficoast production authority is deleted in this stage.

## Exact-head handoff

Files owned by Stage 6:

- `src/integrations/azelficoast-promotion.ts`
- `test/azelficoast-promotion-boundary.test.ts`
- this manifest

Semantic claim: the current Azelficoast battle-panel promotion boundary is expressible in the closed 4×4 vocabulary and can be evaluated in shadow by Stage 5's SQLite calculus without Pokémon-specific kernel semantics.

The final rebased Stage 6 head and hosted results are recorded in the PR conversation after Git creates them, avoiding a self-referential commit hash here.

## Remaining uncertainty

No real Azelficoast promotion artifact has transferred authority to Overcenter. The shadow is a deterministic compatibility boundary; production promotion remains where it is until exact-head evidence and disagreement review justify transfer.

PR #527's protected-code admission failure remains an upstream merge blocker and must not be weakened from Stage 6.

## Smallest next action

Rebase this stage on the exact Stage 5 head, run the Stage 6 exact-head checks, and inspect every shadow disagreement. If the shadow remains exact and #527 obtains its required protected-code evidence, authority transfer can be considered as a separate explicit change.

## Stop condition

Stop if Pokémon-specific semantics must enter the kernel. Capture the counterexample and keep the domain rule in Azelficoast instead.

## Completion note

Keep this PR draft until the exact-head handoff is complete and the Stage 5 dependency is admissible.
