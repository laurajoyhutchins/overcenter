# TLA+ recovery micro-verifier

This experiment derives recovery guards from the live possible-world planner and checks their temporal consequences.

The production probe establishes:

- ambiguous outcome -> reconcile only;
- known success -> settle;
- known not-dispatched -> retry;
- success or retry evidence from a stale coordinate -> reconcile only.

TLC then explores observation, coordinate rotation, retry, settle, and reconcile. The safety invariant forbids retry/settle when the effect outcome is ambiguous or the evidence coordinate is stale.

Two negative controls independently disable ambiguity protection and exact-coordinate protection; each must produce a concrete unsafe-action trace.
