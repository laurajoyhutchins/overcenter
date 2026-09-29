# ADR-0011: Use a relational SQL model for architecture

- Status: Accepted
- Date: 2026-09-29

## Decision

Represent Overcenter architecture as three ordered SQL layers:

1. `architecture/concepts.sql` defines the implementation-independent architectural vocabulary.
2. `architecture/logic.sql` declares the desired architecture using that vocabulary.
3. `architecture/physics.sql` binds the desired architecture to the current repository realization.

Treat the resulting database as a declarative architecture model that deterministic software can query for reconciliation, trust-root derivation, assurance impact, and evidence planning.

The relational model does not replace the durable project-authority store. Project lifecycle truth continues to come from admitted durable facts, authoritative observation, verification, and settlement.

## Evidence

The current implementation already uses the relational model for four concrete purposes:

- `src/architecture/sql-model.ts` loads the model and enforces referential integrity;
- `src/architecture/reconciliation.ts` compares declared architecture with observed repository facts;
- `src/architecture/tcb.ts` derives trust roots, runtime dispatch bindings, and assurance-property composition from the model;
- `src/architecture/change-planner.ts` derives affected assurance properties and a minimum declared evidence cover for semantic changes.

Repository observation independently recovers source symbols, workflow principals, provider capabilities, effect invocations, transitive effect reachability, and unresolved dynamic calls. Therefore the SQL is not accepted as self-certifying documentation.

## Boundaries

The three files have different naming authority.

`concepts.sql` may define only reusable architectural concepts and relations. It must not contain current paths, provider names, workflow names, or implementation bindings.

`logic.sql` may name semantic authorities, effects, obligations, capabilities, evidence classes, and assurance properties. It must not bind them to current files, symbols, or execution principals.

`physics.sql` is the only layer that binds logical meaning to the current repository realization.

Changing the architecture model is itself an architecture-affecting repository change and therefore conservatively invalidates all declared assurance properties for change planning.

## Rejected alternatives

### Prose as the architecture authority

Prose remains necessary for explanation, but it is a poor substrate for deterministic reconciliation, transitive queries, impact analysis, and exact review of architecture changes.

### One unconstrained SQL file

A single schema/data file would blur the distinction between vocabulary, desired design, and current realization. That would make a source rename look too similar to an architectural policy change.

### Generate the model entirely from source

Source observation can establish current structure but cannot infer desired architecture, intended authority boundaries, or which assurance properties are supposed to compose. Observation is evidence about realization, not the owner of architectural intent.

### Store current project lifecycle state in the architecture database

That would create a second authority system. The relational model describes architecture; the authority kernel owns project transitions and derived project state.

## Consequences

Architecture changes become ordinary reviewable data changes. Deterministic software can ask which effects depend on which authorities, which implementation symbols realize those capabilities, and which evidence obligations are affected by a candidate source change.

The cost is model drift risk. Overcenter therefore must continue to expand independent observation and fail closed on missing, unexpected, or unresolved architectural facts rather than treating the SQL declaration as proof.

## Revisit when

Revisit this decision if the relational model cannot express a required architectural invariant without embedding procedural logic, if reconciliation cannot independently observe the relationships on which safety depends, or if another representation provides the same queryability and separation of concepts, intent, and realization with a smaller trusted surface.
