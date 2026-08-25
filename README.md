# Overcenter

Overcenter is a GitHub App runtime for turning project work into verified state transitions.

It separates **project truth** from **execution mechanics**:

- GitHub repositories are authoritative for repository content and technical source truth.
- Overcenter owns execution semantics: bounded runs, exclusive work leases, claim/settlement, deterministic recovery, exact-revision mutation, receipts, and orchestration state.
- Linear is a thin projection of currently executable work. It is not a second repository, evidence archive, or execution authority.
- Hatchable is the current hosting/runtime layer. It does not become project authority by hosting Overcenter.

```text
        reasoning workers / deterministic operators
                       |
                       v
       ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM
                       |
                    OVERCENTER
                 /          \
                v            v
             GitHub        Linear
            authority     projection
```

## Design principles

Overcenter exists to move repeated orchestration ceremony out of prompts and into deterministic software.

- Use reasoning agents for judgment, research, synthesis, design, debugging, and novel implementation.
- Use software for bookkeeping, reconciliation, validation, counting, state derivation, idempotency, and known recovery choreography.
- Prefer one authoritative path over duplicated state, compatibility layers, or agent-maintained projections.
- Fail closed when authority is stale, a mutation may be ambiguous, or required evidence is missing.

## Core surfaces

The repository contains:

- `api/` — bounded HTTP/runtime surfaces;
- `mcp/` — semantic tool contracts;
- `lib/` — orchestration, work leasing, GitHub command, reconciliation, recovery, and verification logic;
- `migrations/` — durable PostgreSQL schema evolution;
- `public/docs/` — current architecture and command documentation;
- `scripts/` — repository-owned static verification;
- `hatchable.toml` — current Hatchable runtime configuration.

Important GitHub operations are intentionally command-owned when atomicity, idempotency, conditional mutation, or durable evidence justify a higher-level primitive. Ordinary GitHub functionality should remain ordinary GitHub functionality.

## Deployment

Overcenter is currently designed to run on Hatchable with PostgreSQL, a Linear API connection, and an installed GitHub App.

A deployment provides its own installation coordinates and credentials. Repository source does **not** contain a production Hatchable project ID, GitHub App private key, installation access token, or Linear credential.

The required secret/configuration names are declared in `hatchable.toml`:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- the required Linear API connection

The authoritative GitHub App permission profiles live in `lib/github-app-auth.js`. The App registration must grant the permissions needed by the commands you intend to enable; individual Overcenter commands then mint repository-scoped installation tokens using their fixed command-owned profiles.

Source materialization is one-way: an authenticated adapter supplies the deployment's Hatchable project, GitHub repository, branch, exact Git head, and observed runtime version to `lib/source-sync.js`. GitHub is authoritative and runtime drift is repaired from GitHub, never pushed back upstream.

## Verification

From a complete Git checkout:

```bash
node scripts/verify-regression-suite-registry.mjs
node --test scripts/verify-public-release.test.mjs
node scripts/verify-public-release.mjs
```

`verify-public-release` requires full Git history. It checks the public repository boundary, rejects tracked development-journal residue and installation-specific project IDs, and scans Git history for high-confidence credential patterns.

Overcenter also exposes an admin-only runtime regression surface at `POST /api/verification/regressions`. Runtime verification and repository-static verification are complementary: neither substitutes for the other.

## Security

Overcenter is security-sensitive software. Read [`SECURITY.md`](SECURITY.md) before deployment or vulnerability reporting.

The intentionally public runtime preview exposes aggregate condition only. Privileged runs, lease references, receipts, raw errors, repository topology, and mutation capabilities remain on admin surfaces.

## Contributing

Keep changes narrow and evidence-backed. Tests should prove the exact semantic risk a command owns. If an operation can be replaced by ordinary GitHub behavior or deterministic derivation, prefer deletion over adding another orchestration path.

Do not commit credentials, private operational evidence, installation-specific project IDs, or development-session journals.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
