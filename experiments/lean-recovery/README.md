# Lean recovery micro-verifier

This experiment checks the live possible-world recovery planner rather than its legacy shadow.

The TypeScript driver exhausts all 32 valuations of the five recovery relation bits and asks Lean to independently compute the preferred event:

- known postcondition assertion only -> settle;
- known retry-safe not-dispatched only -> retry;
- ambiguity, no terminal fact, or contradictory terminal facts -> reconcile.

Two stale-coordinate cases also require reconcile.

A deliberately flipped known-success result is the negative control.

The experiment is intended to justify deleting `legacyRecoveryEvent()`, `shadowRecoveryRouting()`, and the duplicated shadow-equivalence tests, while preserving direct possible-world and stale-coordinate behavior tests.
