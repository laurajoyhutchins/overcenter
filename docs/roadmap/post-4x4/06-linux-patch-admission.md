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
- A proposed new primitive requires two worlds with identical existing 4×4 representation but different required safe behavior.
- Keep provider/domain vocabulary above the kernel.
- Prefer deterministic software over agent judgment whenever the result follows mechanically from the relations.
- Do not weaken fail-closed behavior, exact-coordinate binding, protected-code policy, or hosted exact-head evidence.
- Preserve the distinction between historical truth and current state.
- Treat uncertainty as a set of possible worlds unless formal evidence forces another representation.
- Every semantic deletion must name the surviving relation/query that now owns the behavior.

# Stage 6: Govern a Linux patch-admission boundary with 4×4

Use Linux kernel development as the first serious external falsification target.

Azelficoast is retained as a useful regression domain elsewhere, but it is not a sufficiently independent stress test because we control both sides of that boundary.

## Claim boundary

This stage does **not** attempt to predict whether a Linux maintainer should like a patch.

It reconstructs whether the public record is sufficient to make a consequential integration event admissible:

```text
mechanical prerequisites
+ exact patch/base/tree identity
+ explicit public maintainer judgment
+ current evidence
-----------------------------------
integration event may be admitted
```

When explicit public judgment is absent, the correct result is **judgment required**, not guessed admission.

## Initial domain

Start with a Linux subsystem patch series, with BPF/networking preferred because it naturally exposes:

- subsystem-tree routing;
- exact base/tree identity;
- multi-patch series revisions;
- architecture/config-specific test evidence;
- maintainer authority;
- superseding v2/v3/vN series;
- cross-repository prerequisites such as userspace/iproute2 work; and
- eventual subsystem-tree versus mainline distinction.

The implementation is deliberately generic enough to replay other subsystem histories without adding Linux concepts to the kernel.

## Stage 5 dependency

Stage 5 owns deterministic relational execution in `SqliteFourByFourCalculus`.

Stage 6 consumes only:

- `FourByFourProjection`;
- `permittedEvents(coordinate)`;
- `unsupportedRequirements(proposition)`;
- `staleSupports(coordinate)`; and
- `stalePermissions(coordinate)`.

No second closure walker or support evaluator is allowed in this integration.

## Projection

The Linux boundary projects:

```text
patch series                 Object
public evidence bundle       Object
maintainer authority         Object
external prerequisite proof  Object

public observation           Event
maintainer decision          Event
integration                  Event

exact-base                   Proposition
correct-routing              Proposition
series-complete              Proposition
required-review              Proposition
required-tests               Proposition
external prerequisite(s)     Proposition
maintainer-acceptance         Proposition
integration-admissible        Proposition

patch/tree/revision identity Coordinate
```

The Coordinate binds at minimum:

- exact kernel repository revision;
- patch-series message/thread identity;
- patch-series version;
- patch-series digest and patch count;
- target subsystem/tree/branch;
- exact base commit;
- maintainer-authority source digest; and
- external prerequisite identities and revisions.

Changing any of those identities must produce a different Coordinate.

## Judgment boundary

`maintainer_acceptance` is a normal Proposition, but Stage 6 may only support it from an explicit public maintainer disposition supplied by the reconstructed history.

No score, heuristic, LLM output, or legacy/public state may synthesize that support.

Therefore:

```text
all mechanical evidence present
+ maintainer disposition unknown
= judgment required

all mechanical evidence present
+ explicit maintainer acceptance
= integration may be admitted

legacy/public history says accepted
+ missing exact evidence
= disagreement, fail closed
```

## Cross-repository prerequisite

The projection supports explicit external prerequisites.

For a BPF-style example, a kernel UAPI change may require a corresponding userspace/iproute2 proposition. The prerequisite remains a Proposition with support from an external evidence Object at the same Coordinate.

This deliberately tests whether `requires` can cross repository boundaries without introducing a repository-specific primitive.

## Read-only reconstruction

This PR must remain read-only with respect to Linux infrastructure.

The first corpus should be reconstructed from public historical facts and project documentation. Do not submit patches, email maintainers, mutate Patchwork state, or attempt to act as a maintainer.

The experiment asks:

> Given only public history and documented project rules, can Overcenter explain which deterministic prerequisites were satisfied, which evidence was stale or missing, and where human judgment remained irreducible?

## Hostile cases

At minimum cover:

- exact accepted history;
- public/legacy accepted state with missing exact evidence;
- explicit maintainer judgment absent;
- explicit maintainer rejection;
- superseding patch-series version;
- same patch contents against a different base commit;
- correct patch against the wrong subsystem tree;
- changed maintainer-authority source;
- stale review/test evidence from the prior series version;
- missing cross-repository prerequisite;
- architecture/config test evidence missing; and
- malformed/noncanonical public evidence.

## Required evidence

- [ ] A real public Linux patch history is reconstructed at an exact immutable source identity.
- [ ] The 4×4 projection adds no Linux-specific kernel primitive.
- [ ] Mechanical prerequisites are reproducible from public evidence.
- [ ] Missing human judgment is surfaced as judgment-required rather than inferred.
- [ ] A superseding patch revision cannot inherit stale support.
- [ ] Cross-repository prerequisites remain ordinary `requires/supports` relations.
- [ ] Legacy/public accepted state cannot manufacture missing exact evidence.
- [ ] Fresh exact-head Merge gate passes.

## Falsifiers

Treat any of these as a useful failure of the current architecture:

1. two materially different Linux admission worlds collapse to the same 4×4 representation but require different safe actions;
2. a required Linux rule cannot be expressed without adding a ninth primitive;
3. evidence cannot be bound tightly enough to patch-series/base/tree identity;
4. the model must predict maintainer taste to produce a safe result; or
5. cross-repository prerequisites require a separate semantic subsystem.

Do not repair a falsifier by hiding it behind domain-specific code.

## Deletion / generation ledger

```text
old owner: Azelficoast Stage 6 external-falsification adapter
new deterministic owner: Linux patch-history reconstruction boundary
4×4 relation/query: permittedEvents + unsupportedRequirements + staleSupports + stalePermissions
equivalence evidence: public Linux history plus hostile identity/revision cases
hostile invariant preserved: historical or legacy acceptance cannot manufacture current exact support
remaining agent judgment: design desirability and maintainer discretion
```

## Exact-head handoff

Files owned by Stage 6:

- `src/integrations/linux-patch-admission.ts`
- `test/linux-patch-admission-boundary.test.ts`
- this manifest

The existing branch name still contains `azelficoast-governance` because GitHub pull-request head branches cannot be retargeted in place. Treat the PR title and this manifest as authoritative.

## Stop condition

Stop if the experiment needs to encode maintainer taste, subsystem policy, or Linux-specific workflow nouns as new kernel primitives. Keep those facts above the kernel and record the counterexample if the existing relations are insufficient.

## Smallest next action

Select one real BPF or networking patch-series history with a superseding revision and nontrivial test/review evidence. Record immutable public source identities, project it through this adapter, and classify every disagreement before expanding the corpus.
