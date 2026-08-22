# Source Sync External-Adapter Implementation Plan

1. Replace `lib/source-sync.js` with a pure deterministic planner/verifier. Preserve fixed coordinates, source-path filtering, Git blob identity, diff planning, and exact postcondition checks.
2. Replace source-sync regressions with adapter-independent tests for stale coordinates, push diffs, pull fetch/delete plans, blob verification, and projection verification.
3. Remove the Hatchable self-management client and the source-sync secret declaration.
4. Remove in-app push/pull API routes and MCP tools. They cannot truthfully complete the Hatchable half without self-management authority.
5. Remove the temporary source-sync canonical command/error/journal registrations and the GitHub read capability added solely for the abandoned in-app implementation.
6. Update source-sync documentation to define external authenticated adapters and the exact push/pull choreography.
7. Dry-run deploy, deploy, run `POST /api/verification/regressions`, verify the consolidated result is green, verify retired diagnostic routes are absent, and grep the complete project for obsolete credential/self-management references.
8. For a live round trip, use the connected Hatchable and GitHub adapters directly: observe exact coordinates, derive the plan deterministically, apply one authority-specific mutation, re-observe, and prove convergence.