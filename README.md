# Busbar

Busbar is the portfolio execution surface for verified project-state transitions.

It separates:

- the project graph: what must become true and in what dependency order;
- the transition lifecycle: Enable → Acquire → Execute → Commit → Confirm.

GitHub remains authoritative for repository state. Linear is a thin projection of currently executable work.
