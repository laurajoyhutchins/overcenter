# Lean effect-admission micro-verifier

This experiment tests whether Lean can be useful at a real Overcenter semantic boundary without becoming a production control-plane dependency.

The production implementation remains `effectAdmissionDecision()`. The experiment independently projects its nine exact-identity comparisons plus the unresolved-effect bit into a closed 10-bit guard surface. A tiny Lean kernel owns only the semantic combination of those guards and the denial precedence:

```text
nine exact identity guards
          +
  unresolved-effect bit
          |
          v
   Lean admissionDecision
   /        |          \
permit   stale     unresolved
```

`experiment.ts` constructs real `Run` and `ExecutionPermit` values, calls the production TypeScript function, exhausts all 2^10 guard combinations, and emits Lean obligations requiring the canonical kernel to produce the same decision. It then flips one known-permitted case and requires Lean to reject the lie.

This deliberately preserves ADR-0006's production boundary: no replay, admission, settlement, or execution path depends on Lean. The intended use is semantic-change verification and an agent edit/check loop. Primitive string/digest equality stays deterministic software; Lean checks the consequential composition where omitting one guard would change whether an effect can be dispatched.

Run with Lean 4.19.0 on `PATH`:

```bash
node --experimental-strip-types experiments/lean-effect-admission/experiment.ts
```

On the agent VM used to build the experiment, the exhaustive 1,024-case cold run passed with the hostile flip rejected. A persistent direct Lean worker checking one guard obligation took roughly 4-6 ms per edit; those timings are diagnostic measurements, not an acceptance threshold.
