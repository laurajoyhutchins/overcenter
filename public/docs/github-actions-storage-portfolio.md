# Portfolio GitHub Actions storage reconciliation

Busbar turns the existing per-repository Actions storage primitive into bounded portfolio maintenance.

The maintenance pass discovers repositories from repository-disposition authority and processes only `ACTIVE` and `MAINTENANCE` repositories that are not GitHub-archived. `ARCHIVED`, `SUPERSEDED`, and `DORMANT` repositories are skipped.

The policy is intentionally conservative:

- only `repository-verification-coverage` and `node-coverage` are classified as reproducible;
- the newest artifact for each reproducible class is retained;
- older reproducible artifacts are deletion candidates;
- every unknown artifact class is protected;
- repository retention changes only when the inspected repository contains no protected artifact class.

The reconciliation supports `dry_run` and `apply` modes internally. `dry_run` performs inspection only and reports exact candidate artifact IDs. `apply` deletes only those candidates through the existing fail-closed GitHub Actions storage primitive and changes retention only when the repository is safe for that policy.

Results include observed and live storage bytes, candidate and protected artifact counts, reclaimed bytes, skipped repositories, failures, and per-repository outcomes. One repository failure does not prevent later repositories from being inspected. Ambiguous GitHub mutations remain fail closed through the underlying primitive, and repeated apply is idempotent after candidates have been removed.

The existing hourly orchestration maintenance scheduler runs the apply pass. This is deterministic maintenance, not portfolio work: it does not create Linear issues, execution packets, or per-run bookkeeping work.
