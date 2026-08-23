# Portfolio Orchestration App

This repository contains the current Hatchable Portfolio Control Plane GitHub App and is the successor to the deprecated `laurajoyhutchins/engineering-agent-team` repository.

## Authority boundary

- GitHub repositories are authoritative for repository content and technical source truth.
- This app owns portfolio orchestration and execution semantics, including bounded runs, work leases, claim and settlement, deterministic recovery, semantic worker commands, receipts, and work-surface reconciliation.
- Linear is a thin projection of currently executable work, not a second repository or execution authority.
- `engineering-agent-team` is historical only. Do not depend on it as a current, fallback, or compatibility authority.

Prefer deterministic software for repeated bookkeeping, reconciliation, validation, state derivation, and known recovery choreography. Use reasoning workers for work that requires judgment, research, synthesis, design, or novel implementation.
