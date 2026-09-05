# Outcome Integrity

Status: architecture contract, v0

## Decision

**A valid execution graph is not sufficient evidence of a valid plan.**

Overcenter already answers an important execution question: given authoritative project facts, what obligations exist, which prerequisites are satisfied, what work is executable now, who is authorized to act, and what evidence is required to settle the resulting transition?

Outcome Integrity addresses a different question:

> If every declared obligation succeeds according to its local contract, do those successes actually establish the intended project outcome?

Outcome Integrity is a revision-bound, read-only assurance layer over the authoritative project graph and its evidence. It does not replace the obligation graph, introduce a second plan authority, or turn reasoning-agent judgment into execution truth.

The standing boundary remains:

> Reasoning agents should make judgments; deterministic software should own execution correctness.

For Outcome Integrity, this means deterministic software owns mechanically checkable identities, graph relationships, authority binding, stale-review invalidation, evidence coordinates, and objective lint rules. Reasoning agents may judge whether a decomposition is sufficient, discover missing work, construct counterexamples, or challenge evidence. Those judgments remain non-authoritative until accepted through the existing project-authoring boundary.

## Terminology boundary

This contract deliberately does **not** overload the existing terms **obligation semantic content**, **semantic key**, or **semantic fingerprint**.

Those terms describe identity: which execution-relevant facts make an obligation or graph mean the same thing for purposes such as evidence reuse, stale-work detection, and concurrent amendment.

Outcome Integrity describes sufficiency: whether the obligations, assumptions, evidence, and reasoning represented by the current authoritative project state are enough to establish the intended outcome.

A graph may therefore have perfectly stable semantic identity and still have poor Outcome Integrity. Conversely, an Outcome Integrity review may become stale because the exact authoritative revision changed even when a later semantic-identity mechanism can eventually prove that the reviewed meaning did not.

## Three conceptual planes

Outcome Integrity distinguishes three planes without requiring three independently stored graph databases.

```text
OUTCOME PLANE

              root outcome claim
                      ^
                      |
                argument step
              /       |       \
          claim     claim     claim
             ^         ^         ^
             |         |         |
             +---- realized by --+

EXECUTION PLANE

          authoritative obligations
             |         |         |
             +---- execute work --+
                      |
                      v

EVIDENCE PLANE

        exact tests / observations /
        artifacts / authority facts
                      |
                      +---- support claims
```

Assumptions and context may feed claims or argument steps. Defeaters may challenge claims, argument steps, assumptions, or evidence.

This separation matters because an execution dependency is not automatically a logical justification. `A requires B` says that B must be satisfied before A may execute under the current all-of workflow contract. It does not, by itself, say why B and A are jointly sufficient to establish a parent project outcome.

## Outcome argument vocabulary

### Claim

A claim is a proposition that the project intends to establish or rely upon, such as:

- a fresh disposable agent can execute the leased transition from the returned packet alone;
- the deployed runtime corresponds to the exact verified source revision;
- an old compatibility path is no longer reachable;
- mixed-version operation preserves the required compatibility contract.

A claim is not automatically authoritative because a model stated it. Its status depends on exact evidence, accepted project meaning, and the argument in which it participates.

### Argument step

An argument step explains why one or more premises support a conclusion.

```text
premise claim A ----\
                     >--- argument step ---> conclusion claim
premise claim B ----/
```

The step preserves information that a bare dependency edge cannot express: whether premises are jointly sufficient, alternative realizations, a domain-specific refinement strategy, or another explicit basis for the conclusion.

Outcome Integrity v0 may infer provisional argument steps from existing project intent, obligation structure, acceptance evidence, and architecture contracts. It does not require every project definition to author a first-class argument-step schema.

### Evidence

Evidence is an authority-bound fact used to support a claim. Useful evidence identifies, as applicable:

- the exact subject it describes;
- the exact repository or runtime revision;
- the environment or execution identity under which it was produced;
- the authority that owns the observed fact;
- the claim the evidence is intended to support.

`tests passed` is weaker than `these tests passed for revision X and exercise the behavior asserted by claim Y`.

### Assumption

An assumption is a truth needed by the outcome argument but not established by the project graph itself. Important assumptions must be explicit enough to identify their owner or authoritative observation rather than hiding inside prose or agent memory.

### Defeater

A defeater is a structured challenge to an outcome argument. It may attack:

- a claim: the proposition may be false or too strong;
- an argument step: the conclusion may not follow from the premises;
- an assumption: the assumed fact may be false, stale, unowned, or stronger than necessary;
- evidence: the evidence may be valid but insufficient for the claim attributed to it.

A reasoning agent may discover a defeater. Discovery does not itself mutate the graph, invalidate a lease, or establish project truth. Deterministic policy or an explicitly accepted judgment decides whether the finding becomes a blocker, an amendment, or an advisory concern.

### Proof obligation

Reserve **proof obligation** for a relationship with a mechanically checkable condition. A model-generated narrative is an argument or finding, not a formal proof merely because it is persuasive.

## Local transition meaning and project outcome meaning

A useful conceptual model for one executable obligation is Hoare-like:

```text
{ prerequisites + authoritative assumptions }
                  work
{ established postconditions }
```

or, compactly:

```text
P  -- W -->  Q
```

This clarifies the boundary between local execution correctness and project sufficiency.

Overcenter may prove that work `W` executed under the correct authority, that prerequisites `P` held, and that exact evidence establishes postcondition `Q`. That still does not prove that `Q` is sufficient for the project outcome. Outcome Integrity examines the composition from established leaf claims through explicit or inferred argument steps to the root outcome.

## Outcome Integrity invariants

The long-term Outcome Integrity contract should make the following properties inspectable. v0 may implement only the mechanically available subset.

### Coverage

Every important root-outcome condition has a traceable realization, authoritative assumption, or explicitly unresolved obligation. Missing work must not disappear merely because no node named it.

### Refinement sufficiency

When child claims are presented as establishing a parent claim, the argument must explain why those premises are sufficient. A structurally valid decomposition is not automatically a semantically sufficient one.

### Evidence adequacy

Evidence attached to a claim must demonstrate that claim rather than an adjacent or weaker fact.

### Non-vacuity

It must not be possible for every declared acceptance criterion to pass while the intended claim remains false merely because the acceptance criteria failed to exercise the important behavior.

### Consistency

Sibling claims and implementation strategies that jointly support an outcome must be capable of being true at the same time. Incompatible strategies must not silently compose into an apparently complete plan.

### Assumption completeness

Important truths not produced by the graph are explicit, bounded, and tied to an owner or authoritative observation when one exists.

### Authority binding

A review identifies the exact authoritative graph and evidence it assessed. Evidence about object X may support a claim about X only within the identity closure that the evidence actually describes.

### Contribution traceability

Executable work should trace upward to an intended outcome. A transition that establishes no useful claim or contributes to no relevant outcome is candidate orphan work even if it can execute successfully.

### Semantic acyclicity

The justification of a claim must not ultimately depend on itself. The execution DAG can be acyclic while the outcome argument is circular.

### Constraint preservation

A locally successful plan is not sufficient if it satisfies the requested feature by violating an accepted project constraint or non-goal.

### Change invalidation

A changed authoritative revision creates a new review subject. v0 treats a prior Outcome Integrity assessment as stale by default. A later optimization may reuse an assessment only when deterministic semantic identity proves that every relevant reviewed meaning and evidence binding is unchanged.

## Deterministic analysis versus reasoning judgment

Outcome Integrity intentionally divides work by what can be known mechanically.

Deterministic software can detect facts such as:

- a required claim has no known producer or explicit authoritative assumption;
- a transition contributes to no known outcome or horizon;
- an evidence requirement points to no claim or exact subject;
- a required assumption lacks authority coordinates where authority is required;
- a semantic justification cycle exists;
- an exact review identity no longer matches the authoritative graph;
- declared all-of proof closure is structurally impossible;
- a typed contradiction is mechanically provable.

Those rules may become hard gates when the violation is objective and the policy is explicit.

Reasoning agents are useful for questions such as:

- are these child claims actually sufficient for the parent outcome?
- is an acceptance criterion meaningful rather than vacuous?
- what important work or assumption is absent from the graph entirely?
- does this test really establish backward compatibility?
- are sibling changes architecturally incompatible despite local validity?
- can every transition succeed while the root outcome remains false?

Reasoning output is analysis. It must not be represented as an authoritative `semantically_valid: true` or `false` bit.

## Review protocol

Outcome Integrity review should be dialectical rather than confirmation-seeking.

### 1. Construct

Produce the strongest short derivation from authoritative premises and established leaf claims to the selected root outcome. Record the argument steps needed for each inference.

### 2. Challenge

Identify inferential leaps: conclusions whose support is absent, ambiguous, weaker than stated, or dependent on hidden context.

### 3. Falsify

Apply the principal semantic counterexample test:

> Assume every transition succeeds exactly according to its declared acceptance criteria and every required piece of evidence is present. Construct a coherent world in which the root outcome is nevertheless false.

A successful counterexample demonstrates an outcome-sufficiency gap even when workflow execution is structurally sound.

### 4. Attack evidence

Look for evidence that is fresh and valid but does not establish the claim attributed to it: wrong subject, wrong revision, wrong behavior, insufficient coverage, or a weaker neighboring fact.

### 5. Attack assumptions

Make hidden assumptions explicit and challenge whether they are current, owned, necessary, and no stronger than the evidence supports.

### 6. Rebut

Attempt to defeat each proposed finding using the exact authoritative graph and evidence. Do not preserve a finding merely because a first reviewer proposed it.

### 7. Preserve the residual

If the remaining argument cannot be established or refuted, preserve the uncertainty rather than forcing a verdict.

For review-level communication, the useful conceptual states are:

- `ESTABLISHED`: the reviewed argument closes under the available exact evidence and applicable deterministic rules;
- `REFUTED`: authoritative evidence or a valid counterexample disproves the reviewed claim or inference;
- `UNRESOLVED`: support is missing, stale, ambiguous, or challenged by an unrebutted defeater.

These are review states, not additions to the Overcenter transition lifecycle.

## Exact review identity

An Outcome Integrity assessment is useful only when its subject is unambiguous. v0 should bind a review to at least:

```text
project_ref
repository identity
exact authority revision
project graph derivation contract/version
review contract/version
selected horizon or root outcome
exact evidence/observation coordinates used by the argument
```

A graph revision change invalidates the review by default. The same rule applies when an external evidence coordinate changes. Reuse across revisions is an optimization that requires deterministic proof of relevant semantic equivalence; it is never inferred from similar prose or model confidence.

This extends Overcenter's broader exact-identity principle: evidence and judgment about object X do not silently authorize or establish claims about a later object that merely occupies X's old mutable name.

## Authority and mutation boundary

Outcome Integrity is read-only analysis over authoritative current state.

A deterministic finding or reasoning-agent defeater can recommend a missing obligation, stronger evidence requirement, explicit assumption, or different refinement. It cannot write those facts into project truth itself.

Accepted repairs flow through the existing authoring boundary:

```text
Outcome Integrity review
        |
        v
structured finding / proposed repair
        |
        v
accepted judgment
        |
        v
project.amend / project.define
        |
        v
fresh authoritative graph readback
```

The new revision is a new review subject. Existing leases, settlement rules, evidence receipts, and semantic-conflict handling remain owned by their current contracts.

## Schema-light v0

Do not begin by requiring every project to author a full logical model containing `claims`, `refinements`, `establishes`, `evidence_for`, `assumes`, `constraints`, proof objects, logical operators, and counterexamples.

Outcome Integrity v0 should first infer a provisional outcome argument from information Overcenter already possesses, including:

- project or horizon intent;
- transition execution intent;
- `requires` relationships;
- acceptance-evidence requirements;
- current exact evidence and observations;
- authoritative architecture and project contracts.

Repeated review findings should reveal which missing relationships deserve first-class representation. Likely early candidates include:

- `establishes`: what becomes true when an obligation succeeds;
- `assumes`: required external truth not produced by the graph;
- `evidence_for`: an explicit relation between evidence and the claim it demonstrates.

Those fields should be added only when they unlock deterministic value and can participate safely in graph identity, authoring, execution packets, and stale-evidence rules.

## Outcome Integrity v0 implementation slice

The first implementation should be deliberately small:

1. extend authoritative read-only project inspection rather than introduce a mutable Outcome Integrity subsystem;
2. bind the inspection to exact revision, graph derivation identity, review-contract version, and selected root/horizon;
3. run deterministic objective checks over the inferred outcome argument;
4. support a positive derivation pass and the semantic-counterexample/falsification pass;
5. return structured non-authoritative findings, defeaters, and unresolved obligations;
6. make stale-review invalidation mechanical;
7. route every accepted repair through existing project authoring and exact readback.

It must not introduce a second graph database, second evidence store, new execution lifecycle, or LLM-owned plan truth.

## Semantic mutation benchmark

Outcome Integrity should be improved empirically rather than by asking whether reviews "look smart."

Start from known-good structurally valid project graphs and create semantic mutants that preserve workflow validity while damaging outcome sufficiency. Useful mutations include:

- delete a required obligation;
- weaken acceptance evidence;
- remove or hide an assumption;
- change a refinement from all-of to any-of or otherwise weaken sufficiency;
- attach valid evidence to the wrong claim;
- insert irrelevant executable work;
- introduce incompatible sibling strategies;
- create circular semantic justification;
- reuse a review at a different exact revision;
- preserve every leaf success while making the root outcome false.

The review should "kill" these mutants by identifying the planted defect without inventing unrelated blockers.

Measure at least:

- planted-defect recall;
- finding precision;
- false-blocker rate;
- counterexample validity;
- correct claim/argument path;
- minimal missing-obligation accuracy;
- repair minimality;
- stability under meaning-preserving paraphrase where reasoning review is involved;
- revision-binding correctness.

Benchmark results are verification evidence for the review implementation. They are not project authority.

## Research lineage

Outcome Integrity is a synthesis of prior ideas rather than a claim that Overcenter invented argument-based assurance.

- **Assurance cases, GSN, and CAE** motivate explicit claims, decomposition strategies, context, assumptions, and evidence rather than treating a dependency tree as self-justifying.
- **Assurance 2.0** motivates active negative examination and explicit defeaters in addition to positive support, closely matching the construct/challenge/falsify/rebut protocol above.
- **Hoare-style program logic** motivates the local precondition/work/postcondition model and the distinction between locally established postconditions and higher-level outcome claims.
- **HTN planning semantics** motivates giving decomposition an inspectable method or strategy rather than assuming that an executable task hierarchy is a correct refinement.
- **Petri-net and workflow soundness** motivates keeping structural execution correctness distinct from domain-level outcome sufficiency. A process can be deadlock-free and properly terminating while still implementing the wrong plan.
- **Proof-carrying systems** motivate carrying independently checkable support with work while also warning against calling uncheckable narrative a proof.
- **Runtime verification** motivates preserving `UNRESOLVED` when observations are incomplete rather than coercing ambiguity into success or failure.
- **Provenance systems such as W3C PROV** motivate tracing evidence to the entities, activities, and authorities that produced it.
- **Overcenter's exact-identity, fencing, lease, and mutable-reference research** strengthens the assurance model by requiring every review and evidentiary claim to remain bound to the exact execution identity it actually describes.

This research guides the design. It does not become project-state authority merely because it is cited here.

## Relationship to Chirograph

Chirograph may later provide evidence beneath Outcome Integrity where a leaf claim depends on agreement among multiple contract representations such as implementation, schemas, generated clients, documentation, tests, and runtime behavior.

The intended boundary is:

```text
Chirograph:
  do the representations consistently express the claimed contract?

Overcenter Outcome Integrity:
  assuming those leaf claims are established, do they compose into the intended project outcome?
```

Outcome Integrity v0 does not require a Chirograph dependency.

## Non-goals

Outcome Integrity v0 is not:

- a theorem prover;
- a GSN diagram editor;
- a universal project checklist;
- a second project-plan database;
- an agent-maintained shadow graph;
- a second evidence store;
- a replacement for workflow soundness or lifecycle evaluation;
- a replacement for leases, fencing, settlement, or receipts;
- permission for an LLM to declare a project semantically valid;
- a requirement that every project immediately author a complete claim/refinement schema.

The architectural target is narrower:

> A project graph should carry, or allow Overcenter to derive, an inspectable revision-bound argument for why successful execution is sufficient for the intended outcome, while keeping judgment non-authoritative and execution correctness deterministic.
