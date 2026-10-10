# Inactive Pages support validation

PR #684 is ordinary inactive support. The composed activation has been split out;
this tree adds no effect registration, kernel postcondition, observation schema,
dispatcher, settlement semantics, or live push/recovery harness. Accepted core and
accepted tests match the base exactly. Pages work is rejected before claim.

Checked code revision: `316c19061585554159e3d95dbeda8f810ba48097`.
Accepted comparison base: `ce4ecfadfe61636bac208232227c5cac299d038e`.
Runtime checks used pinned Node 22.16.0, Go 1.24.13, Rust/rustfmt component 1.98.1,
and Biome 2.5.14. Go execution tests used `GOFLAGS=-buildvcs=false` to avoid this
workspace's VCS-stamping limitation. No repository verification policy changed.

| Check | Result |
| --- | --- |
| TypeScript typecheck | Passed |
| Focused support plus unchanged registry tests | 18 passed |
| Fresh reviewer focused support tests | 11 passed; no Critical/Important code finding |
| Full repository lint, including Go vet and Rust formatting | Passed (8 existing warnings) |
| Ordinary source-profile `--check-only --source-candidate` | Passed |
| Settlement schema freshness | Passed; schema remains unchanged |
| Accepted-base TCB comparison | Admitted; zero semantic growth in all scopes |
| Diagnostic unit subset, pinned Node 22 | 607 passed, 1 skipped, 0 failed; excludes only computation-executor tests |
| Computation executor, pinned Node 22 and Go | Blocked by Unix socket `listen EPERM` in this environment |
| Full unit suite and immutable base-test replay | Not claimed; executor environment remains blocked |
| Source admission receipt / merge certification | Not claimed by local checks |
| Production confined preparation and live Pages settlement | Not established |

The accepted-base TCB report classifies every property and composition as
**unchanged**: broker-mutation-safety 9,084; no-false-done 9,080;
github-commit-status-provider 2,578; judgment-attestation-integrity 2,063;
deduplicated composition 9,084 semantic lines. All deltas are zero, with no new
external modules or symbols under accepted scope. Existing seven hostile-evidence
obligations are unchanged baseline debt; this support slice does not resolve them.

The original composed candidate at `70cf6602` grew the shared TCB by 1,190 lines
and mixed ordinary support with protected registration. Those blockers were
removed from this PR by restoring the core to the accepted base, isolating
prospective evidence as `PagesObservation`, and extracting pure Git transport.
The activation implementation and integration tests are preserved separately.
This separation does not establish that activation is admissible.

The support transport retains explicit lease races, isolated Git configuration,
replacement-object suppression, and remote-coordinate fences. Preparation and
observation retain deterministic output identity, conservative paths, bounded
traversal/HTTP reads, and repeated provider fences. No accepted test or closure
assertion was weakened.

Rollout still requires a separately reviewed/admitted reserved adapter and
settlement implementation, full exact-head checks on a socket-capable runner,
production confinement, externally injected Git credentials that trigger Pages
builds, confirmed branch-root configuration, trusted independent provider-tree
acquisition, and exact served-byte readback. No live publication is claimed.
