# TLA+ authority-coordinate micro-verifier

This experiment models the ABA/history semantics behind execution-authority advancement and receipt acceptance.

The production probe establishes from the live TypeScript predicates:

- authority generation must be the exact successor;
- the predecessor authority commit must match exactly;
- a receipt must name the current execution authority.

TLC then explores an authority advance followed by delivery of an old receipt. The accepted model forbids malformed advances and stale receipt acceptance.

Three negative controls independently remove successor, predecessor, and current-receipt checks.
