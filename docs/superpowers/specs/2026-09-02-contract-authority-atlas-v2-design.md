# Contract Authority Atlas v2 Design

## Goal

Turn the generated contract authority atlas from an authority/projection index into a mechanically generated architecture map that can trace evidenced relationships between logical contracts without inventing source-level consumers or call graphs.

## Design

Contract classification metadata gains two independent concepts:

- `lifecycle`: `current`, `compatibility`, `deprecated`, or `deletion-candidate`.
- `relationships`: ordered-independent edges shaped as `{ kind, target }`, where `kind` is one of `consumes`, `produces`, `persists-as`, `derives-from`, `verified-by`, or `compatibility-for`, and `target` is another logical-contract id.

These fields are valid only on non-projection authority classifications. Relationship targets must resolve to classified logical contracts, self-relationships are rejected, and duplicate edges collapse deterministically. Missing lifecycle metadata remains visibly unclassified rather than defaulting to `current`.

The resolved catalog stores lifecycle and relationships on each logical contract, separate from authority significance. The renderer derives both outgoing and incoming views from those edges and emits a deterministic global flow index before the per-contract authority/projection detail.

## First proof path

Atlas v2 will classify only relationships we intentionally assert for the existing `project.advance` architecture:

- `project.advance.runtime-host` consumes `project.advance.input`.
- `project.advance.runtime-host` consumes `execution.authority.project-transition`.
- `project.advance.runtime-host` consumes `compact.execution-state.store`.
- `project.advance.runtime-host` produces `execution.evidence`.
- `compact.execution-state.store` persists-as `compact.execution-state`, `compact.operation-state`, and `compact.proof-state`.

Those contracts receive lifecycle `current`. Existing contracts without lifecycle evidence remain `unclassified`; no bulk lifecycle guess is allowed.

## Non-goals

- Static call-graph inference.
- Guessing consumers from names or imports.
- Replacing authority/projection relationships.
- Reclassifying all historical contract debt.
- Rendering a graphical dependency diagram.

## Verification

Tests must prove invalid lifecycle/relationship metadata fails closed, missing targets fail closed, relationship ordering is deterministic, incoming edges are mechanically reversed from outgoing evidence, and the committed atlas remains byte-identical to regeneration in CI.
