# ADR-0011: Use a relational SQL model for architecture

- Status: Accepted
- Date: 2026-09-29

## Decision

Represent Overcenter architecture in three SQL layers:

1. `architecture/concepts.sql` defines the architecture vocabulary.
2. `architecture/logic.sql` describes the intended architecture.
3. `architecture/physics.sql` maps that architecture to the current repository.

The resulting database is used for reconciliation, trust-root derivation, assurance impact analysis, and evidence planning.

It is not a second authority store. Project state still comes from durable facts, observation, verification, and settlement.

## Why

The implementation already needs to answer questions that are awkward to maintain in prose or duplicated configuration:

- Which effects depend on which authorities and capabilities?
- Which symbols implement those capabilities?
- Which assurance properties compose with others?
- Which evidence obligations are affected by a source change?
- Does the current repository still match the architecture we intended?

A relational model makes those relationships explicit and queryable.

The current implementation uses it in four places:

- `src/architecture/sql-model.ts` loads the model and checks referential integrity.
- `src/architecture/reconciliation.ts` compares the declared model with observed repository facts.
- `src/architecture/tcb.ts` derives trust roots, dispatch bindings, and assurance-property composition.
- `src/architecture/change-planner.ts` derives assurance impact and the evidence required by the declared model.

Repository observation remains independent of the SQL declaration. The model says what should exist; observation checks what the code and workflows actually expose.

## Layer boundaries

`concepts.sql` contains reusable concepts and relations. It does not name repository paths, providers, workflows, or implementation symbols.

`logic.sql` may name semantic authorities, effects, obligations, capabilities, evidence classes, and assurance properties. It does not bind them to source files or runtime principals.

`physics.sql` contains the current implementation mapping.

If any architecture SQL file changes, change planning treats all assurance properties as affected. That is intentionally conservative because the dependency model used to calculate impact has changed.

## Alternatives considered

### Prose only

Prose is useful for explanation, but poor at exact reconciliation, transitive queries, and impact analysis.

### One SQL file

A single file would mix vocabulary, design intent, and current implementation details. Keeping them separate makes review easier: a source rename should not look like a policy change.

### Generate everything from source

Source analysis can recover implementation structure, but it cannot determine intent. It cannot tell us which authority boundaries or assurance relationships the system is supposed to have.

### Store lifecycle state here

That would create competing sources of project truth. The architecture database describes the system; the authority kernel owns project transitions.

## Consequences

Architecture changes are explicit, reviewable data changes, and the same model can support reconciliation and change planning.

The main risk is model drift. The repository therefore needs independent observation and should report missing, unexpected, or unresolved facts rather than treating the SQL declaration as proof.

## Revisit when

Revisit this decision if important invariants cannot be expressed without procedural logic, if the relationships needed for safety cannot be observed independently, or if another representation provides the same separation and queryability with a smaller trusted surface.
