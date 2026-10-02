# TLA+ effect-admission temporal micro-verifier

This experiment gives TLA+ a deliberately different job from the Lean effect-admission oracle.

Lean checks the logical composition of one admission decision. TLC attacks the short history around that decision: authority rotation, permit refresh, reservation, and dispatch.

The TypeScript driver calls the real `effectAdmissionDecision()` to derive two production guard facts:

- stale execution authority is rejected;
- an unresolved effect reservation blocks another reservation.

Those facts become TLC model constants. The TLA+ model then explores every bounded interleaving for two workers and two authority generations.

The accepted model must preserve:

- `NoStaleReservation`;
- `NoDuplicateReservation`;
- `NoDoubleExecution`.

Two hostile controls are mandatory: disable the unresolved-effect guard and TLC must produce a duplicate-reservation counterexample; disable the authority fence and TLC must produce a stale-reservation counterexample.

TLC is not a production dependency. This is semantic-change evidence intended for an agent edit/check loop.

Local measurements on the agent VM with TLC 1.7.4 and Java 21:

- cold CLI: roughly 0.7-0.8 s for this model;
- 34 distinct states in the accepted model;
- warm JVM with a fresh isolated TLC classloader per check: about 89 ms median over 30 mixed accepted/rejected checks.

The classloader worker is intentionally not part of this PR. The first question is whether the temporal seam is useful enough to retain, not whether performance plumbing should become architecture.
