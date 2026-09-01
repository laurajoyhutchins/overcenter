# TypeScript Semantic Kernel Design

> **Document status: Accepted design decision.** The TypeScript authoring/materialization direction remains relevant, but exact current runtime behavior is defined by repository source and executable contracts. This is not a command reference.

Issue: #236

## Decision

TypeScript is the authoring language for Overcenter semantic contracts and domain states where static checking prevents invalid combinations. Runtime validation remains authoritative for external JSON, durable rows, revisions, leases, and other world-state facts. Thin API/MCP deployment adapters remain JavaScript.

## Runtime constraint discovered during proof

Hatchable accepts `.ts` paths in `lib/`, but its current project-file admission path does not transpile TypeScript syntax. A normal typed declaration such as `export const value: string = 'ok'` is rejected before save, while the same `.ts` file containing only JavaScript syntax is accepted. The exact-revision V8 verifier reproduced the same boundary when `lib/*.ts` first entered the candidate revision.

Therefore authoritative TypeScript source lives under `src/semantic/`, outside the GitHub -> Hatchable synchronized runtime tree. Runtime-bearing semantic modules are mechanically emitted as plain JavaScript under `lib/`; CI regenerates them and requires a byte-for-byte diff match. Type-only modules do not get pointless runtime mirrors.

This is a deployment materialization boundary, not a second hand-maintained implementation. Hatchable platform feedback #279 records the documentation/runtime mismatch.

## Proven first slice

The proof establishes the pattern on two high-value semantic islands:

1. **Canonical commands and semantic identities.** `RunId`, `LeaseId`, `WorkRef`, `GitSha`, and `IdempotencyKey` are distinct branded types. The canonical command list is a typed literal tuple that generates the runtime registry, and command-response tests consume the same registry instead of maintaining a second list.
2. **Project-graph structural normalization.** Executor alternatives, phase-input alternatives, node states, and phase-binding structures are statically modeled. Existing runtime normalization now passes through generated JavaScript emitted from the typed normalizers, preserving the original fail-closed validation behavior.

The compiler now rejects identity interchange, unknown canonical command literals, operator/agent field mixing, ambiguous `from`+`literal` phase inputs, and unknown project node states.

## Verification

The proof requires all three gates on the same exact branch head:

- strict semantic TypeScript verification plus byte-for-byte generated-JavaScript comparison;
- the repository regression/public-release verification suite;
- exact-revision Hatchable V8 verification.

This combination proved that types add static guarantees without introducing an unverified source/runtime split.

## Decision after proof

**GO.** The pattern removed concrete invalid states and manual registry duplication without requiring broad casts, optional-property bags, a generic schema framework, or a blanket migration.

The next highest-value semantic island is execution authority, leases, and runs. That port should reuse the same parse-then-trust boundary, branded identities, generated-runtime materialization, and three-gate verification pattern before evidence/receipts are considered.

## Non-goals

- No blanket JavaScript-to-TypeScript conversion.
- No manually maintained generated mirror; emitted runtime JS must be mechanically checked against its TS source.
- No generated runtime file for type-only declarations.
- No replacement of runtime validation with static types.
- No new workflow DSL, planner, or generic schema framework.
- No manually synchronized command registry.