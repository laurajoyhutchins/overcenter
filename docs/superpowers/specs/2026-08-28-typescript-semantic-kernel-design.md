# TypeScript Semantic Kernel Design

Issue: #236

## Decision

TypeScript is the authoring language for Overcenter semantic contracts and domain states where static checking prevents invalid combinations. Runtime validation remains authoritative for external JSON, durable rows, revisions, leases, and other world-state facts. Thin API/MCP deployment adapters may remain JavaScript.

## First proof slice

1. Move the canonical command registry into one typed source without creating a second registry.
2. Introduce branded semantic identities for values that must not be accidentally interchanged.
3. Model project-graph executor and phase-input alternatives as discriminated unions.
4. Keep existing runtime behavior and runtime validators intact.
5. Prove the exact Hatchable verification path accepts a TypeScript-backed shared module before expanding the migration.

## Non-goals

- No blanket JavaScript-to-TypeScript conversion.
- No generated source mirror.
- No replacement of runtime validation with static types.
- No new workflow DSL, planner, or generic schema framework.
- No manually synchronized command registry.