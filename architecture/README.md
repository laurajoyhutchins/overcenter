# Relational architecture model

Overcenter describes its architecture in three SQL files:

```text
concepts.sql  ->  logic.sql  ->  physics.sql
vocabulary       intended       repository
                 design         mapping
```

Together they provide a queryable model of the system. They do not replace the authority store or determine project state.

## The three layers

### `concepts.sql`

Defines the vocabulary used by the model: authorities, effects, obligations, evidence, capabilities, assurance properties, artifacts, symbols, principals, and their relationships.

It stays implementation-independent. Repository paths, provider names, workflow names, and source symbols do not belong here.

### `logic.sql`

Describes the architecture Overcenter intends to preserve. It instantiates the concepts with the authorities, effects, capabilities, obligations, evidence classes, and assurance properties that matter to the system.

It may name supported semantic operations, but it does not bind them to files, symbols, or workflow jobs.

### `physics.sql`

Maps the logical model onto the current repository. This is where source files, symbols, workflows, jobs, runtime principals, and provider operations are named.

These mappings are claims about the implementation. The repository checks them against observed code and workflow structure rather than assuming they are correct.

## Loading and reconciliation

`src/architecture/sql-model.ts` loads the three files, in order, into an in-memory SQLite database and rejects foreign-key violations.

`scripts/observe-architecture.ts` then inspects the repository for facts that can be recovered from source and workflow configuration, including:

- declared artifacts and symbols;
- GitHub Actions jobs and write permissions;
- direct provider calls;
- transitive effect reachability; and
- dynamic calls whose effect target cannot be resolved statically.

`src/architecture/reconciliation.ts` compares those observations with `physics.sql`. Findings are reported as `missing`, `unexpected`, or `unknown`. An unresolved dynamic call stays unknown instead of being treated as compliant.

Run the check with:

```sh
npm run check:architecture-reconciliation
```

## Change planning

The architecture model also drives impact analysis for source changes.

`scripts/plan-semantic-change.ts` resolves an exact base and head revision, determines which artifacts changed semantically, follows runtime dependency closure, identifies the affected assurance properties, and derives the evidence obligations associated with those properties.

A change to any architecture SQL file is treated conservatively: because the dependency model itself changed, every declared assurance property is considered affected.

The planner also compares the expected write set with the staged semantic delta. `admitObservedSemanticDelta()` accepts an exact match. If the candidate changed fewer or more artifacts than planned, it returns `REPLAN_REQUIRED` with `SEMANTIC_TRANSACTION_DIVERGED`.

The resulting flow is:

```text
proposed change
    |
expected write set
    |
staged candidate
    |
observed semantic delta
    |
affected assurance properties
    |
required evidence
```

The evidence set is minimal only with respect to the relationships declared in the architecture model. Reconciliation and independent tests still matter because the model itself can be incomplete.

## Ownership

- `concepts.sql` defines the language.
- `logic.sql` defines the intended architecture.
- `physics.sql` maps that architecture to the current repository.
- Repository observation checks the physical mapping.
- The authority kernel remains the source of project truth.

See [ADR-0011](../docs/adr/0011-relational-architecture-model.md) for the design decision.
