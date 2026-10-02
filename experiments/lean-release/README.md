# Lean release micro-verifier

This experiment replaces source-shape recognition of `releaseEffectReservation()` with executable production cases and a tiny Lean decision kernel.

The production driver uses the real SQLite-backed kernel and the real GitHub fresh-HTTPS pre-secure-connect witness path. It checks:

- a valid one-shot trusted witness releases the reservation to READY;
- no reservation fails before witness use;
- untrusted provenance fails closed;
- every exact attempt-binding coordinate is enforced;
- a trusted witness with the wrong provider request path is rejected by adapter policy;
- denied releases preserve the unresolved reservation.

The Lean kernel owns only the consequential composition and error precedence of those release guards. A flipped valid-release result is a mandatory negative control.

Current execution authority and RUN_NOT_EXECUTING fencing remain covered by the admission micro-verifier and existing kernel tests; this experiment targets the release-specific semantics the legacy source contract still mirrors.
