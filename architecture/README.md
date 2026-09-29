# Relational architecture model

Overcenter represents its intended architecture as three ordered SQL layers:

```text
concepts.sql  ->  logic.sql  ->  physics.sql
vocabulary       desired         repository
                 architecture    realization
```

The model is declarative. It describes architectural meaning and the current implementation binding; it does not replace the durable project-authority history or make a SQL row authoritative project state.

## Layers

### `concepts.sql`

Defines the implementation-independent language of architecture: authorities, effects, obligations, evidence, capabilities, assurance properties, artifacts, symbols, principals, and the relations among them.

This layer must not name repository paths, provider products, workflow names, or current implementation symbols.

### `logic.sql`

States what Overcenter intends to remain true independent of the current code layout. It instantiates the conceptual vocabulary with logical authorities, effects, capabilities, obligations, evidence classes, and assurance properties.

This layer may name semantic provider operations when they are part of the supported architecture, but it must not bind those meanings to source paths, workflow jobs, or implementation symbols.

### `physics.sql`

Binds the logical architecture to the current repository revision. It may name source artifacts, symbols, workflows, jobs, runtime principals, provider operations, and concrete implementation relationships.

A physics row is a declared realization claim. It is not accepted merely because it exists in SQL.

## Loading and reconciliation

`src/architecture/sql-model.ts` loads the three files in order into one in-memory SQLite database and fails closed on foreign-key violations.

The repository then observes mechanically recoverable implementation facts and reconciles them against the declared physical model:

```text
declared architecture
        +
observed repository structure
        |
        v
missing / unexpected / unknown findings
```

`scripts/observe-architecture.ts` currently observes declared artifacts and symbols plus GitHub Actions principals, write capabilities, direct provider invocations, transitive effect reachability, and unresolved dynamic effect calls.

`src/architecture/reconciliation.ts` compares those observations with the relational model. Missing and unexpected facts are discrepancies. An unresolved effect call is reported as `unknown`; uncertainty is never silently converted into compliance.

Run:

```sh
npm run check:architecture-reconciliation
```

## Change planning

The same model supplies assurance impact information for repository changes.

`scripts/plan-semantic-change.ts`:

1. resolves an exact base revision and checked-out head revision;
2. derives the observed semantic artifact delta;
3. maps changed implementation artifacts through runtime dependency closure to affected assurance properties;
4. follows assurance-property composition;
5. derives guarded effects and obligations;
6. selects a minimum evidence cover for those obligations.

A change to any of the three architecture SQL files conservatively affects every declared assurance property because the model that defines the dependency relation itself changed.

The planner distinguishes the expected write set from the actual staged semantic delta. `admitObservedSemanticDelta()` accepts only exact agreement. Missing or unexpected artifacts return `REPLAN_REQUIRED` with reason `SEMANTIC_TRANSACTION_DIVERGED`.

This gives repository work a transaction-shaped boundary:

```text
proposed semantic change
        |
        v
expected write set
        |
        v
stage candidate mutation
        |
        v
observe actual semantic delta
        |
        +-- differs --> replan
        |
        v
derive affected assurance properties
        |
        v
derive minimum sufficient evidence
```

"Minimum" is relative to the declared obligation-to-evidence relations. It does not prove that the architecture model captured every real dependency. Reconciliation, hostile tests, and independent proof mechanisms remain necessary.

## Authority rules

- `concepts.sql` owns vocabulary, not implementation policy.
- `logic.sql` owns desired architecture, not current source binding.
- `physics.sql` declares current realization, but observation can falsify it.
- Observed repository facts do not automatically rewrite the desired model.
- Generated plans are candidates for verification, not verification results.
- Current project truth remains derived from the durable authority kernel described in `ARCHITECTURE.md`.

See [ADR-0011](../docs/adr/0011-relational-architecture-model.md) for the architectural decision.
