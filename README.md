# Overcenter

**Reliable execution for agent-driven software projects.**

Overcenter is a control plane for turning repository-owned project plans into verified state transitions. Reasoning agents make judgments and implement changes. Deterministic software owns the parts that must be correct: execution authority, exact-revision mutation, idempotency, evidence, settlement, and recovery.

> Agents are disposable. Execution truth isn't.

## Quick start

A fresh checkout is an ordinary Node 22 project. Docker is required for the local PostgreSQL development runtime.

```bash
git clone https://github.com/laurajoyhutchins/overcenter.git
cd overcenter
npm install
npm test
npm run dev
```

`npm run dev` starts PostgreSQL with Docker Compose, builds the host-independent portable runtime, and starts a local development server on `http://127.0.0.1:8787`. `GET /health` verifies the Node/PostgreSQL substrate. `POST /runtime/publish` exercises portable runtime publication and verification without requiring Hatchable.

The other canonical repository commands are intentionally mundane:

```bash
npm run build
npm run typecheck
npm run test:integration
npm run verify
```

Use `OVERCENTER_DEV_SKIP_DOCKER=1` when supplying your own PostgreSQL instance through the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` environment variables.

## Why Overcenter

Agent systems are good at research, design, debugging, synthesis, and implementation. They are much less useful as human-shaped transaction coordinators.

Overcenter moves repeated orchestration ceremony into software:

- **Repository-owned plans.** Project definitions live with the repository instead of in a parallel planning database.
- **Bounded execution authority.** Work runs under exclusive leases with explicit scope and expiry.
- **Exact-revision writes.** Mutations are fenced against authoritative Git revisions rather than optimistic guesses.
- **Durable execution truth.** Current execution authority, unresolved operations, exact-revision proofs, and compact terminal receipts survive the agent session that produced them. Historical journals are diagnostic telemetry, not a correctness dependency.
- **Fail-closed behavior.** Stale authority, ambiguous mutations, and missing evidence stop execution instead of being silently papered over.
- **Resumable work.** A fresh agent can inspect the project and continue from durable state.

The design rule is simple: reasoning agents should make judgments; deterministic software should own execution correctness.

## How it works

A project is a graph of desired transitions stored in the repository. Overcenter derives the executable frontier, grants authority for one transition, executes or hands off the work, records the result, and confirms completion against fresh project state.

```text
GitHub project definition
          |
          v
      project graph
          |
          v
       Overcenter
      /          \
   agent        operator
      \          /
       verified effects
          |
          v
   fresh authoritative read
```

Each transition moves through a bounded lifecycle:

```text
ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM
```

That lifecycle is control-plane machinery. Agents should normally interact with higher-level semantic commands instead of manually reconstructing leases, retries, settlement, or recovery.

## Agent-facing surface

The primary semantic surface is intentionally small:

- `project.inspect` reads the authoritative project and returns the decision-relevant frontier.
- `project.advance` advances the project until agent judgment is required or deterministic work is confirmed.
- `project.define` and `project.amend` create or revise repository-owned project definitions.
- `production.promote` performs the production promotion workflow behind one semantic boundary.

Lower-level work, orchestration, GitHub, verification, and recovery commands remain available as supporting mechanisms and evidence surfaces.

## Authority boundaries

Overcenter keeps each system in a narrow role:

- **GitHub** is authoritative for repository content and repository-owned project definitions.
- **Overcenter** is authoritative for current run/execution state, unresolved operations, settlement, compact receipts and proofs, and deterministic recovery decisions.
- **Linear** can project executable work, but it is not source authority or an evidence archive.
- **Hatchable** is the current reference runtime and hosting layer, not project authority.

This separation is deliberate. Hosting, task tracking, and agent sessions should be replaceable without changing what the project says is true.

## Repository layout

- `.overcenter/` contains repository-owned project definitions and graph metadata.
- `mcp/` defines semantic MCP tool contracts.
- `api/` exposes bounded runtime and HTTP surfaces.
- `lib/` contains the orchestration kernel, GitHub integration, evidence, recovery, and verification logic.
- `src/` contains typed semantic, runtime, port, and adapter source.
- `migrations/` contains durable PostgreSQL schema evolution.
- `docs/` contains architecture and design documentation.
- `public/docs/` contains runtime-facing command and operator documentation.
- `scripts/` contains repository-owned build, test, development, verification, and release checks.
- `dist/` is generated build output and is not committed.
- `hatchable.toml` declares the current reference deployment configuration.

## Project status

Overcenter is under active development. The execution model and safety boundaries are implemented and exercised, while the agent-facing surface and portable deployment path are still being simplified.

The command contracts in `mcp/` and the repository-owned project definitions in `.overcenter/` are the best references for current behavior.

## Deployment

The current reference deployment runs on Hatchable with PostgreSQL, an installed GitHub App, and a Linear API connection. Deployment coordinates and credentials are installation-owned and must not be committed to repository source.

See [`hatchable.toml`](hatchable.toml) for required runtime configuration and [`SECURITY.md`](SECURITY.md) before deploying an instance.

Overcenter's source-of-truth model is intentionally host-independent: the runtime may host execution, but it does not become authority merely by hosting the service.

## Verification

From a complete Git checkout:

```bash
npm install
npm test
npm run build
npm run verify
```

`npm run verify` is the canonical full local repository check. CI installs the committed lockfile with `npm ci` and invokes the same package commands instead of maintaining a separate dependency recipe. The public-release verifier checks the repository boundary, tracked development residue, deployment-specific coordinates, and high-confidence credential patterns in Git history.

## Security

Overcenter coordinates privileged repository mutations and should be treated as security-sensitive software. Read [`SECURITY.md`](SECURITY.md) before deployment or vulnerability reporting.

## Contributing

Keep changes narrow and evidence-backed. Tests should prove the semantic risk a command owns.

When deterministic software can replace repeated agent bookkeeping, prefer moving that behavior behind a semantic boundary. When ordinary GitHub behavior is sufficient, prefer using it rather than adding another orchestration path.

Do not commit credentials, private operational evidence, installation-specific project IDs, or development-session journals.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor workflow.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).