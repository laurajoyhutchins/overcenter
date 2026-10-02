# Lean settlement micro-verifier

This experiment checks the generic settlement decision owned by `projectReceipt()` without adding Lean to runtime execution.

The TypeScript driver builds real current observations and derives the same semantic facts that the production function consumes indirectly:

- postcondition asserted;
- accepted authoritative absence;
- unresolved effect requires replay safety;
- replay safety supported by the registered adapter policy.

It then calls the live `projectReceipt()` implementation and emits small Lean obligations against an independent settlement kernel.

Coverage is limited deliberately to generic settlement. Source-integration evidence binding remains outside this experiment because it has additional source-specific authority semantics.

Current reachable cases include final and eventually-consistent file observations across present, corrupt-present, absent, and uncertain outcomes, each with and without an unresolved reservation, plus judgment-required, execution-terminated, effect-not-dispatched, and source-retry receipts.

A hostile control flips one production result and must be rejected by Lean.
