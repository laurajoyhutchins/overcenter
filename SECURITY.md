# Security policy

Busbar is security-sensitive infrastructure. It can hold GitHub App credentials, mint repository-scoped installation tokens, manage execution leases, and perform bounded repository mutations. Security reports should be handled privately.

## Supported version

Security fixes target the current `main` branch. Historical commits and abandoned feature branches are not supported deployment targets.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, credential exposure, authorization bypass, or unsafe external-effect condition.

Use GitHub's private vulnerability reporting / Security Advisory surface for this repository when it is available. If that surface is unavailable, contact the repository maintainer privately through the contact information on the maintainer's GitHub profile and include the repository name, affected revision, impact, and a minimal reproduction.

Do not include live credentials, private keys, installation access tokens, lease capabilities, or unrelated private data in a report unless they are strictly necessary to establish the vulnerability.

## Security boundaries

Busbar is designed around the following invariants:

- GitHub App permissions are command-owned. Callers do not choose arbitrary permission scopes.
- Installation tokens are scoped to the selected repository and are not returned to callers or intentionally persisted or logged.
- Privileged orchestration, work, verification, and GitHub mutation routes are admin-only.
- GitHub repository state is authoritative for repository content. Runtime source is a derived projection and cannot authorize reverse publication.
- Linear is a thin projection of currently executable work, not a repository or execution authority.
- Mutations that can become ambiguous must fail closed or reconcile authoritative external state before retry.
- Exclusive leases, expected-revision checks, exact-head checks, idempotency, and durable receipts are security controls, not optional ergonomics.
- The intentionally public preview exposes only aggregate system condition. Individual run IDs, lease references, receipts, repository topology, raw errors, and credentials belong on privileged surfaces.

## Secrets

Repository source must contain secret names and configuration contracts only, never secret values. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, the Linear API credential, and any other deployment credential must be supplied by the deployment environment.

Before public release, run `node scripts/verify-public-release.mjs` from a complete clone with all Git history available. The check scans tracked source for installation-specific identifiers and scans Git history for high-confidence credential patterns.

## Scope priorities

Reports involving authentication, authorization, credential disclosure, privilege escalation, cross-repository mutation, replay/idempotency failure, lease ownership violations, ambiguous external effects, or unauthorized source publication are treated as security issues.

Ordinary feature requests, expected fail-closed rejections, and availability limitations without a security consequence should use normal issue tracking.
