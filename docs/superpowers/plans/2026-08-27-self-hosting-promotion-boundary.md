# Self-Hosting Promotion Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev` the development/default branch while preserving the GitHub branch already used by Hatchable as the production source, with exact-SHA promotion as the only Overcenter path into production.

**Architecture:** Persist explicit branch roles, enforce them at every existing GitHub semantic mutation boundary, reuse Overcenter's isolated exact-revision Hatchable V8 verifier as the promotion gate, and add one narrow ref-promotion command. Production source materialization derives its branch from the stored production role and is trusted only after immutable Hatchable deployment verification.

**Tech Stack:** JavaScript ES modules, Hatchable V8/PostgreSQL, GitHub App REST/Actions APIs, command-response-v1, orchestration journal, deterministic regression modules, `.github/workflows/exact-revision-v8.yml`.

**Spec:** `docs/superpowers/specs/2026-08-27-self-hosting-promotion-boundary-design.md`

## Global Constraints

- GitHub is authoritative for content, refs, commit identity, PRs, workflow runs, checks, and ancestry.
- Overcenter is authoritative for branch-role configuration, orchestration, promotion receipts, idempotency, recovery, and verified deployment coordinates.
- Managed development branch is literally `dev`.
- Production branch is the branch already used by the production runtime. Current Overcenter source-materialization evidence names `main`, so `main` remains production unless fresh cutover evidence says otherwise.
- After cutover, GitHub default branch is `dev`. Default branch and production branch are distinct concepts.
- Unconfigured repositories preserve current behavior until explicitly migrated.
- Ordinary changesets cannot mutate `dev` or the configured production branch.
- Ordinary PR creation/integration cannot target the configured production branch.
- Production promotion advances the existing production ref to an existing `dev` commit. It creates no commit/tree/blob.
- Ordinary promotion is fast-forward only. Rollback is separate and out of scope.
- Promotion requires a successful exact-revision V8 workflow run for the exact candidate SHA. Reuse `.github/workflows/exact-revision-v8.yml`; do not invent a second verifier.
- Hatchable production is not verified merely because a deployment is live.
- Source receipts bind an exact GitHub SHA and exact immediate Hatchable target version.
- Overcenter #161 remains open; this plan does not claim atomic Hatchable draft-to-deploy publication.

## Exact-revision verification loop

For every RED/GREEN checkpoint that changes registered runtime tests:

```bash
node scripts/verify-regression-suite-registry.mjs
find api lib mcp pages -type f -name '*.js' -print0 | xargs -0 -n1 node --check
SHA=$(git rev-parse HEAD)
BRANCH=$(git branch --show-current)
gh workflow run exact-revision-v8.yml --ref "$BRANCH" -f revision="$SHA"
RUN_ID=$(gh run list --workflow exact-revision-v8.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

For deliberate RED, the last command must exit non-zero because the new registered regression fails. For GREEN, it must exit zero. The workflow checks out the supplied SHA, materializes it into the isolated Hatchable verification project, verifies immutable verification-deployment bytes, and runs the canonical V8 regression endpoint. It already rejects using the production Hatchable project as the verification project.

---

### Task 1: Persist explicit repository branch roles

**Files:**
- Create: `migrations/051_repository_branch_roles.sql`
- Create: `lib/repository-branch-roles.js`
- Create: `lib/repository-branch-roles.test.js`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- `normalizeRepositoryBranchRoleBinding(input)` -> `{ repository, development_branch, production_branch, production_source_ref }`.
- `createPostgresRepositoryBranchRoleStore(dbBinding)` -> `{ get(repository), ensure(binding) }`.
- `resolveRepositoryBranchRoles(repository, { store })` -> canonical binding or `null`.

- [ ] **Step 1: Add failing tests**

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

await test('development and production cannot alias', async () => {
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

Also test same-binding `ensure()` replay and rejection of a changed existing production branch.

- [ ] **Step 2: Register the suite, commit the RED test, and run the exact-revision loop**

Expected: exact-revision verification fails because the new branch-role implementation is absent.

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

- [ ] **Step 4: Implement normalization/store**

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

`ensure()` must return the identical existing row on replay and fail with `REPOSITORY_BRANCH_ROLE_CHANGED` for a different existing binding.

- [ ] **Step 5: Run the exact-revision loop and require GREEN**

- [ ] **Step 6: Commit implementation**

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
- Command: `portfolio.repository.branch_roles.ensure`.
- Exact request: `{ repository, development_branch, production_branch, production_source_ref }`.

- [ ] **Step 1: Add failing tests for first ensure, identical replay, and conflicting rewrite**

Same request returns `changed:false`; changing production returns `REPOSITORY_BRANCH_ROLE_CHANGED` and performs no write.

- [ ] **Step 2: Commit RED and run the exact-revision loop**

- [ ] **Step 3: Implement the API using the existing correlated-command pattern**

```js
const response = await executeCorrelatedCommand(
  'portfolio.repository.branch_roles.ensure',
  req.body || {},
  (input) => createRepositoryBranchRoleService({ db }).ensure(input),
  { flattenDetails: true, db },
);
```

The MCP schema exposes only the four exact fields. `development_branch` must equal `dev`.

- [ ] **Step 4: Document `production_source_ref` semantics**

It records the source-binding observation used for migration. Default-branch changes do not rewrite production identity.

- [ ] **Step 5: Run the exact-revision loop and require GREEN**

- [ ] **Step 6: Commit implementation**

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
- Consumes Task 1 role resolver.
- Configured repos reserve both `dev` and production from ordinary content mutation.
- Configured PRs/integration require `dev` as base.

- [ ] **Step 1: Add failing PR-base tests**

`base:'main'` with roles `dev/main` returns `GITHUB_BRANCH_ROLE_VIOLATION`, `expected_base:'dev'`, and `may_have_mutated:false`; `base:'dev'` remains valid.

- [ ] **Step 2: Add failing integration tests**

A reread PR whose base is production must reject before update-branch or merge calls.

- [ ] **Step 3: Add failing changeset tests**

Both `branch:'dev'` and `branch:'main'` reject; a conforming `feat/...` branch remains allowed.

- [ ] **Step 4: Commit RED and run the exact-revision loop**

- [ ] **Step 5: Implement one shared branch-role guard**

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

Inject the database-backed resolver from API adapters; keep lower-level GitHub functions deterministic.

- [ ] **Step 6: Enforce `dev` independently in PR create and integration**

PR creation may retain caller `base` for compatibility but must require it to equal the resolved development branch. Integration rereads the PR and enforces the same rule independently.

- [ ] **Step 7: Update repository verification workflow push branches**

```yaml
push:
  branches: [dev, main]
```

Keep `pull_request:` unchanged.

- [ ] **Step 8: Run exact-revision verification and require GREEN**

- [ ] **Step 9: Commit implementation**

```bash
git add lib/github-pull-request-create.js lib/github-pull-request-create.test.js api/github-pull-request-create.js lib/github-integration.js lib/github-integration.test.js api/github-integration-reconcile.js lib/github-apply-changeset.js lib/github-apply-changeset.test.js api/github-apply-changeset.js .github/workflows/regression-suite-registry.yml
git commit -m "feat: enforce development and production branch roles"
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
- Modify: `lib/github-app-auth.js`
- Modify: `public/docs/github-capabilities.md`

**Interfaces:**
- Command: `github.production.promote`.
- Request: `{ repo, candidate_sha, observed_development_head, observed_production_head, verification_run_id, idempotency_key }`.
- Candidate must equal current `dev` head in v1.
- New GitHub App capability profile: `production_promotion` with `contents:'write'`, `actions:'read'`, fail-closed fallback.

- [ ] **Step 1: Add the promotion receipt table**

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

- [ ] **Step 2: Add failing promotion tests**

Cover exact candidate success; stale dev/prod; non-fast-forward; failed, incomplete, wrong-SHA, and wrong-workflow verification runs; idempotent replay/conflict; and proof that success calls no commit/tree/blob operation.

- [ ] **Step 3: Register/commit RED and run exact-revision verification**

- [ ] **Step 4: Add the permission capability**

In `GITHUB_APP_CAPABILITIES` add:

```js
production_promotion: Object.freeze({
  permissions: Object.freeze({ contents: 'write', actions: 'read' }),
  fallback: Object.freeze({ class: 'fail_closed', mechanism: null }),
}),
```

Use `{ permissionProfile: 'production_promotion' }` for the production-promotion GitHub App session.

- [ ] **Step 5: Implement the minimal adapter**

```js
{
  getBranch(repo, branch),
  compare(baseSha, headSha),
  getWorkflowRun(repo, runId),
  updateBranch(repo, branch, sha),
}
```

- [ ] **Step 6: Verify exact-revision evidence by authoritative workflow-run reread**

Require:

```js
run.path === '.github/workflows/exact-revision-v8.yml'
run.event === 'workflow_dispatch'
run.head_sha === candidate_sha
run.status === 'completed'
run.conclusion === 'success'
```

Do not substitute ordinary PR checks.

- [ ] **Step 7: Fence refs and ancestry**

```js
assert(dev.sha === request.observed_development_head);
assert(prod.sha === request.observed_production_head);
assert(request.candidate_sha === dev.sha);
assert(compare.status === 'ahead' || compare.status === 'identical');
```

Reread both refs immediately before mutation. If identical, return a verified no-change receipt. After mutation, reread production and require candidate equality.

- [ ] **Step 8: Reconcile uncertain ref-update transport by production-ref readback**

Candidate equality means recovered success; any other ref returns `GITHUB_PRODUCTION_PROMOTION_INDETERMINATE` with `may_have_mutated:true`.

- [ ] **Step 9: Wire API/MCP with `executeCorrelatedCommand` and durable receipt replay**

- [ ] **Step 10: Run exact-revision verification and require GREEN**

- [ ] **Step 11: Commit implementation**

```bash
git add migrations/052_github_production_promotion_receipts.sql lib/github-production-promotion.js lib/github-production-promotion.test.js api/github-production-promote.js mcp/github_production_promote.js public/docs/github-production-promotion.md lib/regression-suite-registry.js lib/github-app-auth.js public/docs/github-capabilities.md
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
- Production branch is derived; caller branch override is rejected.

- [ ] **Step 1: Add failing role-binding test**

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

Conflicting caller `github_branch:'dev'` returns `SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED`.

- [ ] **Step 2: Lock the v351 stale-receipt regression**

Newer live bytes plus a receipt targeting an older deployment/SHA must remain `ok:false`. Sampling equality never upgrades provenance.

- [ ] **Step 3: Commit RED role-binding test and run exact-revision verification**

The stale-receipt regression may already pass; preserve it as locked behavior.

- [ ] **Step 4: Implement the production wrapper**

```js
export function assertProductionSourceCoordinates(input, roles) {
  if (!roles?.production_branch) fail('SOURCE_SYNC_BRANCH_ROLE_REQUIRED', 'production source branch is not configured');
  if (input.github_branch != null && input.github_branch !== roles.production_branch) {
    fail('SOURCE_SYNC_BRANCH_OVERRIDE_REJECTED', 'production source branch is derived from repository branch roles');
  }
  return assertSourceCoordinates({ ...input, github_branch: roles.production_branch });
}
```

- [ ] **Step 5: Document candidate vs verified receipts**

```text
mutable draft receipt = candidate evidence
immutable deployment + exact target version + exact production SHA = verified materialization
```

- [ ] **Step 6: Run exact-revision verification and require GREEN**

- [ ] **Step 7: Commit implementation**

```bash
git add lib/source-sync.js lib/source-sync.test.js public/docs/source-sync.md
git commit -m "fix: bind production source sync to branch roles"
```

---

### Task 6: Keep default-branch policy attached to development

**Files:**
- Modify: `lib/github-required-checks.js`
- Modify: `lib/github-branch-policy.test.js`
- Modify: `public/docs/github-branch-policy.md`

**Interfaces:**
- Existing `~DEFAULT_BRANCH` ruleset continues to target the GitHub default branch.
- After migration this means `dev`, not production.

- [ ] **Step 1: Add regression with roles `dev/main` and GitHub default `dev`**

Assert the managed policy still targets `~DEFAULT_BRANCH` and no branch-policy code substitutes the production branch.

- [ ] **Step 2: Run registry/static checks**

If existing behavior already passes, keep the test as a locked regression. Otherwise commit RED and use the exact-revision loop.

- [ ] **Step 3: Update docs to state default-branch policy protects development integration**

Production identity comes from branch-role configuration, never `default_branch`.

- [ ] **Step 4: Run exact-revision verification and require GREEN**

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
- Pure planner only; no all-powerful cutover mutation endpoint.
- Produces the next safe semantic action from observed GitHub/Hatchable state.

- [ ] **Step 1: Add failing planner tests**

Safe sequence:

```text
verify current production head in immutable Hatchable
→ persist dev/production roles, freezing ordinary production mutation
→ github.default_branch.migrate production→dev at exact verified SHA
→ reconcile dev branch policy
→ reread production unchanged
→ cutover complete
```

Reject unverified production, production-head mismatch, conflicting existing `dev`, production movement during cutover, and executable PRs still targeting production.

- [ ] **Step 2: Register/commit RED and run exact-revision verification**

- [ ] **Step 3: Implement deterministic next-action derivation**

If current production head is not immutably verified, return:

```js
{ complete: false, next_action: 'materialize_and_verify_current_production_head' }
```

Never recommend moving production backward.

- [ ] **Step 4: Document choreography using only existing/new narrow semantic operations**

Use source materialization/verification, `portfolio.repository.branch_roles.ensure`, existing `github.default_branch.migrate`, `github.branch_policy.reconcile`, and authoritative rereads.

- [ ] **Step 5: Run exact-revision verification and require GREEN**

- [ ] **Step 6: Commit**

```bash
git add lib/self-hosting-branch-cutover.js lib/self-hosting-branch-cutover.test.js public/docs/self-hosting-branch-cutover.md lib/regression-suite-registry.js
git commit -m "feat: add fail-closed self-hosting branch cutover"
```

---

### Task 8: Cut Over Overcenter

**Files:**
- No source changes expected; operational migration only.

- [ ] **Step 1: Re-read fresh authoritative state**

Read current production source branch from latest source-binding evidence, its GitHub head, GitHub default branch, open PR bases, Hatchable live version, embedded receipt, and immutable deployment manifest. Do not reuse SHAs/versions from this design session.

- [ ] **Step 2: Converge production before cutover**

If Hatchable production is not immutably verified for the current production-branch head, rematerialize that current head, deploy, and verify. Never move GitHub production backward.

- [ ] **Step 3: Remove the production-PR race**

Do not cut over while any ordinary executable PR can still merge into production. Finish, close, or deliberately retarget those PRs before proceeding.

- [ ] **Step 4: Persist branch roles first**

For current Overcenter evidence the request is:

```json
{
  "repository": "laurajoyhutchins/overcenter",
  "development_branch": "dev",
  "production_branch": "main",
  "production_source_ref": "hatchable:proj_I6FSm85xrY7T:source-materialization"
}
```

This deliberately creates a brief fail-closed period where ordinary integration can no longer target production.

- [ ] **Step 5: Use `github.default_branch.migrate` to create `dev` at the exact verified production SHA and make it default**

Fail if existing `dev` points elsewhere.

- [ ] **Step 6: Reconcile branch policy on `dev`**

- [ ] **Step 7: Reread production and prove it remained pinned**

- [ ] **Step 8: Dogfood one low-risk work cycle into `dev`**

Verify production remains unchanged.

- [ ] **Step 9: Dispatch exact-revision V8 verification for the resulting `dev` head and record its successful run ID**

- [ ] **Step 10: Promote the exact `dev` head through `github.production.promote`**

- [ ] **Step 11: Materialize the promoted production SHA to Hatchable and require immutable production verification**

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

## Final Verification

```bash
node scripts/verify-regression-suite-registry.mjs
find api lib mcp pages -type f -name '*.js' -print0 | xargs -0 -n1 node --check
SHA=$(git rev-parse HEAD)
BRANCH=$(git branch --show-current)
gh workflow run exact-revision-v8.yml --ref "$BRANCH" -f revision="$SHA"
RUN_ID=$(gh run list --workflow exact-revision-v8.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

After cutover, independently reread GitHub `dev`, production branch, GitHub default branch, the successful exact-revision workflow run, Hatchable live deployment, immutable deployment manifest, and source-materialization receipt. Completion claims use those fresh observations, not mutation responses alone.
