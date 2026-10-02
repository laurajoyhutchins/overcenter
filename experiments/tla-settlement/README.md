# TLA+ settlement micro-verifier

This experiment derives temporal settlement guards from the live Overcenter kernel and model-checks their bounded consequences.

The production probe establishes, using real SQLite-backed kernel operations:

- a verified present observation settles DONE and clears its unresolved reservation;
- an unresolved authoritative absence becomes RECOVERY_REQUIRED and preserves the reservation;
- an authoritative absence with no reservation settles READY;
- resolving an already terminal run returns the same terminal receipt instead of appending a second settlement.

Those results become TLC constants. The model explores reserve/observe/settle histories and checks terminal clearing, recovery preservation, and terminal finality.

Three hostile controls independently disable each property and must produce the corresponding TLC invariant violation.

TLC is development-time evidence only. It is not called from production settlement or replay.
