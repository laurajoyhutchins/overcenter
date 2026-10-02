# Lean source-integration micro-verifier

This experiment exhausts the live source-integration settlement predicate over all 128 valuations of its seven consequential guards:

- unresolved reservation exists;
- source-change work kind;
- source-integration effect contract;
- source-integration verifier;
- evidence run id;
- evidence obligation key;
- evidence source revision.

The TypeScript driver calls `sourceIntegrationSettlementError()`; the tiny Lean kernel independently checks the accepted condition and error precedence.

A flipped accepted case is the mandatory negative control.
