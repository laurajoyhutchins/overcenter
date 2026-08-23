# Busbar Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the existing portfolio orchestration GitHub App and its active system identity to **Busbar** without changing orchestration semantics or creating compatibility machinery.

**Architecture:** Preserve the existing project, repository history, runtime protocols, database schema, and generic portfolio domain vocabulary. Change only product/system identity surfaces, then rename the existing Hatchable project and GitHub repository in place. Keep source-sync coordinates aligned with the real repository name, and do not invent a GitHub App bot login before the actual App registration identity is observed.

**Tech Stack:** Hatchable V8 project, JavaScript, GitHub App authentication, GitHub REST API, MCP tools, PostgreSQL-backed orchestration state.

**Spec:** `public/docs/superpowers/specs/2026-08-22-busbar-identity-migration-design.md`

## Global Constraints

- Busbar is the single current product/system name.
- Use **Busbar GitHub App** only when the GitHub application identity must be explicit.
- Hatchable is hosting/runtime, not part of the product name.
- Do not rename generic portfolio domain concepts, `portfolio_*` database tables, or `portfolio.reconcile_work_surface`.
- Do not add compatibility aliases, a second GitHub App, a second deployment, or a second repository.
- Keep Hatchable project ID `proj_I6FSm85xrY7T` unchanged.
- Do not change the asserted GitHub actor login until the actual GitHub App registration has been renamed and observed.
- Repository rename must preserve history, issues, pull requests, rules, installation access, and default-branch continuity.
- Runtime behavior, command names, lease semantics, receipts, and orchestration state must remain unchanged.

---

### Task 1: Establish the rename verification boundary

**Files:**
- Modify: `lib/source-sync.test.js`
- Modify only if needed for identity assertions: existing regression tests that encode current product identifiers.

**Interfaces:**
- Consumes: `SOURCE_SYNC_PROJECT`, `SOURCE_SYNC_REPO`, and `SOURCE_SYNC_BRANCH` from `lib/source-sync.js`.
- Produces: regression assertions requiring the canonical source repository to be `laurajoyhutchins/busbar` while preserving project ID and branch.

- [ ] **Step 1: Change the source-coordinate regression expectation first**

Change only the repository assertion to:

```js
check(SOURCE_SYNC_REPO === 'laurajoyhutchins/busbar', 'repo drifted');
```

Keep these assertions unchanged:

```js
check(SOURCE_SYNC_PROJECT === 'proj_I6FSm85xrY7T', 'project drifted');
check(SOURCE_SYNC_BRANCH === 'main', 'branch drifted');
```

- [ ] **Step 2: Confirm the pre-migration deployed suite is green**

Invoke `POST /api/verification/regressions` against project `proj_I6FSm85xrY7T` before deployment.

Expected before-state: `ok: true`, `passed: 542`, `failed: 0`.

The branch test cannot execute against the deployed runtime until the branch source is deployed, so the changed assertion is the regression fence for the deployment step rather than a reason to deploy an intentionally failing production version.

- [ ] **Step 3: Commit the test fence together with no production behavior change**

Commit message:

```text
Fence Busbar source identity
```

### Task 2: Rename machine-facing product identity

**Files:**
- Modify: `lib/source-sync.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/github-app-auth.js`
- Modify: `lib/github-apply-changeset.js`
- Modify: `lib/github-integration.js`
- Modify: `lib/github-review-packet.js`
- Modify: `api/github-apply-text-replacements.js`
- Modify: `api/portfolio-compatibility-check.js`
- Modify: `lib/repository-disposal.js`
- Modify: `lib/repository-disposition.js`
- Test: `lib/source-sync.test.js`

**Interfaces:**
- Consumes: existing GitHub App authentication and source-sync contracts.
- Produces: `SOURCE_SYNC_REPO = 'laurajoyhutchins/busbar'`, `User-Agent: Busbar/1.0`, and `busbar` as the current product/system identifier where machine output names the replacement authority.

- [ ] **Step 1: Update the source-sync coordinate**

Change:

```js
export const SOURCE_SYNC_REPO = 'laurajoyhutchins/portfolio-control-plane-github-app';
```

to:

```js
export const SOURCE_SYNC_REPO = 'laurajoyhutchins/busbar';
```

- [ ] **Step 2: Update the orchestration journal source target coordinate**

Change the source-sync target reference to:

```text
proj_I6FSm85xrY7T<->laurajoyhutchins/busbar
```

- [ ] **Step 3: Replace active GitHub HTTP product user agents**

Replace each active `Hatchable-Portfolio-Control-Plane/1.0` user agent with:

```text
Busbar/1.0
```

Do not change GitHub API version headers or permission profiles.

- [ ] **Step 4: Replace current-system machine identifiers only where they identify the product**

For compatibility/retirement responses whose value explicitly identifies the current replacement system, change:

```text
portfolio_control_plane
```

to:

```text
busbar
```

Do not rename generic `portfolio` command namespaces, route names, tables, receipt schemas, or work-surface terminology.

- [ ] **Step 5: Keep actor-login tests unchanged**

Leave `portfolio-control-plane[bot]` fixtures/assertions untouched until GitHub reports the real post-rename actor login. This prevents tests from fabricating identity evidence.

- [ ] **Step 6: Commit the machine-identity patch**

Commit message:

```text
Rename runtime identity to Busbar
```

### Task 3: Rename active human-facing identity

**Files:**
- Modify: `README.md`
- Modify: `hatchable.toml`
- Modify: `pages/index.js`
- Modify: `pages/dashboard.js`
- Modify: `lib/linear-archive.js`
- Modify: `mcp/github_pull_request_create.js`
- Modify: `mcp/github_pull_request_mark_ready.js`
- Modify: `public/docs/architecture/terminology.md`
- Modify: `public/docs/command-response-v1.md`
- Modify: `public/docs/control-plane-surface-inventory.md`
- Modify: `public/docs/github-apply-changeset.md`
- Modify: `public/docs/github-pull-request-create.md`
- Modify: `public/docs/github-pull-request-mark-ready.md`
- Modify: `public/docs/orchestration-recovery.md`
- Modify: `public/docs/repository-disposition.md`
- Modify: `public/docs/skill-execution-contracts.md`
- Modify: `public/docs/source-sync.md`

**Interfaces:**
- Consumes: the naming contract in the approved spec.
- Produces: one current human-facing name, Busbar, while retaining Hatchable only as hosting context and retaining historical names only when explicitly historical.

- [ ] **Step 1: Rename the repository landing copy**

Use:

```markdown
# Busbar

Busbar is the GitHub App that owns portfolio orchestration and execution semantics for this engineering portfolio.
```

Preserve the existing authority-boundary statements about GitHub, Linear, deterministic software, and the historical `engineering-agent-team` repository.

- [ ] **Step 2: Rename project configuration descriptions**

Secret descriptions should say `Busbar GitHub App`, not `Portfolio Control Plane GitHub App`.

- [ ] **Step 3: Rename the lightweight index page and dashboard**

The index page title and H1 become `Busbar`. The meta description should identify Busbar as the portfolio orchestration GitHub App deployed on Hatchable. Preserve the version-only subtitle and dashboard link.

The dashboard eyebrow becomes `BUSBAR`. The lede should describe read-only operational evidence from Busbar without changing the authority model.

- [ ] **Step 4: Rename active MCP and setup copy**

Use `Busbar GitHub App` in MCP command descriptions and setup/error instructions where the application identity is relevant.

- [ ] **Step 5: Rewrite canonical terminology documentation**

`public/docs/architecture/terminology.md` must define:

```text
Busbar = the logical portfolio orchestration/execution system
Busbar GitHub App = the running GitHub application identity when that distinction matters
Hatchable project = hosting/container identity
```

List obsolete names explicitly as deprecated terminology rather than maintaining aliases.

- [ ] **Step 6: Update current architecture/command docs**

Replace active references to the old product name with Busbar while preserving protocol names and historical discussion.

- [ ] **Step 7: Commit the human-facing rename**

Commit message:

```text
Rename product surfaces to Busbar
```

### Task 4: Rename the existing Hatchable project in place

**Files:**
- No source file creation.
- Project metadata mutation only.

**Interfaces:**
- Consumes: Hatchable project `proj_I6FSm85xrY7T`.
- Produces: project metadata name `Busbar` while keeping the same project ID, database, secrets, URL slug, functions, and deployment history.

- [ ] **Step 1: Update project metadata**

Set Hatchable project name to exactly:

```text
Busbar
```

Do not create a new project. Do not attempt to change the immutable Hatchable slug as part of this migration.

- [ ] **Step 2: Read project metadata back**

Verify:

```text
project_id = proj_I6FSm85xrY7T
name = Busbar
status = active
```

### Task 5: Rename the canonical GitHub repository in place

**Files:**
- Repository metadata mutation only.

**Interfaces:**
- Consumes: existing repository `laurajoyhutchins/portfolio-control-plane-github-app`.
- Produces: same repository object/history under `laurajoyhutchins/busbar`.

- [ ] **Step 1: Use the narrowest available GitHub repository-rename operation**

Perform the native GitHub repository rename from:

```text
laurajoyhutchins/portfolio-control-plane-github-app
```

to:

```text
laurajoyhutchins/busbar
```

Do not copy files into a replacement repository and do not introduce a forwarding service.

- [ ] **Step 2: Verify repository continuity**

Read repository metadata after the mutation and verify:

```text
full_name = laurajoyhutchins/busbar
default_branch = main
archived = false
```

Verify the existing `rename/busbar` branch and open history remain attached to the renamed repository.

- [ ] **Step 3: If no authenticated repository-settings mutation exists**

Record the repository rename as an explicit external settings blocker. Do not deploy a source-sync coordinate that points to a repository that does not yet exist.

### Task 6: Deploy Busbar identity without changing orchestration semantics

**Files:**
- Apply only the already-reviewed identity changes to the existing Hatchable project source.

**Interfaces:**
- Consumes: current authoritative GitHub source after repository continuity is established.
- Produces: a new deployment of the same Hatchable project whose active product identity is Busbar.

- [ ] **Step 1: Apply identity-only source changes to the Hatchable project**

Use targeted edits. Do not overwrite unrelated deployed files with stale copies and do not modify schema or orchestration behavior.

If repository rename is still blocked, keep the live source-sync repository coordinate at the actually existing repository name while applying all other safe Busbar identity changes.

- [ ] **Step 2: Dry-run deployment**

Run Hatchable deployment validation and require zero hard errors.

- [ ] **Step 3: Deploy**

Deploy project `proj_I6FSm85xrY7T` with intent `Rename the portfolio orchestration app to Busbar` and a changelog summary that states this is an identity-only rename.

- [ ] **Step 4: Verify live pages**

Invoke the public index and admin dashboard functions. Confirm `Busbar` appears and obsolete current-system product names do not.

### Task 7: Reconcile the real GitHub App registration identity

**Files:**
- Modify actor-login tests only if the observed GitHub identity changes.

**Interfaces:**
- Consumes: actual GitHub App registration and installation identity.
- Produces: test fixtures matching observed GitHub evidence, never an assumed login.

- [ ] **Step 1: Rename the existing GitHub App registration if an authenticated settings path exists**

Change its display identity to Busbar without creating a second App or rotating credentials merely for naming.

- [ ] **Step 2: Observe the installation actor**

Use an authoritative GitHub response produced by the installed App to capture the actual actor login after the settings change.

- [ ] **Step 3: Update actor-login fixtures only to the observed value**

If GitHub still reports the existing bot login, leave tests unchanged. If GitHub reports a new login, update fixtures/assertions to that exact value.

- [ ] **Step 4: If App settings cannot be mutated through available tooling**

Record the GitHub App display-name change as the single external settings action. Do not create code or compatibility machinery to work around a missing account-settings API.

### Task 8: Verify and finish the migration

**Files:**
- No new runtime files unless verification uncovers an identity defect.

**Interfaces:**
- Consumes: renamed project, repository, deployment, documentation, and actual GitHub App identity.
- Produces: exact evidence that Busbar is the current system name and runtime behavior remains green.

- [ ] **Step 1: Run the full regression verification**

Invoke `POST /api/verification/regressions`.

Expected: `ok: true`, zero failures. The exact pass count may increase if rename-specific assertions are added.

- [ ] **Step 2: Search active source for obsolete current-system names**

Search for:

```text
Hatchable Portfolio Control Plane
Portfolio Control Plane GitHub App
Portfolio Orchestration App
Hatchable-Portfolio-Control-Plane
portfolio-control-plane-github-app
```

Any remaining match must be either explicit historical/deprecation text, a temporarily necessary real external coordinate blocked on repository/App settings, or a defect to fix.

- [ ] **Step 3: Verify metadata and source coordinates**

Confirm the Hatchable project is Busbar, repository metadata is `laurajoyhutchins/busbar` if the native rename was available, source-sync uses the real canonical repository, and no duplicate authority was introduced.

- [ ] **Step 4: Verify deployed version and runtime health**

Read the current Hatchable version after deployment and confirm the project remains active. Run the index/dashboard smoke checks and inspect any deployment/runtime errors introduced by the rename.

- [ ] **Step 5: Finish the development branch**

Review the final branch diff, run exact verification again, open or update the Busbar rename pull request, and integrate only when the repository’s normal merge policy permits it. Do not bypass required protections.
