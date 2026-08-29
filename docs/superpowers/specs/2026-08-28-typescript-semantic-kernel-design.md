# TypeScript Semantic Kernel Design

Issue: #236

## Decision

TypeScript is the authoring language for Overcenter semantic contracts and domain states where static checking prevents invalid combinations. Runtime validation remains authoritative for external JSON, durable rows, revisions, leases, and other world-state facts. Thin API/MCP deployment adapters remain JavaScript.

## Runtime constraint discovered during proof

Hatchable accepts `.ts` paths in `lib/`, but its current project-file admission path does not transpile TypeScript syntax. A normal typed declaration such as `export const value: string = 'ok'` is rejected before save, while the same `.ts` file containing only JavaScript syntax is accepted. The exact-revision V8 verifier reproduced the same boundary when `lib/*.ts` first entered the candidate revision.

Therefore authoritative TypeScript source lives under `src/semantic/`, outside the GitHub -> Hatchable synchronized runtime tree. Runtime-bearing semantic modules are mechanically emitted as plain JavaScript under `lib/`; CI regenerates them and requires a byte-for-byte diff match. Type-only modules do not get pointless runtime mirrors.

This is a deployment materialization boundary, not a second hand-maintained implementation. Hatchable platform feedback #279 records the documentation/runtime mismatch.

## First proof slice

1. Introduce branded semantic identities for values that must not be accidentally interchanged.
2. Type canonical command admission with a parse-then-trust boundary without creating another command registry.
3. Model project-graph executor and phase-input alternatives as discriminated unions.
4. Keep existing runtime behavior and runtime validators intact.
5. Prove generated JavaScript materialization passes the exact Hatchable V8 path before expanding the migration.

## Non-goals

- No blanket JavaScript-to-TypeScript conversion.
- No manually maintained generated mirror; emitted runtime JS must be mechanically checked against its TS source.
- No generated runtime file for type-only declarations.
- No replacement of runtime validation with static types.
- No new workflow DSL, planner, or generic schema framework.
- No manually synchronized command registry.