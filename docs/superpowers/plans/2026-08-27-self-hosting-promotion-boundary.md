# Self-Hosting Promotion Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev` the development/default branch while preserving the GitHub branch already used by Hatchable as the production source, with exact-SHA promotion as the only Overcenter path into production.

**Architecture:** Persist explicit branch roles, enforce them at every existing GitHub semantic mutation boundary, reuse Overcenter's isolated exact-revision Hatchable V8 verifier as the promotion gate, and add one narrow ref-promotion command. Production source materialization derives its branch from the stored production role and is trusted only after immutable Hatchable deployment verification.

**Tech Stack:** JavaScript ES modules, Hatchable V8/PostgreSQL, GitHub App REST/Actions APIs, existing command-response-v1/orchestration journal conventions, deterministic regression modules, `.github/workflows/exact-revision-v8.yml`.

**Spec:** `docs/superpowers/specs/2026-08-27-self-hosting-promotion-boundary-design.md`

## Global Constraints

- GitHub is authoritative for content, refs, commit identity, PRs, checks, workflow runs, and ancestry.
- Overcenter is authoritative for branch-role configuration, orchestration, promotion receipts, idempotency, recovery, and verified deployment coordinates.
- Managed development branch is literally `dev`.
- Production branch is the branch already used by the production runtime. For Overcenter today, source-materialization evidence names `main`, so `main` remains production.
- After cutover, GitHub default branch is `dev`. Default branch and production branch are different concepts.
- Existing unconfigured repositories preserve current behavior until explicitly migrated.
- Ordinary changesets cannot mutate `dev` or the configured production branch.
- Ordinary PR creation/integration cannot target the configured production branch.
- Production promotion advances the existing production ref to an existing `dev` commit. It creates no commit/tree/blob.
- Ordinary promotion is fast-forward only. Rollback is separate and out of scope.
- Promotion requires a successful exact-revision V8 workflow run for the exact candidate SHA. Reuse `.github/workflows/exact-revision-v8.yml`; do not invent a second verifier.
- Hatchable production is not verified merely because a deployment is live.
- Source receipts bind an exact GitHub SHA and exact immediate Hatchable target version.
- Overcenter #161 remains open; this plan does not claim atomic Hatchable draft-to-deploy publication.

## Exact-revision verification loop used throughout this plan

For every RED/GREEN checkpoint that changes registered runtime tests:

```bash
node scripts/verify-regression-suite-registry.mjs
find api lib mcp pages -type f -name '*.js' -print0 | xargs -0 -n1 node --check
SHA=$(git rev-parse HEAD)
gh workflow run exact-revision-v8.yml --ref "$(git branch --show-current)" -f revision="$SHA"
gh run list --workflow exact-revision-v8.yml --limit 1
```

Then inspect/watch the returned run with:

```bash
gh run watch <RUN_ID> --exit-status
```

For a deliberate RED commit, `gh run watch` must exit non-zero for the new failing regression. For GREEN, it must exit zero. The exact-revision workflow checks out the supplied SHA, materializes it into the isolated Hatchable verification project, verifies immutable deployment bytes, and runs the canonical V8 regression endpoint. It already rejects using the production Hatchable project as the verification project.

---

### Task 1: Persist explicit repository branch roles

**Files:**
- Create: `migrations/051_repository_branch_roles.sql`
- Create: `lib/repository-branch-roles.js`
- Create: `lib/repository-branch-roles.test.js`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- Produces `normalizeRepositoryBranchRoleBinding(input)`.
- Produces `createPostgresRepositoryBranchRoleStore(dbBinding)` with `get(repository)` and `ensure(binding)`.
- Produces `resolveRepositoryBranchRoles(repository, { store })`, returning `null` for unconfigured repos.

- [ ] **Step 1: Add the failing tests**

```js
await test('development role is exactly dev', async () => {
  const binding = normalizeRepositoryBranchRoleBinding({
    repository: 'laurajoyhutchins/overcenter',
    development_branch: 'dev',
    production_branch: 'main',
    production_source_ref: 'hatchable:proj_I6FSm85xrY7T:source-materialization',
  });
  assert(binding.development_branch === 'dev', 'development branch drifted');
});

await test('development and production roles cannot alias', async () => {
  let code = null;
  try {
    normalizeRepositoryBranchRoleBinding({
      repository: 'laurajoyhutchins/overcenter',
      development_branch: 'dev',
      production_branch: 'dev',
      production_source_ref: 'hatchable:proj_I6FSm85xrY7T:source-materialization',
    });
  } catch (error) { code = error.code; }
  assert(code === 'REPOSITORY_BRANCH_ROLE_CONFLICT', `unexpected ${code}`);
});
```

Also test idempotent `ensure()` and rejection of changing an existing production branch.

- [ ] **Step 2: Register the new suite and verify RED with the exact-revision loop**

Expected: the new suite fails because the branch-role module is not implemented.

- [ ] **Step 3: Add the table**

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

- [ ] **Step 4: Implement the focused domain/store**

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

`ensure()` must return the existing identical row on replay and `REPOSITORY_BRANCH_ROLE_CHANGED` for a different existing binding.

- [ ] **Step 5: Verify GREEN with the exact-revision loop**

Expected: registry/static checks pass and isolated exact-revision V8 verification succeeds.

- [ ] **Step 6: Commit**

```bash
git add migrations/051_repository_branch_roles.sql lib/repository-branch-roles.js lib/repository-branch-roles.test.js lib/regression-suite-registry.js
git commit -m "feat: add repository branch-role bindings"
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
- Produces command `portfolio.repository.branch_roles.ensure`.
- Exact request: `{ repository, development_branch, production_branch, production_source_ref }`.
- `development_branch` must equal `dev`.

- [ ] **Step 1: Add failing tests for first ensure, replay, and conflicting rewrite**

A same-request replay returns `changed:false`. A different production branch returns `REPOSITORY_BRANCH_ROLE_CHANGED` and performs no write.

- [ ] **Step 2: Verify RED with the exact-revision loop**

Expected: command/service entry point is missing.

- [ ] **Step 3: Implement the command using `executeCorrelatedCommand`**

The API route must call:

```js
executeCorrelatedCommand(
  'portfolio.repository.branch_roles.ensure',
  req.body || {},
  (input) => createRepositoryBranchRoleService({ db }).ensure(input),
  { flattenDetails: true, db },
)
```

Do not route through GitHub mutation code because this changes Overcenter configuration, not GitHub state.

- [ ] **Step 4: Document binding semantics**

`production_source_ref` is the evidence coordinate that established the production source at migration time. GitHub default-branch changes do not rewrite this binding.

- [ ] **Step 5: Verify GREEN with the exact-revision loop**

- [ ] **Step 6: Commit**

```bash
git add api/portfolio-repository-branch-roles-ensure.js mcp/portfolio_repository_branch_roles_ensure.js public/docs/repository-branch-roles.md lib/repository-branch-roles.js lib/repository-branch-roles.test.js
git commit -m "feat: add branch-role configuration command"
```

---

### Task 3: Enforce `dev` at PR, integration, and changeset boundaries

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
- Modify: `.github/workflows/regression-suite-registry.yml`

**Interfaces:**
- Consumes Task 1 resolver.
- Unconfigured repositories keep current behavior.
- Configured repositories treat `dev` and production as reserved semantic branches.

- [ ] **Step 1: Add failing PR-base tests**

For `{development:'dev', production:'main'}`, `base:'main'` returns:

```js
{
  ok: false,
  error: 'GITHUB_BRANCH_ROLE_VIOLATION',
  expected_base: 'dev',
  may_have_mutated: false,
}
```

`base:'dev'` remains valid.

- [ ] **Step 2: Add failing integration tests**

If GitHub rereads a PR whose base is `main`, integration returns `GITHUB_BRANCH_ROLE_VIOLATION` before update-branch or merge calls.

- [ ] **Step 3: Add failing changeset tests**

Both `branch:'dev'` and `branch:'main'` reject direct ordinary content mutation. A conforming `feat/...` branch still succeeds.

- [ ] **Step 4: Commit the RED tests and verify RED with the exact-revision loop**

Expected: current semantic paths still accept at least one prohibited target.

- [ ] **Step 5: Inject branch-role resolution at API adapters**

Keep lower-level functions deterministic and injectable. Use one shared guard:

```js
export function assertOrdinaryWorkTarget(branch, roles) {
  if (!roles) return;
  if ([roles.development_branch, roles.production_branch].includes(branch)) {
    fail('GITHUB_BRANCH_ROLE_VIOLATION', 'ordinary mutation cannot target a managed branch role', {
      branch,
      development_branch: roles.development_branch,
      production_branch: roles.production_branch,
      may_have_mutated: false,
    });
  }
}
```

- [ ] **Step 6: Make PR create and integration independently require `dev`**

PR creation may retain `base` in its public contract for compatibility, but a configured repository requires it to equal `dev`. Integration must independently reread and enforce the PR base.

- [ ] **Step 7: Update repository verification workflow push branches**

Change:

```yaml
push:
  branches: [main]
```

to:

```yaml
push:
  branches: [dev, main]
```

PR verification remains enabled for all PRs.

- [ ] **Step 8: Verify GREEN with the exact-revision loop**

- [ ] **Step 9: Commit**

```bash
git add lib/github-pull-request-create.js lib/github-pull-request-create.test.js api/github-pull-request-create.js lib/github-integration.js lib/github-integration.test.js api/github-integration-reconcile.js lib/github-apply-changeset.js lib/github-apply-changeset.test.js api/github-apply-changeset.js .github/workflows/regression-suite-registry.yml
git commit -m "feat: enforce development and production branch roles"
```

---

### Task 4: Add exact-SHA production promotion using the existing V8 verifier

**Files:**
- Create: `migrations/052_github_production_promotion_receipts.sql`
- Create: `lib/github-production-promotion.js`
- Create: `lib/github-production-promotion.test.js`
- Create: `api/github-production-promote.js`
- Create: `mcp/github_production_promote.js`
- Create: `public/docs/github-production-promotion.md`
- Modify: `lib/regression-suite-registry.js`
- Modify: `lib/github-app-auth.js` only if a named permission profile is required.

**Interfaces:**
- Command: `github.production.promote`.
- Exact request: `{ repo, candidate_sha, observed_development_head, observed_production_head, verification_run_id, idempotency_key }`.
- The candidate must equal the current `dev` head in v1.
- Verification evidence is a GitHub Actions workflow run for `.github/workflows/exact-revision-v8.yml`.

- [ ] **Step 1: Add the receipt table**

```sql
CREATE TABLE IF NOT EXISTS github_production_promotion_receipts (
  repo text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  request_json jsonb NOT NULL,
  state text NOT NULL,
  old_production_head text,
  new_production_head text,
  verification_run_id bigint NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, idempotency_key)
)
```

- [ ] **Step 2: Add failing tests**

Cover exact candidate success, stale dev/prod heads, non-fast-forward, different-SHA workflow run, failed/incomplete workflow run, wrong workflow path, idempotent replay/conflict, and proof that success calls only the ref-update adapter.

- [ ] **Step 3: Register/commit RED tests and verify RED with the exact-revision loop**

- [ ] **Step 4: Implement a minimal GitHub adapter**

Only these operations are needed:

```js
{
  getBranch(repo, branch),
  compare(baseSha, headSha),
  getWorkflowRun(repo, runId),
  updateBranch(repo, branch, sha),
}
```

- [ ] **Step 5: Validate the exact-revision run**

Require the authoritative workflow-run reread to satisfy all of:

```js
run.path === '.github/workflows/exact-revision-v8.yml'
run.event === 'workflow_dispatch'
run.head_sha === candidate_sha
run.status === 'completed'
run.conclusion === 'success'
```

This reuses the existing verifier that materializes the exact revision into the isolated Hatchable V8 verification project and runs canonical regressions. Do not substitute ordinary PR checks for this gate.

- [ ] **Step 6: Fence refs and ancestry**

```js
assert(dev.sha === request.observed_development_head);
assert(prod.sha === request.observed_production_head);
assert(request.candidate_sha === dev.sha);
assert(compare.status === 'ahead' || compare.status === 'identical');
```

If identical, return an idempotent no-change receipt. Immediately before mutation reread both refs; after mutation reread production and require exact candidate equality.

- [ ] **Step 7: Reconcile uncertain ref-update transport by readback**

If transport loses certainty, reread production. Exact candidate means success/recovered; any other ref means `GITHUB_PRODUCTION_PROMOTION_INDETERMINATE` with `may_have_mutated:true`.

- [ ] **Step 8: Wire API/MCP using `executeCorrelatedCommand`**

- [ ] **Step 9: Verify GREEN with the exact-revision loop**

- [ ] **Step 10: Commit**

```bash
git add migrations/052_github_production_promotion_receipts.sql lib/github-production-promotion.js lib/github-production-promotion.test.js api/github-production-promote.js mcp/github_production_promote.js public/docs/github-production-promotion.md lib/regression-suite-registry.js
git commit -m "feat: add exact-sha production promotion"
```

---

### Task 5: Bind production source-sync to the stored production role

**Files:**
- Modify: `lib/source-sync.js`
- Modify: `lib/source-sync.test.js`
- Modify: `public/docs/source-sync.md`

**Interfaces:**
- Produces `assertProductionSourceCoordinates(input, roles)`.
- Production callers cannot select a branch independently of branch-role configuration.

- [ ] **Step 1: Add failing role-binding tests**

```js
const coordinate = assertProductionSourceCoordinates({
  hatchable_project: 'proj_I6FSm85xrY7T',
  github_repository: 'laurajoyhutchins/overcenter',
  expected_hatchable_version: 351,
  observed_hatchable_version: 351,
  expected_github_head: 'a'.repeat(40),
  observed_github_head: 'a'.repeat(40),
}, { development_branch: 'dev', production_branch: 'main' });
assert(coordinate.github_branch === 'main', 'production branch not derived');
```

A conflicting caller `github_branch:'dev'` must return `SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED`.

- [ ] **Step 2: Lock the v351 stale-receipt regression**

A manifest whose live files contain newer code but whose embedded receipt targets the previous Hatchable version/SHA remains `ok:false`. Sampling equality never upgrades provenance.

- [ ] **Step 3: Commit RED role-binding test and verify RED with the exact-revision loop**

The stale-receipt test may already be GREEN; keep it as a regression rather than weakening it.

- [ ] **Step 4: Implement the production coordinate wrapper**

```js
export function assertProductionSourceCoordinates(input, roles) {
  if (!roles?.production_branch) fail('SOURCE_SYNC_BRANCH_ROLE_REQUIRED', 'production source branch is not configured');
  if (input.github_branch != null && input.github_branch !== roles.production_branch) {
    fail('SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED', 'production source branch is derived from repository branch roles');
  }
  return assertSourceCoordinates({ ...input, github_branch: roles.production_branch });
}
```

- [ ] **Step 5: Document candidate vs verified receipt semantics**

```text
mutable draft receipt = candidate evidence
immutable deployment + exact target version + exact production SHA = verified materialization
```

- [ ] **Step 6: Verify GREEN with the exact-revision loop**

- [ ] **Step 7: Commit**

```bash
git add lib/source-sync.js lib/source-sync.test.js public/docs/source-sync.md
git commit -m "fix: bind production source sync to branch roles"
```

---

### Task 6: Protect default/development policy without confusing it with production

**Files:**
- Modify: `lib/github-required-checks.js`
- Modify: `lib/github-branch-policy.test.js`
- Modify: `public/docs/github-branch-policy.md`
- Reuse: `lib/github-default-branch.js`

**Interfaces:**
- Existing branch-policy reconciliation continues using `~DEFAULT_BRANCH`.
- After cutover that means `dev`.
- Production remains separately enforced by semantic mutation gates and exact-SHA promotion.

- [ ] **Step 1: Add regression proving branch policy follows default `dev`, not production `main`**

The test must construct a configured role binding with `dev/main` and a GitHub repository whose default branch is `dev`, then verify the managed ruleset target remains `~DEFAULT_BRANCH` and no code substitutes the production role.

- [ ] **Step 2: Verify the test is meaningful**

Run registry/static checks. If existing code already satisfies it, record it as a locked regression; otherwise use the exact-revision RED/GREEN loop.

- [ ] **Step 3: Update branch-policy docs**

State: default branch policy protects development integration. Production identity comes from repository branch roles, not `default_branch`.

- [ ] **Step 4: Verify exact-revision V8 GREEN**

- [ ] **Step 5: Commit**

```bash
git add lib/github-required-checks.js lib/github-branch-policy.test.js public/docs/github-branch-policy.md
git commit -m "docs: separate default and production branch policy"
```

---

### Task 7: Add a fail-closed self-hosting cutover planner

**Files:**
- Create: `lib/self-hosting-branch-cutover.js`
- Create: `lib/self-hosting-branch-cutover.test.js`
- Create: `public/docs/self-hosting-branch-cutover.md`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- Pure planner only. It recommends existing/new semantic operations; it does not become an all-powerful mutation endpoint.
- Input includes current main/default coordinates, immutable Hatchable verification result, branch-role binding state, and `dev` state.

- [ ] **Step 1: Add failing planner tests**

Safe sequence:

```text
verify current production branch head in immutable Hatchable
→ persist dev/main branch roles (freezes ordinary main mutation)
→ create dev + migrate default main→dev using github.default_branch.migrate
→ reconcile dev branch policy
→ reread main unchanged
→ cutover complete
```

Reject: unverified live deployment, production head mismatch, conflicting existing `dev`, production movement during cutover, or open executable PRs targeting production at the cutover checkpoint.

- [ ] **Step 2: Register/commit RED tests and verify RED with exact-revision V8**

- [ ] **Step 3: Implement pure next-action derivation**

If current production head is not immutably verified, return:

```js
{
  complete: false,
  next_action: 'materialize_and_verify_current_production_head'
}
```

Never recommend moving production backward to an older verified deployment.

- [ ] **Step 4: Document cutover choreography**

Use only:
- current source-materialization + immutable verification;
- `portfolio.repository.branch_roles.ensure`;
- existing `github.default_branch.migrate` to create `dev` at exact production head and make it default;
- `github.branch_policy.reconcile` on new default;
- authoritative GitHub ref rereads.

- [ ] **Step 5: Verify GREEN with exact-revision V8**

- [ ] **Step 6: Commit**

```bash
git add lib/self-hosting-branch-cutover.js lib/self-hosting-branch-cutover.test.js public/docs/self-hosting-branch-cutover.md lib/regression-suite-registry.js
git commit -m "feat: add fail-closed self-hosting branch cutover"
```

---

### Task 8: Cut Over Overcenter

**Files:**
- No source files expected. Operational migration only.

**Interfaces:**
- Produces final binding `{ development_branch:'dev', production_branch:'main' }` unless fresh authoritative source-binding evidence at execution time says Hatchable production follows a different GitHub branch.

- [ ] **Step 1: Re-read fresh authoritative state**

Read current production source branch from the latest source-materialization configuration/receipt, current branch head, current default branch, open PR bases, Hatchable live version, embedded receipt, and immutable deployment manifest. Do not reuse SHAs or versions from this design session.

- [ ] **Step 2: Converge current production source before cutover**

If production Hatchable is not immutably verified for the current production-branch head, rematerialize that current head, deploy, and verify. Do not move the GitHub branch backward.

- [ ] **Step 3: Clear/retarget executable PRs aimed at production**

Do not begin the cutover while an ordinary executable PR can still merge into the production branch.

- [ ] **Step 4: Persist branch roles first**

For current Overcenter evidence this should be:

```json
{
  "repository": "laurajoyhutchins/overcenter",
  "development_branch": "dev",
  "production_branch": "main",
  "production_source_ref": "hatchable:proj_I6FSm85xrY7T:source-materialization"
}
```

This intentionally causes a brief fail-closed period before `dev` exists: ordinary integration can no longer target `main`.

- [ ] **Step 5: Migrate default branch `main` → `dev` at the exact verified production SHA**

Use `github.default_branch.migrate`. It creates `dev` if absent and verifies the default-branch readback. Fail if an existing `dev` points anywhere else.

- [ ] **Step 6: Reconcile branch policy on `dev`**

Require the exact `dev` head and current required checks.

- [ ] **Step 7: Prove production remained pinned**

Reread the production branch. It must still equal the immutable verified SHA from Step 2.

- [ ] **Step 8: Dogfood one low-risk development cycle**

Create/use a conforming work branch from `dev`, open a PR to `dev`, integrate it, and verify production remains unchanged.

- [ ] **Step 9: Run exact-revision V8 verification for the resulting `dev` head**

Record the successful workflow run ID.

- [ ] **Step 10: Promote the exact `dev` SHA**

Call `github.production.promote` with the fresh dev/prod heads and successful exact-revision workflow run ID.

- [ ] **Step 11: Materialize the promoted production SHA to Hatchable and verify immutable deployment**

Healthy final state:

```text
GitHub default branch = dev
dev head = latest integrated development
production branch = explicitly promoted SHA
verified Hatchable deployed SHA = production branch SHA
embedded receipt target version = immutable live deployment version
```

Do not close #161.

---

## Final verification

Before claiming completion:

```bash
node scripts/verify-regression-suite-registry.mjs
find api lib mcp pages -type f -name '*.js' -print0 | xargs -0 -n1 node --check
```

Then dispatch and require success from `exact-revision-v8.yml` for the final implementation SHA. After self-hosting cutover, independently reread GitHub `dev`, production branch, GitHub default branch, latest production workflow evidence, Hatchable live deployment, immutable deployment manifest, and source-materialization receipt. Claims are based on those fresh reads, not on mutation responses alone.
