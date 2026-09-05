# Overcenter test audit

This directory defines the evidence format and workflow for an exhaustive audit of Overcenter's tests. The census is deterministic; the semantic review is judgment work.

## Entry points

- `npm run audit:tests` prints the static census for the exact checked-out Git revision.
- `npm run audit:tests -- --write` writes that census to `audit/tests/census.json`.
- `npm run audit:tests -- --init-review` writes the census and creates `audit/tests/review.jsonl`. It refuses to overwrite an existing review ledger.
- `npm run audit:tests:coverage` runs the maintained Node test lane with Node's built-in test coverage. Coverage is refused if the static census is incomplete.

The census requires `scripts/` and `lib/` to match `HEAD`. It discovers test-like files repository-wide, structurally extracts literal `test()`/`it()` cases through the already-pinned TypeScript compiler API, expands prefix-selected test families from the runners, verifies the regression-suite registry, and records unregistered script tests instead of dropping them.

A test file in an unknown location or extension, a dynamically named test, or a test file with no discoverable cases makes `complete` false. That is intentional: completeness is an evidence claim and fails closed.

Standalone verification programs invoked by the maintained test harness are recorded separately as `verification_artifacts`; they are not silently conflated with case-bearing tests.

## Review ledger

Each `review.jsonl` row is bound to one census `test_id` and exact Git revision. Review every row using the schema in `review.schema.json` and assign a final disposition of `KEEP`, `STRENGTHEN`, `MERGE`, `REPLACE`, `DELETE`, or `BROKEN`. `UNKNOWN` means the audit is unfinished.

At minimum, record what invariant the test proves, the authority behind its assertions, setup validity, assertion strength, exact-identity binding, fail-closed behavior, mutation certainty, concurrency/recovery behavior, determinism, production fidelity, overlap, and regression lineage.

Do not modify production tests while auditing a revision. Settle the audit against that immutable revision first; remediation belongs in a later Overcenter transition.

## Deeper tools

The baseline intentionally adds no new package dependency. Node 22 supplies execution and coverage; TypeScript 5.9, already pinned by Overcenter, supplies structural parsing. Mutation testing with Stryker and reusable structural rules with ast-grep should consume the completed census as deeper evidence layers, rather than defining which tests exist. Chirograph can then map audited tests to contracts, implementations, documentation, and runtime evidence.