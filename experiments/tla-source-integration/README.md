# TLA+ source-integration micro-verifier

This experiment couples source-integration temporal safety to the live deterministic settlement predicate and real kernel retry behavior.

Production probes establish:

- source settlement requires an unresolved reservation;
- work must be source-change / source-integration / source-integration-v1;
- evidence must bind to exact run, obligation key, and source revision;
- source retry succeeds only after the unresolved reservation is clear.

TLC explores reserve, work/evidence corruption, source settlement, and retry. It forbids settlement without the exact reservation/work/evidence coordinate and retry while a prior source effect remains unresolved.

Four hostile controls disable each guard independently and must produce an unsafe-action trace.
