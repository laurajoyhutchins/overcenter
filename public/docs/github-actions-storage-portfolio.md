# Portfolio GitHub Actions storage reconciliation

Busbar turns the existing per-repository Actions storage primitive into bounded portfolio maintenance.

The maintenance pass discovers repositories from repository-disposition authority and processes only `ACTIVE` and `MAINTENANCE` repositories that are not GitHub-archived. `ARCHIVED`, `SUPERSEDED`, and `DORMANT` repositories are skipped.

The artifact policy is intentionally conservative:

- artifacts GitHub already marks expired are deletion candidates regardless of name;
- live `repository-verification-coverage` and `node-coverage` artifacts are classified as reproducible;
- the newest live artifact for each reproducible class is retained;
- older live reproducible artifacts are deletion candidates;
- every live unknown or non-reproducible artifact class is protected.

Repository-wide artifact retention is not inferred from the current artifact inventory. Portfolio reconciliation reports retention as `not_managed` and does not call `set_retention`; changing future-artifact retention requires an explicit repository policy owned by a more specific configuration surface.

The reconciliation supports `dry_run` and `apply` modes internally. `dry_run` performs inspection only and reports exact candidate artifact IDs together with each candidate's deletion reason. `apply` deletes only those exact candidates through the existing fail-closed GitHub Actions storage primitive.

Results include observed and live storage bytes, candidate and protected artifact counts, reclaimed bytes, skipped repositories, failures, the retention-policy boundary, and per-repository outcomes. One repository failure does not prevent later repositories from being inspected. Ambiguous GitHub mutations remain fail closed through the underlying primitive, and repeated apply is idempotent after candidates have been removed.

The existing hourly orchestration maintenance scheduler runs the apply pass. This is deterministic maintenance, not portfolio work: it does not create Linear issues, execution packets, or per-run bookkeeping work.
