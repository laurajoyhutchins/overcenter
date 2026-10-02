# TLA+ release micro-verifier

This experiment attacks the temporal boundary around release of an unresolved effect reservation.

The production probe uses the real SQLite-backed kernel and GitHub status effect path to establish:

- a fresh-HTTPS failure before secure connection produces trusted not-dispatched evidence and clears the reservation;
- an ambiguous transport failure produces no release witness and preserves the reservation;
- a real trusted witness bound to the wrong attempt coordinate is rejected and preserves the reservation.

Those production facts become TLC constants.

The model explores reserve, binding corruption, pre-dispatch failure, possible dispatch, and release. It checks that only proven pre-dispatch evidence on the exact binding can release and that a successful release clears the reservation.

Three hostile controls disable reservation clearing, possible-dispatch blocking, and exact binding independently. Each must produce the expected invariant violation.
