# Contributing to Overcenter

Overcenter coordinates privileged software-project mutations, so contributions should optimize for clear semantics, narrow authority, and evidence before claims.

## Before changing code

Read:

1. [`README.md`](README.md) for the product model and local quick start.
2. [`docs/README.md`](docs/README.md) for the maintained documentation map.
3. [`docs/architecture/ontology-and-authority.md`](docs/architecture/ontology-and-authority.md) for source-of-truth boundaries.
4. [`docs/agent-session-contract.md`](docs/agent-session-contract.md) for the intended agent-facing workflow.

For command work, also read [`docs/command-reference.md`](docs/command-reference.md) and the exact relevant contract under `mcp/`.

## Local setup

Use Node 22 and Docker. From a fresh checkout:

```bash
npm install
npm test
npm run dev
```

The root `package.json` and `package-lock.json` are the canonical dependency and command boundary. Do not add parallel CI-only dependency installation recipes when the dependency belongs to the repository.

## Design rules

The core pressure test is:

> Reasoning agents make judgments. Deterministic software owns execution correctness.

Prefer moving mechanically knowable coordination behind semantic software boundaries. Agents should not become durable owners of lease lookup, retry identity, settlement bookkeeping, copied repository state, or frontier recomputation when software can derive those facts safely.

Keep authority narrow:

- GitHub owns repository content and repository-owned project definitions.
- Overcenter owns runs, leases, execution authority, journals, mutation certainty, settlements, receipts, and recovery state.
- Linear, when configured, is a projection rather than source authority.
- A runtime host does not become project authority merely because the service executes there.

Fail closed on stale authority, ambiguous mutation certainty, unavailable required facts, and missing completion evidence.

## Scope changes narrowly

Prefer a small change that proves one semantic risk over a broad refactor with weak evidence.

Good changes typically:

- name the exact invariant or failure mode they own;
- remove duplicate paths rather than adding another compatibility layer;
- preserve exact-revision fencing and mutation certainty;
- add focused regression coverage for the behavior at risk;
- keep host-specific details behind adapters where practical.

If work discovers a missing project transition or prerequisite, amend the repository-owned Overcenter graph rather than maintaining a private side list.

## Branch and pull-request flow

Ordinary source changes target the development branch, currently `dev`. Do not treat the production branch as a normal authoring target; production promotion is a separate verified transition.

Pull requests should be narrow enough that reviewers can identify the authority boundary, external effects, and verification evidence without reconstructing a large session transcript.

Do not force a stale branch through an up-to-date requirement. Refresh against the current authoritative base and re-run exact-head verification.

## Verification

The canonical local commands are:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
npm run verify
```

`npm test` is credential-free repository verification. `npm run test:integration` requires PostgreSQL; the default local instance is provided by `compose.yaml`. `npm run verify` runs the full local test, build, generated-runtime drift, and public-release boundary checks.

CI installs dependencies with `npm ci` and delegates to these same package commands. A green local command is not a substitute for required exact-head CI evidence when branch protection requires it.

When adding a maintained regression suite, register it in the repository's canonical regression-suite registry rather than creating an orphan test path.

## TypeScript and generated runtime code

TypeScript is used where static checking removes concrete invalid states. Runtime validation remains authoritative for external JSON, durable rows, revisions, leases, and other world-state facts.

Where typed semantic source mechanically emits runtime JavaScript, treat the typed source as the authoring surface and let `npm run build` detect generated drift. Do not create a second hand-maintained semantic registry.

Generated artifacts belong under `dist/` and are not committed.

## Documentation

Documentation must say what kind of document it is.

- **Current architecture / contract** documents explain maintained invariants or normative runtime boundaries.
- **Accepted design decision** documents record a direction that remains relevant but are not exact runtime reference.
- **Active implementation plan** documents describe unfinished work and may drift as code changes.
- **Completed / historical implementation record** documents preserve how a shipped change was built; they are not current API documentation.

When prose disagrees with an executable command contract, fix the documentation drift rather than treating prose as shadow authority.

## Public repository hygiene

Do not commit:

- credentials, tokens, capability material, or private operational evidence;
- installation-specific project IDs or deployment coordinates unless explicitly intended as public examples;
- raw agent scratchpads or development-session journals;
- licensed or private source material that the repository is not allowed to redistribute.

The public-release verifier scans repository history for high-confidence credential patterns and deployment-specific residue. Treat those checks as a boundary, not a cleanup suggestion after publication.

## Security

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability or changing a security-sensitive boundary. Overcenter coordinates privileged repository mutations, and changes to execution authority, GitHub mutation paths, settlement, recovery, or production promotion deserve explicit adversarial review.