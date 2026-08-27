# Self-Hosting Promotion Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev` the development integration branch and preserve the GitHub branch already used by Hatchable as the production source, with exact-SHA promotion as the only Overcenter path from development into production.

**Architecture:** Persist an explicit repository branch-role binding, enforce it at every existing GitHub semantic mutation boundary, and add one narrow production-promotion command that advances the existing production ref to an already-verified `dev` commit. Source materialization resolves its GitHub branch from that binding and remains untrusted until immutable Hatchable deployment verification succeeds.

**Tech Stack:** JavaScript ES modules, Hatchable V8/PostgreSQL, GitHub App REST transport, existing command-response-v1/orchestration journal conventions, deterministic regression modules.

**Spec:** `docs/superpowers/specs/2026-08-27-self-hosting-promotion-boundary-design.md`

## Global Constraints

- GitHub remains authoritative for repository content, commit identity, refs, pull requests, checks, and ancestry.
- Overcenter remains authoritative for orchestration state, branch-role configuration, promotion receipts, idempotency, recovery, and verification coordinates.
- `dev` is the development branch for managed deployed repositories.
- The production branch is the branch already used as the production runtime source. For Overcenter at this cutover it is `main` because current source-materialization evidence names `main`.
- After cutover, GitHub's default branch is `dev`; default-branch identity must not be used as a proxy for the production role.
- Ordinary changesets and pull requests cannot target the configured production branch.
- Production promotion moves an existing commit SHA. It must not create, squash, cherry-pick, or synthesize a commit.
- A production branch must never be moved backward by the ordinary promotion operation. Rollback is a separate semantic operation and is out of scope for this plan.
- Hatchable is a derived runtime projection. A deployment is not verified merely because it is live.
- A source-materialization receipt is valid only for its exact GitHub SHA and exact immediate Hatchable target version.
- Overcenter #161 remains open: this plan must not claim to eliminate Hatchable's mutable draft-to-deploy TOCTOU window.
- Existing unconfigured repositories retain current behavior until explicitly migrated; branch-role enforcement activates only after a branch-role binding exists.

---

### Task 1: Persist explicit repository branch roles

**Files:**
- Create: `migrations/051_repository_branch_roles.sql`
- Create: `lib/repository-branch-roles.js`
- Create: `lib/repository-branch-roles.test.js`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- Produces: `createPostgresRepositoryBranchRoleStore(dbBinding)` with `get(repository)` and `ensure(binding)`.
- Produces: `normalizeRepositoryBranchRoleBinding(input)` returning `{ repository, development_branch: 'dev', production_branch, production_source_ref }`.
- Produces: `resolveRepositoryBranchRoles(repository, { store })` returning `null` for an unconfigured repository or the canonical binding.
- Later tasks consume the binding and never infer production from `default_branch`.

- [ ] **Step 1: Write the failing persistence/normalization tests**

Add tests covering exact `dev`, distinct production branch, explicit source evidence, idempotent ensure, and conflicting reconfiguration:

```js
import {
  normalizeRepositoryBranchRoleBinding,
  createRepositoryBranchRoleService,
} from 'lib/repository-branch-roles.js';

await test('development role is literally dev', async () => {
  const result = normalizeRepositoryBranchRoleBinding({
    repository: 'laurajoyhutchins/overcenter',
    development_branch: 'dev',
    production_branch: 'main',
    production_source_ref: 'hatchable:proj_I6FSm85xrY7T:source-materialization',
  });
  assert(result.development_branch === 'dev', 'development role drifted');
});

await test('development and production cannot be the same branch', async () => {
  let code = null;
  try {
    normalizeRepositoryBranchRoleBinding({
      repository: 'laurajoyhutchins/overcenter',
      development_branch: 'dev',
      production_branch: 'dev',
      production_source_ref: 'hatchable:proj_I6FSm85xrY7T:source-materialization',
    });
  } catch (error) { code = error.code; }
  assert(code === 'REPOSITORY_BRANCH_ROLE_CONFLICT', `unexpected code ${code}`);
});
```

- [ ] **Step 2: Run the new test module and verify RED**

Run the repository's existing deterministic test harness for `lib/repository-branch-roles.test.js`.

Expected: module import fails because `lib/repository-branch-roles.js` does not yet exist.

- [ ] **Step 3: Add the branch-role table**

Create `migrations/051_repository_branch_roles.sql`:

```sql
CREATE TABLE IF NOT EXISTS portfolio_repository_branch_roles (
  repository text PRIMARY KEY,
  development_branch text NOT NULL,
  production_branch text NOT NULL,
  production_source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (development_branch = 'dev'),
  CHECK (development_branch <> production_branch)
)
```

- [ ] **Step 4: Implement the branch-role domain/store**

Implement a small focused module. The core normalization contract is:

```js
export function normalizeRepositoryBranchRoleBinding(input = {}) {
  const repository = canonicalRepository(input.repository);
  const developmentBranch = safeBranch(input.development_branch);
  const productionBranch = safeBranch(input.production_branch);
  if (developmentBranch !== 'dev') fail('REPOSITORY_BRANCH_ROLE_INVALID', 'development branch must be dev');
  if (developmentBranch === productionBranch) fail('REPOSITORY_BRANCH_ROLE_CONFLICT', 'development and production branches must differ');
  return {
    repository,
    development_branch: developmentBranch,
    production_branch: productionBranch,
    production_source_ref: requiredText(input.production_source_ref, 'production_source_ref', 1024),
  };
}
```

`ensure()` is idempotent for the same binding and returns `REPOSITORY_BRANCH_ROLE_CHANGED` rather than silently rewriting a different existing production branch.

- [ ] **Step 5: Register and run the deterministic tests**

Add the new suite to `lib/regression-suite-registry.js`, run the new module, then run the complete regression verifier.

Expected: new tests pass and no existing suite regresses.

- [ ] **Step 6: Commit Task 1**

Commit only the migration, branch-role module/tests, and registry change with a message equivalent to:

```text
feat: add repository branch-role bindings
```

---

### Task 2: Add a narrow branch-role configuration command

**Files:**
- Create: `api/portfolio-repository-branch-roles-ensure.js`
- Create: `mcp/portfolio_repository_branch_roles_ensure.js`
- Create: `public/docs/repository-branch-roles.md`
- Modify: `lib/repository-branch-roles.js`
- Modify: `lib/repository-branch-roles.test.js`

**Interfaces:**
- Consumes: Task 1 branch-role service.
- Produces semantic command: `portfolio.repository.branch_roles.ensure`.
- Request: `{ repository, development_branch: 'dev', production_branch, production_source_ref }`.
- Response: exact stored binding plus `{ changed }`.

- [ ] **Step 1: Write failing command/service tests**

Cover first configuration, replay, and attempted production-branch rewrite. A replay with the same fields must return `changed:false`; changing `production_branch` must fail closed.

- [ ] **Step 2: Verify RED**

Run the branch-role test module.

Expected: command/service entry point missing.

- [ ] **Step 3: Implement `ensure` as an evidence-preserving portfolio command**

Use `executeCorrelatedCommand('portfolio.repository.branch_roles.ensure', ...)` in the API route. Do not route this through GitHub mutation code because it changes Overcenter portfolio configuration, not GitHub state.

The MCP surface must expose only the exact semantic fields:

```js
{
  repository: string,
  development_branch: 'dev',
  production_branch: string,
  production_source_ref: string,
}
```

- [ ] **Step 4: Document authority semantics**

State explicitly that `production_source_ref` records the authoritative observation used at migration time. Changing GitHub's default branch does not change this binding. Changing production source later requires an explicit future migration, not ordinary `ensure` replay.

- [ ] **Step 5: Run focused and full regressions**

Expected: all branch-role tests and full regression verification pass.

- [ ] **Step 6: Commit Task 2**

```text
feat: add branch-role configuration command
```

---

### Task 3: Make `dev` the integration/default branch and block semantic bypasses

**Files:**
- Modify: `lib/github-pull-request-create.js`
- Modify: `lib/github-pull-request-create.test.js`
- Modify: `api/github-pull-request-create.js`
- Modify: `lib/github-integration.js`
- Modify: `lib/github-integration.test.js`
- Modify: `api/github-integration-reconcile.js`
- Modify: `lib/github-apply-changeset.js`
- Modify: `lib/github-apply-changeset.test.js`
- Modify: `api/github-apply-changeset.js`
- Modify: `lib/github-required-checks.js`
- Modify: `lib/github-branch-policy.test.js`
- Reuse: `lib/github-default-branch.js`

**Interfaces:**
- Consumes: `resolveRepositoryBranchRoles()` from Task 1.
- Produces: role-aware PR creation, integration, changeset, and branch-policy behavior.
- Unconfigured repositories preserve existing behavior.

- [ ] **Step 1: Add failing PR-base tests**

For a configured repository, a request whose `base` is `main` must fail before GitHub mutation:

```js
assert(result.error === 'GITHUB_BRANCH_ROLE_VIOLATION', 'production-targeted PR was accepted');
assert(result.expected_base === 'dev', 'development role not surfaced');
```

A `base:'dev'` request with exact expected base/head coordinates remains valid.

- [ ] **Step 2: Add failing integration tests**

When GitHub reports a PR base other than `dev` for a configured repository, `github.integration.reconcile` must return `GITHUB_BRANCH_ROLE_VIOLATION` and must not call update-branch or merge.

- [ ] **Step 3: Add failing changeset tests**

For configured `{ development_branch:'dev', production_branch:'main' }`:

```js
for (const branch of ['dev', 'main']) {
  const result = await applyGithubChangeset(requestFor(branch), { branchRoles, github });
  assert(result.error === 'GITHUB_BRANCH_ROLE_VIOLATION', `${branch} direct mutation was accepted`);
}
```

A conforming `feat/...` branch remains allowed.

- [ ] **Step 4: Verify the focused tests fail for the intended reasons**

Run the three existing test modules.

Expected: current code still accepts caller-selected PR bases and existing protected branches.

- [ ] **Step 5: Inject the role resolver at existing runtime boundaries**

Pass the database-backed resolver from each API adapter. Do not make lower-level GitHub functions import Hatchable `db` directly; keep deterministic functions injectable.

Use one shared guard shape:

```js
function assertOrdinaryWorkTarget(branch, roles) {
  if (!roles) return;
  if (branch === roles.development_branch || branch === roles.production_branch) {
    fail('GITHUB_BRANCH_ROLE_VIOLATION', 'ordinary mutation cannot target a managed development or production branch', {
      branch,
      development_branch: roles.development_branch,
      production_branch: roles.production_branch,
      may_have_mutated: false,
    });
  }
}
```

- [ ] **Step 6: Make PR creation and integration require `dev`**

PR creation may continue accepting `base` for backward compatibility, but for a configured repository it must equal the resolved development branch. Integration independently re-reads the PR and rejects any base other than `dev`; never trust PR creation as the only gate.

- [ ] **Step 7: Make branch-policy reconciliation operate on the actual default branch after cutover**

Keep the existing `~DEFAULT_BRANCH` ruleset behavior. The migration will move GitHub default from `main` to `dev`, so existing default-branch protections naturally apply to `dev`. Add regression coverage proving branch-policy code does not treat the configured production role as synonymous with the default branch.

- [ ] **Step 8: Run focused and full regressions**

Expected: all three semantic mutation paths fail closed on `main`, accept work branches, and integration/PRs target `dev`.

- [ ] **Step 9: Commit Task 3**

```text
feat: enforce development and production branch roles
```

---

### Task 4: Add exact-SHA production promotion

**Files:**
- Create: `migrations/052_github_production_promotion_receipts.sql`
- Create: `lib/github-production-promotion.js`
- Create: `lib/github-production-promotion.test.js`
- Create: `api/github-production-promote.js`
- Create: `mcp/github_production_promote.js`
- Create: `public/docs/github-production-promotion.md`
- Modify: `lib/regression-suite-registry.js`
- Modify: `lib/github-app-auth.js` only if a new named permission profile is required; otherwise reuse the narrow contents-write profile already used for ref mutations.

**Interfaces:**
- Consumes: Task 1 role binding.
- Produces semantic command: `github.production.promote`.
- Request fields: `repo`, `candidate_sha`, `observed_development_head`, `observed_production_head`, `verification_ref`, `idempotency_key`.
- Produces receipt with old/new production heads, exact candidate, development head, role policy, verification coordinate, and GitHub readback.

- [ ] **Step 1: Add the promotion receipt table**

Create:

```sql
CREATE TABLE IF NOT EXISTS github_production_promotion_receipts (
  repo text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  request_json jsonb NOT NULL,
  state text NOT NULL,
  old_production_head text,
  new_production_head text,
  verification_ref text NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, idempotency_key)
)
```

- [ ] **Step 2: Write failing promotion tests**

Cover:
- exact `dev` candidate succeeds;
- stale development head rejects before mutation;
- stale production head rejects before mutation;
- candidate not reachable from `dev` rejects;
- candidate older than production rejects as non-fast-forward;
- verification for a different SHA rejects;
- same idempotency key/same request replays;
- same idempotency key/different request conflicts;
- successful promotion performs one ref update and creates no Git commit/tree/blob.

- [ ] **Step 3: Verify RED**

Run `lib/github-production-promotion.test.js` and expect missing implementation.

- [ ] **Step 4: Implement a minimal GitHub adapter**

The adapter needs only:

```js
{
  getBranch(repo, branch),
  compare(baseSha, headSha),
  getCommitVerification(repo, sha),
  updateBranch(repo, branch, sha),
}
```

Do not add a general-purpose GitHub wrapper.

- [ ] **Step 5: Define exact verification acceptance**

For this middle-path implementation, `verification_ref` identifies the exact-SHA verification evidence the promotion caller observed. Promotion must independently re-read GitHub status/check evidence for `candidate_sha` and require all effective required checks for `dev` to be satisfied at that SHA. Store the supplied verification reference plus the authoritative reread in the receipt.

The check is against the `dev` commit being promoted, not a PR head that produced it.

- [ ] **Step 6: Implement fast-forward/ref fencing**

Before mutation:

```js
assert(dev.sha === request.observed_development_head);
assert(prod.sha === request.observed_production_head);
assert(request.candidate_sha === dev.sha);
assert(await github.compare(prod.sha, request.candidate_sha).is_fast_forward === true);
```

Immediately before the ref update, re-read both heads. After update, re-read production and require exact equality with `candidate_sha`.

- [ ] **Step 7: Wire API/MCP and command-response behavior**

Use `executeCorrelatedCommand('github.production.promote', ...)`, preserve `may_have_mutated` semantics, and reconcile a lost ref-update response by authoritative production-ref readback before classifying indeterminate.

- [ ] **Step 8: Run focused and full regressions**

Expected: promotion suite passes and complete regression verification remains green.

- [ ] **Step 9: Commit Task 4**

```text
feat: add exact-sha production promotion
```

---

### Task 5: Bind production source materialization to the production role

**Files:**
- Modify: `lib/source-sync.js`
- Modify: `lib/source-sync.test.js`
- Modify: `public/docs/source-sync.md`

**Interfaces:**
- Consumes: resolved branch roles.
- Produces a production-specific coordinate assertion that derives `github_branch` rather than accepting a caller override.
- Keeps `verifySourceMaterializationDeployment()` as the immutable post-deploy authority.

- [ ] **Step 1: Add failing source-binding tests**

Cover:

```js
await test('production sync derives main from branch roles', async () => {
  const coordinates = assertProductionSourceCoordinates({
    hatchable_project: 'proj_I6FSm85xrY7T',
    github_repository: 'laurajoyhutchins/overcenter',
    expected_hatchable_version: 351,
    observed_hatchable_version: 351,
    expected_github_head: 'a'.repeat(40),
    observed_github_head: 'a'.repeat(40),
  }, { development_branch: 'dev', production_branch: 'main' });
  assert(coordinates.github_branch === 'main', 'production role was not derived');
});
```

Also prove that a caller-provided conflicting `github_branch:'dev'` is rejected with `SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED`.

- [ ] **Step 2: Add the stale-receipt v351 regression**

Construct an immutable deployment manifest whose files match a newer commit but whose embedded receipt targets the previous deployment version/SHA. Require `verifySourceMaterializationDeployment()` to return `ok:false` with both `hatchable_version_mismatch` or `github_head_mismatch` as applicable. Sampling equality must not upgrade the result.

- [ ] **Step 3: Verify RED only for the new role-binding behavior**

Existing immutable receipt checks should already make the v351-style stale receipt fail. If that regression is already green, preserve it and document it as locked behavior rather than weakening the assertion merely to manufacture RED.

- [ ] **Step 4: Implement `assertProductionSourceCoordinates`**

Keep the generic deterministic primitives if tests need them, but production callers must use:

```js
export function assertProductionSourceCoordinates(input, roles) {
  if (!roles?.production_branch) fail('SOURCE_SYNC_BRANCH_ROLE_REQUIRED', 'production source branch is not configured');
  if (input.github_branch != null && input.github_branch !== roles.production_branch) {
    fail('SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED', 'production source branch is derived from repository branch roles');
  }
  return assertSourceCoordinates({ ...input, github_branch: roles.production_branch });
}
```

- [ ] **Step 5: Update receipt documentation**

Clarify the state distinction:

```text
candidate receipt in mutable draft != verified materialization
verified materialization = receipt + immutable target deployment + exact production SHA
```

- [ ] **Step 6: Run source-sync and full regressions**

Expected: role override is impossible in the production path, stale receipts fail, and #161 remains documented as residual platform risk.

- [ ] **Step 7: Commit Task 5**

```text
fix: bind production source sync to branch roles
```

---

### Task 6: Implement a fail-closed Overcenter cutover sequence

**Files:**
- Create: `lib/self-hosting-branch-cutover.js`
- Create: `lib/self-hosting-branch-cutover.test.js`
- Create: `public/docs/self-hosting-branch-cutover.md`
- Modify: `lib/regression-suite-registry.js`
- Reuse: `lib/github-default-branch.js`
- Reuse: `lib/source-sync.js`
- Reuse: Task 2 branch-role ensure service

**Interfaces:**
- Produces a deterministic cutover planner/state machine; it does not itself bypass existing GitHub/Hatchable semantic operations.
- Required observed inputs: repository, current production source branch, exact production head, immutable Hatchable verification result, current default branch, existence/head of `dev`.
- Produces next action or terminal verified cutover state.

- [ ] **Step 1: Write failing cutover tests**

Cover the safe sequence:

```text
verify main == immutable deployed SHA
→ create dev at exact same SHA
→ migrate GitHub default main → dev
→ ensure branch roles dev/main
→ reconcile dev branch policy
→ verify main unchanged
→ cutover complete
```

Also cover fail-closed cases:
- live Hatchable version is unverified;
- verified Hatchable SHA differs from current production branch head;
- `dev` already exists at a different SHA;
- default branch changes during cutover;
- production branch moves during cutover.

- [ ] **Step 2: Verify RED**

Run the new cutover tests.

Expected: implementation missing.

- [ ] **Step 3: Implement the pure cutover planner**

The planner must never recommend moving `main` backward. If current `main` is not the exact verified production coordinate, the next action is `materialize_and_verify_current_production_head`, not ref repair.

Example output:

```js
{
  ok: true,
  complete: false,
  next_action: 'create_dev',
  repository: 'laurajoyhutchins/overcenter',
  development_branch: 'dev',
  production_branch: 'main',
  expected_head: verifiedProductionSha,
}
```

- [ ] **Step 4: Document the operator choreography**

The actual mutation sequence must use existing or newly added semantic operations:
- source materialization + immutable verification;
- exact branch creation at verified SHA;
- `github.default_branch.migrate` from `main` to `dev`;
- `portfolio.repository.branch_roles.ensure` with the observed Hatchable source binding;
- branch-policy reconciliation for the new default `dev`;
- exact reread of `main` and `dev`.

Do not add an all-powerful `cutover` mutation endpoint.

- [ ] **Step 5: Register and run the cutover regressions**

Expected: planner refuses every ambiguous state and full regression suite passes.

- [ ] **Step 6: Commit Task 6**

```text
feat: add fail-closed self-hosting branch cutover
```

---

### Task 7: Verify capability exposure and self-hosting invariants

**Files:**
- Modify: `public/docs/github-capabilities.md`
- Modify: `public/docs/architecture/terminology.md`
- Modify: `public/docs/control-plane-surface-inventory.md`
- Modify: regression docs/registry only where required by existing conventions.

**Interfaces:**
- Consumes all previous tasks.
- Produces the documented public contract for branch roles, promotion, and deployment provenance.

- [ ] **Step 1: Add an end-to-end deterministic regression scenario**

The scenario must demonstrate:

```text
feat/example -> dev
main remains unchanged
promotion(dev_sha) -> main == dev_sha
source receipt binds main + dev_sha + immediate Hatchable target
wrong-version receipt => UNVERIFIED
```

- [ ] **Step 2: Run all focused suites**

Run branch roles, PR create, integration, changeset, promotion, source-sync, branch policy, and cutover suites.

Expected: all pass.

- [ ] **Step 3: Run the complete regression verifier**

Expected: zero failing registered tests. Record total/passed counts in the implementation evidence rather than hardcoding the count in documentation.

- [ ] **Step 4: Review semantic command surfaces**

Confirm ordinary agents can no longer:
- mutate `dev` or `main` through `github.apply_changeset`;
- create/integrate a work PR into `main`;
- select `dev` as a production source-sync override;
- advance `main` except through `github.production.promote`.

- [ ] **Step 5: Commit Task 7**

```text
docs: define self-hosting promotion boundary
```

---

### Task 8: Cut Over Overcenter Itself

**Files:**
- No source changes expected. This is an operational migration using the semantic commands implemented above.

**Interfaces:**
- Consumes: current GitHub/Hatchable authoritative observations and Tasks 1-7.
- Produces: Overcenter branch-role binding `{ development:'dev', production:'main' }`, default branch `dev`, production `main` pinned until explicit promotion, and a verified immutable Hatchable deployment for the production SHA.

- [ ] **Step 1: Re-read authoritative current state**

Read:
- current `main` SHA;
- current GitHub default branch;
- current Hatchable live deployment version;
- current source-materialization receipt;
- immutable deployment manifest for that version.

Do not reuse coordinates from this design conversation.

- [ ] **Step 2: Converge and verify current production source before cutover**

If the live deployment is not immutably verified for the current `main` SHA, rematerialize current `main`, deploy, and verify the new immutable deployment. Repeat only when verification proves the attempted deployment did not match; never infer success from a live status.

- [ ] **Step 3: Create `dev` at the exact verified `main` SHA**

Fail if `dev` exists at any other SHA.

- [ ] **Step 4: Change GitHub default branch from `main` to `dev` using the existing semantic default-branch migration**

Require exact expected head and authoritative readback.

- [ ] **Step 5: Persist branch roles**

Call `portfolio.repository.branch_roles.ensure` with:

```json
{
  "repository": "laurajoyhutchins/overcenter",
  "development_branch": "dev",
  "production_branch": "main",
  "production_source_ref": "hatchable:proj_I6FSm85xrY7T:source-materialization"
}
```

- [ ] **Step 6: Reconcile branch policy on new default `dev`**

Require exact `dev` head and required checks.

- [ ] **Step 7: Prove production did not move during cutover**

Reread `main`; it must still equal the verified production SHA from Step 2.

- [ ] **Step 8: Dogfood one no-op or low-risk work cycle**

Use Overcenter to create/use a conforming work branch targeting `dev`, integrate it, and verify `main` remains unchanged until an explicit production promotion is requested.

- [ ] **Step 9: Promote that exact verified `dev` SHA to `main`**

Use `github.production.promote`, then materialize `main` to Hatchable and require immutable deployment verification.

- [ ] **Step 10: Record final evidence**

Final healthy coordinates must satisfy:

```text
GitHub default branch = dev
development_sha = dev head
promoted_sha = main head
verified_deployed_sha = main head
verified Hatchable receipt target version = live immutable deployment version
```

Do not close Overcenter #161 as part of this cutover.
