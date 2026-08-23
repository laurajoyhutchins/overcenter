# Busbar Identity Migration Design

## Objective

Rename the current portfolio orchestration GitHub App from the obsolete Portfolio Control Plane naming to **Busbar** without creating a second current identity, compatibility layer, or parallel authority.

Busbar is the current system name. Hatchable is the hosting/runtime platform. GitHub repositories remain authoritative for repository content. Linear remains a thin projection of currently executable work.

## Naming contract

Use **Busbar** for the product/system and **Busbar GitHub App** when the GitHub application identity must be explicit.

Treat these as obsolete current-system names:

- Hatchable Portfolio Control Plane
- Portfolio Control Plane
- Portfolio Control Plane GitHub App
- Portfolio Orchestration App

Historical material may retain old names only when the historical identity itself is the subject.

Do not rename generic domain terminology merely because it contains `portfolio`. Existing domain concepts such as portfolio work, portfolio reconciliation, `portfolio_*` database tables, and `portfolio.reconcile_work_surface` describe the managed domain rather than the product identity and remain valid.

## Identity surfaces

The migration updates all active human-facing and machine-facing product identity surfaces that are safe to rename:

1. Hatchable project metadata becomes `Busbar`.
2. The canonical source repository becomes `laurajoyhutchins/busbar`.
3. README, UI titles, descriptions, dashboard copy, architecture terminology, command documentation, MCP descriptions, and secret descriptions use Busbar.
4. HTTP GitHub `User-Agent` values become `Busbar/1.0` unless a stricter GitHub App identity requirement is discovered.
5. Machine outputs that identify the current replacement system as `portfolio_control_plane` become `busbar` where the value is a product/system identifier rather than a domain namespace.
6. Source-sync repository coordinates move atomically to `laurajoyhutchins/busbar` and tests assert the new coordinate.
7. Tests that assert the GitHub App actor name are updated only after the actual GitHub App registration identity is changed and observed. Tests must not invent a bot login.

## GitHub App registration

The GitHub App registration is part of the product identity. Rename its display identity to Busbar when an authenticated management path exists. If the available automation surface cannot mutate GitHub App registration settings, all automatable surfaces may be migrated first, but completion must explicitly record the remaining GitHub settings action rather than pretending the bot identity changed.

No compatibility alias, second GitHub App, or duplicate credential path is introduced solely for the rename.

## Repository rename

Rename `laurajoyhutchins/portfolio-control-plane-github-app` to `laurajoyhutchins/busbar` rather than creating a replacement repository. Preserve repository history, pull requests, issues, branch protections/rules, installation access, and authoritative continuity through GitHub's repository rename behavior.

After the rename, update any exact repository coordinates in Busbar itself and in currently active external consumers. Historical references in old commits need not be rewritten.

## Runtime continuity

The rename must not alter orchestration semantics, database schema, command names, lease behavior, receipts, run state, or deployment authority. Product naming changes are deliberately separated from protocol/domain identifiers unless those identifiers explicitly encode the obsolete product identity.

The Hatchable project ID `proj_I6FSm85xrY7T` remains stable. The existing project is renamed in place; no replacement project is created.

## Verification

The migration is complete when:

- Hatchable project metadata identifies Busbar.
- The canonical GitHub repository is `laurajoyhutchins/busbar`.
- Active source contains no current-system references to `Hatchable Portfolio Control Plane`, `Portfolio Control Plane GitHub App`, or equivalent obsolete product naming except explicit historical/deprecation text.
- UI and dashboard identify Busbar.
- Source-sync coordinates and tests use the renamed repository.
- GitHub API user agents use Busbar.
- Current replacement-system machine identifiers use `busbar` where appropriate.
- The full Busbar regression suite passes or any external execution blocker is recorded with exact evidence.
- The deployed Hatchable version is verified after the rename.
- The actual GitHub App actor identity is observed and tests match reality; if it cannot be renamed through available tooling, that single external settings action is recorded as the remaining blocker.

## Non-goals

- Renaming generic `portfolio_*` tables or domain commands.
- Rewriting Git history.
- Preserving old product-name aliases for compatibility.
- Creating a second deployment, repository, GitHub App, or orchestration authority.
- Renaming Hatchable itself or hiding the fact that Busbar is hosted there.
