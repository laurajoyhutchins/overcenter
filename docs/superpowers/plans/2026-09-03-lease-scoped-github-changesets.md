# Lease-Scoped GitHub Changesets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a graph-native project-transition `lease_ref` sufficient caller-visible authority for `github.apply_changeset`, so agents can submit only mutation intent while Overcenter derives repository, workspace branch, exact authority base, expected-head fencing, and idempotency identity.

**Architecture:** Preserve the existing explicit Git changeset engine as the sole mutation engine. Add subject-derived project-transition authority resolution, a typed deterministic workspace-identity module, and a lease-scoped request resolver that converts `{lease_ref, changes, commit_message}` into the existing fully explicit changeset request. The API adapter selects explicit mode when no `lease_ref` is present and lease-scoped mode otherwise. No Linear reads, no direct lease-row reads in the changeset resolver, and no branch/workspace fields added to `project.advance`.

**Tech Stack:** Node.js 22, JavaScript runtime adapters, TypeScript semantic kernel under `src/semantic/`, generated runtime mirrors under `lib/`, GitHub App transport, PostgreSQL-backed execution authority and compact provider-operation receipts, Node test harness.

**Spec:** `docs/design/2026-09-03-lease-scoped-github-changesets.md`

## Global Constraints

- Preserve explicit Git mode when `lease_ref` is absent.
- In lease-scoped mode, reject caller-supplied `repo`, `branch`, `base_ref`, `base_sha`, `expected_head`, `idempotency_key`, and `lease_token` before Git mutation.
- A lease-scoped request must resolve only through graph-native `project_transition` execution authority. Do not grant implicit workspace semantics to legacy work leases.
- Do not read Linear or query `work_leases` directly from the lease-scoped changeset resolver. The execution-authority service owns lease interpretation and stale-authority validation.
- Keep the existing Git changeset core responsible for tree/commit construction, branch creation/update, expected-head CAS, mutation certainty, reconciliation, and durable changeset receipts.
- Same repository + project + transition + transition-definition fingerprint + exact authority revision means the same workspace generation. A changed transition fingerprint or authority revision means a different generation.
- Requeue/reacquire may reuse a workspace generation, but a new lease must produce a new mutation-idempotency scope. Never use reacquisition to retry an unresolved ambiguous mutation from a previous lease.
- TypeScript under `src/semantic/` is authoritative for semantic-kernel logic. Regenerate checked-in `lib/*.js` mirrors mechanically; do not hand-maintain divergent copies.
- Do not solve issue #274's diagnosis behavior or the scheduled-worker self-disable defect in this change.

---

## Task 1: Let project-transition authority derive its own repository

**Files:**
- Modify: `src/semantic/execution-authority-core.ts`
- Regenerate: `lib/execution-authority-core.js`
- Modify tests: `lib/github-execution-authority-lease-ref.test.js`
- Modify tests if needed for static contract: `type-tests/execution-authority.test.ts`

- [ ] **1. Add the failing subject-derived authority regression.**

In `lib/github-execution-authority-lease-ref.test.js`, change/add the graph-native success case so it calls the authority service without repository input:

```js
results.push(await run('graph-native project transition authority derives repository from the verified lease subject', async () => {
  const service = projectTransitionFixture();
  const result = await service.require({ lease_ref: PROJECT_LEASE_REF });
  check(result.subject === 'project_transition', 'project transition authority was not discriminated by subject');
  check(result.repository === REPO, 'project transition authority did not derive repository from its verified subject');
  check(result.transition_id === TRANSITION_ID && result.run_id === PROJECT_RUN_ID, 'graph-native subject identity was incomplete');
  check(!('gate' in result), 'graph-native authority exposed a legacy lane gate');
  check(!('work_ref' in result), 'graph-native authority exposed a legacy Linear work identity');
}));
```

Keep the existing wrong-repository test using `service.require({ lease_ref: PROJECT_LEASE_REF, repository:'laurajoyhutchins/other' })`; optional caller repository remains a narrowing assertion when supplied.

- [ ] **2. Run only the authority regression and confirm RED.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubExecutionAuthorityLeaseRefTests } from './lib/github-execution-authority-lease-ref.test.js'; const r=await runGithubExecutionAuthorityLeaseRefTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected failure: the new no-repository case fails with `EXECUTION_AUTHORITY_INVALID` because current graph-native validation requires `requestedRepository`.

- [ ] **3. Make the smallest authority change in TypeScript.**

In the project-transition branch of `createExecutionAuthorityService().require`, change the required identity check from requiring both requested and subject repositories to requiring only the verified subject repository, while preserving an optional mismatch assertion:

```ts
const requestedRepository = repositoryIdentity(input.repository);
const subjectRepository = repositoryIdentity(subject?.repository);

if (!subject || !subjectProjectRef || !subjectTransitionId || !subjectRepository) {
  fail('EXECUTION_AUTHORITY_INVALID', 'project transition execution authority is missing durable subject identity', {
    lease_id: leaseId,
  });
}
if (requestedRepository && requestedRepository !== subjectRepository) {
  fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'project transition execution authority does not cover the requested repository', {
    lease_id: leaseId,
    repository: requestedRepository,
    authorized_repository: subjectRepository,
  });
}
```

Do not weaken the later graph/transition/fingerprint/epoch checks. Do not alter the legacy-work branch: legacy execution authority must still require a caller repository and lane scope.

- [ ] **4. Regenerate the runtime mirror, then typecheck.**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.semantic.runtime.json
node -e "require('node:fs').copyFileSync('dist/lib/execution-authority-core.js','lib/execution-authority-core.js')"
npm run typecheck
```

Expected: typecheck passes and `lib/execution-authority-core.js` is mechanically generated from the TypeScript source.

- [ ] **5. Re-run the focused authority suite.**

Use the command from step 2. Expected: all lease-ref authority tests pass, including wrong-repository, expired authority, stale project-transition authority, fingerprint mismatch, and production-factory injection cases.

- [ ] **6. Commit this isolated authority slice.**

```bash
git add src/semantic/execution-authority-core.ts lib/execution-authority-core.js lib/github-execution-authority-lease-ref.test.js type-tests/execution-authority.test.ts
git commit -m "feat: derive project transition repository authority"
```

---

## Task 2: Define deterministic project-transition GitHub workspace identity

**Files:**
- Create: `src/semantic/project-transition-github-workspace.ts`
- Create generated mirror: `lib/project-transition-github-workspace.js`
- Create: `lib/project-transition-github-workspace.test.js`
- Modify: `tsconfig.semantic.runtime.json`
- Modify: `scripts/build.mjs`
- Modify: `lib/regression-suite-registry.js`

- [ ] **1. Add a focused workspace test module first.**

Create `lib/project-transition-github-workspace.test.js` with cases proving:

```js
import {
  deriveProjectTransitionGithubWorkspace,
  projectTransitionGithubChangesetIdempotencyKey,
} from 'lib/project-transition-github-workspace.js';

const authority = {
  subject:'project_transition',
  lease_ref:'11111111-1111-4111-8111-111111111111',
  lease_id:'11111111-1111-4111-8111-111111111111',
  run_id:'run-1',
  authority_epoch:1,
  repository:'laurajoyhutchins/overcenter',
  project_ref:'github:laurajoyhutchins/overcenter',
  transition_id:'ignore-stale-historical-project-transition-leases',
  authority:{kind:'github',repository:'laurajoyhutchins/overcenter',revision:'1'.repeat(40),derivation:'overcenter-project-graph-v1'},
  graph_fingerprint:'a'.repeat(64),
  transition_definition_fingerprint:'b'.repeat(64),
};
```

Assert:
- exact replay of `deriveProjectTransitionGithubWorkspace(authority)` is stable;
- branch matches `work/[a-z0-9-]+-[0-9a-f]{24}`;
- same generation inputs with a different lease ref produce the same workspace digest and branch;
- changed `authority.revision` produces a different digest/branch;
- changed transition-definition fingerprint produces a different digest/branch;
- malformed/non-GitHub authority fails closed;
- idempotency keys differ for different `lease_ref` values even when workspace generation is identical;
- idempotency keys differ when `observed_head` advances;
- exact input replay produces the same idempotency key.

Export `runProjectTransitionGithubWorkspaceTests()` using the repository's existing result-collector pattern.

- [ ] **2. Run it directly and confirm RED because the module does not exist.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runProjectTransitionGithubWorkspaceTests } from './lib/project-transition-github-workspace.test.js'; const r=await runProjectTransitionGithubWorkspaceTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **3. Implement the semantic module in TypeScript.**

Create `src/semantic/project-transition-github-workspace.ts`. Use `canonicalJson` and `sha256Text` and validate the authority coordinate before hashing. The generation digest must bind exactly:

```ts
const generation = {
  schema:'project-transition-github-workspace-generation-v1',
  repository,
  project_ref: projectRef,
  transition_id: transitionId,
  transition_definition_fingerprint: transitionFingerprint,
  authority_revision: authorityRevision,
};
const workspaceDigest = await sha256Text(canonicalJson(generation));
```

Derive a bounded slug from `transition_id`:

```ts
function transitionSlug(value: string): string {
  const slug = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
  return slug || 'transition';
}
```

Return a branch of exactly:

```ts
const branch = `work/${transitionSlug(transitionId)}-${workspaceDigest.slice(0, 24)}`;
```

Expose a second helper whose idempotency digest binds the lease, workspace generation, observed head or `null`, and canonical explicit changeset semantic hash:

```ts
export async function projectTransitionGithubChangesetIdempotencyKey(input: Readonly<{
  lease_ref: string;
  workspace_digest: string;
  observed_head: string | null;
  changeset_sha256: string;
}>): Promise<string> {
  const digest = await sha256Text(canonicalJson({
    schema:'project-transition-github-changeset-intent-v1',
    lease_ref:input.lease_ref,
    workspace_digest:input.workspace_digest,
    observed_head:input.observed_head,
    changeset_sha256:input.changeset_sha256,
  }));
  return `project-transition-changeset-v1:${digest}`;
}
```

- [ ] **4. Add the module to semantic runtime generation.**

Add `src/semantic/project-transition-github-workspace.ts` to `tsconfig.semantic.runtime.json` and `project-transition-github-workspace.js` to the runtime mirror list in `scripts/build.mjs`.

Generate and copy the mirror:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.semantic.runtime.json
node -e "require('node:fs').copyFileSync('dist/lib/project-transition-github-workspace.js','lib/project-transition-github-workspace.js')"
npm run typecheck
```

- [ ] **5. Register and run the new regression suite.**

Add the import and one `github_integration` suite entry to `lib/regression-suite-registry.js`, then run:

```bash
node scripts/verify-regression-suite-registry.mjs
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runProjectTransitionGithubWorkspaceTests } from './lib/project-transition-github-workspace.test.js'; const r=await runProjectTransitionGithubWorkspaceTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **6. Commit the workspace-identity slice.**

```bash
git add src/semantic/project-transition-github-workspace.ts lib/project-transition-github-workspace.js lib/project-transition-github-workspace.test.js tsconfig.semantic.runtime.json scripts/build.mjs lib/regression-suite-registry.js
git commit -m "feat: derive project transition GitHub workspaces"
```

---

## Task 3: Admit the managed `work/` branch namespace without weakening branch roles

**Files:**
- Modify: `lib/branch-policy-v1.js`
- Modify tests: `lib/github-branch-policy.test.js`
- Modify tests: `lib/github-branch-role-runtime.test.js`

- [ ] **1. Make branch-policy tests red.**

Change the exact vocabulary assertion to include `work`:

```js
assert(JSON.stringify(WORK_BRANCH_TYPES) === JSON.stringify([
  'feat','fix','refactor','test','docs','chore','research','work'
]), 'branch types drifted');
```

Add `work/ignore-stale-historical-project-transition-leases-0123456789abcdef01234567` to accepted examples.

In `lib/github-branch-role-runtime.test.js`, make the allowed work-branch assertion use a `work/...` branch and retain the existing checks that `dev` and `main` reject before delegation.

- [ ] **2. Run the two focused suites and confirm RED on `work/`.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubBranchPolicyTests } from './lib/github-branch-policy.test.js'; const r=await runGithubBranchPolicyTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubBranchRoleRuntimeTests } from './lib/github-branch-role-runtime.test.js'; const r=await runGithubBranchRoleRuntimeTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **3. Add only `work` to `WORK_BRANCH_TYPES`.**

Do not change the grammar, managed dev/prod role checks, merge policy, or grandfathering rules.

- [ ] **4. Re-run both suites and commit.**

```bash
git add lib/branch-policy-v1.js lib/github-branch-policy.test.js lib/github-branch-role-runtime.test.js
git commit -m "feat: admit managed execution work branches"
```

---

## Task 4: Resolve a lease-scoped request into the existing explicit changeset contract

**Files:**
- Create: `lib/github-lease-scoped-changeset.js`
- Create: `lib/github-lease-scoped-changeset.test.js`
- Modify: `lib/regression-suite-registry.js`

- [ ] **1. Write the dogfood regression first.**

The test must start with exactly the caller-visible shape that failed in production:

```js
const input = {
  lease_ref: PROJECT_LEASE_REF,
  changes:[{ path:'lib/orchestration-diagnose.js', operation:'update', content:'fixture\n' }],
  commit_message:'fix: classify current and historical transition leases',
};
```

Inject:
- an `executionAuthority` whose `require({lease_ref})` returns verified graph-native authority;
- `readBranch(repo, branch)` returning `null` for first generation or a SHA for resumed work.

Assert the resolver returns an explicit low-level request containing derived `repo`, `base_sha`, `branch`, `expected_head`, and `idempotency_key`, while the original input contains none of those fields.

- [ ] **2. Add fail-closed validation cases before implementation.**

For every forbidden field below, clone the lease-scoped input, add the field, call the resolver, and assert `INVALID_REQUEST` before `executionAuthority.require` or `readBranch` is invoked:

```text
repo
branch
base_ref
base_sha
expected_head
idempotency_key
lease_token
```

Also assert unknown top-level fields reject. Assert a resolved legacy-work authority rejects with a dedicated `LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED` (HTTP/precondition mapping can happen in Task 5).

- [ ] **3. Run the new suite and confirm RED.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubLeaseScopedChangesetTests } from './lib/github-lease-scoped-changeset.test.js'; const r=await runGithubLeaseScopedChangesetTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **4. Implement the resolver as a pure coordination layer.**

`lib/github-lease-scoped-changeset.js` should import:

```js
import { githubChangesetSemanticRequestHash } from 'lib/github-apply-changeset.js';
import {
  deriveProjectTransitionGithubWorkspace,
  projectTransitionGithubChangesetIdempotencyKey,
} from 'lib/project-transition-github-workspace.js';
```

Export:

```js
export async function resolveGithubLeaseScopedChangeset(input, {
  executionAuthority,
  readBranch,
} = {})
```

Algorithm:
1. exact-field validate `{lease_ref, changes, commit_message}` before any dependency call;
2. call `executionAuthority.require({ lease_ref })`;
3. require `authority.subject === 'project_transition'`;
4. derive workspace from verified authority;
5. call `readBranch({ repo:workspace.repository, branch:workspace.branch, changes:input.changes })`;
6. normalize observed head to full SHA or `null`;
7. construct an explicit request with `repo`, `base_sha:workspace.authority_revision`, derived `branch`, `expected_head:observedHead`, original `changes`, and `commit_message`;
8. compute `changeset_sha256 = await githubChangesetSemanticRequestHash(explicitRequest)`;
9. derive idempotency key from `lease_ref`, `workspace_digest`, `observed_head`, and `changeset_sha256`;
10. return the explicit request plus enriched non-secret execution-authority evidence.

The enriched authority evidence should add:

```js
github_workspace: {
  schema:'project-transition-github-workspace-v1',
  workspace_digest:workspace.workspace_digest,
  branch:workspace.branch,
  authority_revision:workspace.authority_revision,
  observed_head:observedHead,
}
```

Do not perform a Git write in this module.

- [ ] **5. Add generation/reacquisition/idempotency tests.**

Prove:
- same generation + different lease ref => same branch, different derived idempotency key;
- same lease + changed observed head => new idempotency key;
- changed authority revision => different branch;
- changed transition fingerprint => different branch;
- a stale/expired/settled authority error prevents `readBranch`;
- no Linear adapter is accepted or invoked by this resolver.

- [ ] **6. Register the suite, run it, and commit.**

```bash
node scripts/verify-regression-suite-registry.mjs
git add lib/github-lease-scoped-changeset.js lib/github-lease-scoped-changeset.test.js lib/regression-suite-registry.js
git commit -m "feat: resolve lease-scoped GitHub changesets"
```

---

## Task 5: Wire lease-scoped mode through `api/github-apply-changeset.js`

**Files:**
- Modify: `api/github-apply-changeset.js`
- Modify: `lib/github-apply-changeset.test.js`
- Modify: `lib/github-execution-authority.test.js` only if receipt assertions belong there
- Modify: `lib/orchestration-journal.js` only for safe request projection of `lease_ref` if tests show the journal otherwise loses the caller-visible target

- [ ] **1. Add an end-to-end in-memory acceptance test before changing API wiring.**

Use the existing `FakeGithub` and `MemoryReceipts` in `lib/github-apply-changeset.test.js`. Resolve a lease-only request, then feed the resolved request to `applyGithubChangeset` with an injected execution-authority wrapper that returns the resolver's already-verified enriched authority.

The assertion must prove:

```js
check(result.ok === true, 'lease-scoped changeset failed');
check(result.branch.startsWith('work/'), 'managed workspace branch was not derived');
check(result.base_sha === AUTHORITY_REVISION, 'exact authority revision was not the workspace generation base');
check(result.execution_authority?.lease_ref === PROJECT_LEASE_REF, 'receipt lost project-transition lease evidence');
check(result.execution_authority?.github_workspace?.branch === result.branch, 'receipt lost derived workspace evidence');
```

This is the first complete regression for the original dogfood failure: no caller branch/repository/base/head/idempotency input, yet one exact Git mutation succeeds.

- [ ] **2. Run the focused changeset suite and confirm RED until the integration seam exists.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubApplyChangesetTests } from './lib/github-apply-changeset.test.js'; const r=await runGithubApplyChangesetTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **3. Add production branch-read plumbing without creating a second Git implementation.**

In `api/github-apply-changeset.js`, import:

```js
import { createGithubApiAdapter } from 'lib/github-apply-changeset.js';
import { githubAppChangesetPermissionProfile, withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { resolveGithubLeaseScopedChangeset } from 'lib/github-lease-scoped-changeset.js';
```

Add a read helper that uses the same command-owned permission profile as the eventual mutation:

```js
async function readManagedWorkspaceBranch({ repo, branch, changes }) {
  const permissionProfile = githubAppChangesetPermissionProfile(
    (Array.isArray(changes) ? changes : []).map(change => change?.path),
  );
  return withGitHubAppApiClient(repo, async (apiClient) => {
    return createGithubApiAdapter(apiClient).getBranch(repo, branch);
  }, { permissionProfile });
}
```

- [ ] **4. Replace the current lease-ref wrapper with lease-scoped resolution.**

Keep explicit mode exactly as-is. For `lease_ref` mode:

```js
const authority = createPostgresExecutionAuthorityService({ db });
const resolved = await resolveGithubLeaseScopedChangeset(commandInput, {
  executionAuthority:authority,
  readBranch:readManagedWorkspaceBranch,
});
const executionAuthority = {
  async require() {
    return resolved.execution_authority;
  },
};
return applyGithubChangesetRoleAware(resolved.request, {
  db,
  executionAuthority,
  run_id:runId,
});
```

Do not pass caller Git coordinates through this path. Do not make the low-level changeset core aware of project graphs.

- [ ] **5. Map the lease-scoped subject error to a fail-closed request/precondition status.**

Add `LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED` to `statusFor` as 409 (or the repository's established precondition status if an existing classifier already supplies it). Add a test that legacy work authority produces no Git ref/tree/commit mutation.

- [ ] **6. Re-run the focused changeset and authority suites.**

```bash
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubApplyChangesetTests } from './lib/github-apply-changeset.test.js'; const r=await runGithubApplyChangesetTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubExecutionAuthorityTests } from './lib/github-execution-authority.test.js'; const r=await runGithubExecutionAuthorityTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **7. Commit the API integration slice.**

```bash
git add api/github-apply-changeset.js lib/github-apply-changeset.test.js lib/github-execution-authority.test.js lib/orchestration-journal.js
git commit -m "feat: apply GitHub changesets from transition leases"
```

Only add files that actually changed.

---

## Task 6: Prove replay, resume, races, and compatibility as one acceptance matrix

**Files:**
- Modify: `lib/github-lease-scoped-changeset.test.js`
- Modify: `lib/github-apply-changeset.test.js`
- Modify: `lib/github-branch-role-runtime.test.js` if needed for derived branch evidence

- [ ] **1. Add the exact replay case.**

Resolve a lease-scoped request against an absent workspace branch, apply it using `MemoryReceipts`, then replay the identical resolved request without changing observed state. Assert:
- second response has `idempotent_replay:true`;
- same `commit_sha`;
- `commitCreates === 1` and ref mutation count does not increase.

- [ ] **2. Add iterative TDD under one lease.**

After the first successful write, resolve a second mutation under the same lease with `readBranch` returning the first commit SHA. Assert:
- branch is unchanged;
- `expected_head` equals the first commit SHA;
- second derived idempotency key differs from the first;
- the second commit parents the current workspace head and advances the same branch once.

- [ ] **3. Add requeue/reacquisition workspace reuse.**

Use two different valid lease refs whose verified authority has identical repository/project/transition/fingerprint/revision. Assert:
- workspace digest and branch are identical;
- second lease observes and fences against the current workspace head;
- mutation idempotency keys differ because `lease_ref` differs.

This proves progress survives requeue without stale lease authority surviving.

- [ ] **4. Add new-generation cases.**

For changed transition-definition fingerprint and changed authority revision, assert the resolver derives a different `work/` branch and does not target the old workspace branch.

- [ ] **5. Preserve existing Git race behavior.**

Reuse `FakeGithub.beforeFinal` to prove:
- two requests resolved against the same existing workspace head cannot both advance it; one returns `HEAD_MISMATCH`;
- concurrent creation of the same deterministic managed branch returns `BRANCH_CREATION_RACE` and does not overwrite the concurrent branch.

Do not add a new locking mechanism. The point is to prove lease-scoped derivation composes with the existing CAS transaction.

- [ ] **6. Prove explicit Git mode is unchanged.**

Keep the existing explicit `request()` fixtures in `lib/github-apply-changeset.test.js` green. Add no conditional behavior to `normalizeGithubChangesetRequest`; lease-scoped requests must be resolved before reaching it.

- [ ] **7. Run all directly affected regression groups.**

```bash
node scripts/verify-regression-suite-registry.mjs
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubLeaseScopedChangesetTests } from './lib/github-lease-scoped-changeset.test.js'; const r=await runGithubLeaseScopedChangesetTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubApplyChangesetTests } from './lib/github-apply-changeset.test.js'; const r=await runGithubApplyChangesetTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubExecutionAuthorityLeaseRefTests } from './lib/github-execution-authority-lease-ref.test.js'; const r=await runGithubExecutionAuthorityLeaseRefTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --input-type=module -e "import { runGithubBranchPolicyTests } from './lib/github-branch-policy.test.js'; const r=await runGithubBranchPolicyTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **8. Commit the completed acceptance matrix.**

```bash
git add lib/github-lease-scoped-changeset.test.js lib/github-apply-changeset.test.js lib/github-branch-role-runtime.test.js
git commit -m "test: prove lease-scoped changeset recovery semantics"
```

Only add files that actually changed.

---

## Task 7: Full repository verification and design promotion

**Files:**
- Modify after verification: `docs/design/2026-09-03-lease-scoped-github-changesets.md`

- [ ] **1. Verify generated runtime parity.**

```bash
npm run typecheck
npm run build:runtime
```

Expected: strict semantic typecheck passes and every checked-in generated `lib/*.js` mirror byte-matches emitted TypeScript runtime output.

- [ ] **2. Run the canonical repository tests.**

```bash
npm test
```

Expected: regression-suite registry, maintained script tests, exact-revision verification tests, and syntax checks all pass.

- [ ] **3. Run the canonical full verification gate.**

```bash
npm run verify
```

Expected: tests, build, and public-release verification pass on the same exact head.

- [ ] **4. Inspect the final diff for boundary leakage.**

```bash
git diff dev...HEAD -- src/semantic lib api scripts tsconfig.semantic.runtime.json docs/design/2026-09-03-lease-scoped-github-changesets.md
```

Reject the implementation if any of these appear:
- `project.advance` gains branch/workspace coordinates;
- lease-scoped caller input accepts `repo`, branch/base/head, idempotency, or token overrides;
- the resolver queries Linear or `work_leases` directly;
- a second Git mutation engine appears;
- automatic cross-generation rebase/transplant logic appears;
- existing explicit changeset behavior is weakened.

- [ ] **5. Promote the design status only after all verification is green.**

Change the first status line in `docs/design/2026-09-03-lease-scoped-github-changesets.md` to:

```md
> **Document status: Accepted and implemented design decision.** Exact current runtime behavior remains defined by repository source and executable contracts.
```

Do not claim implementation before the exact verification head passes.

- [ ] **6. Commit the verified documentation state.**

```bash
git add docs/design/2026-09-03-lease-scoped-github-changesets.md
git commit -m "docs: mark lease-scoped changesets implemented"
```

- [ ] **7. Record final evidence for handoff.**

Report:
- exact final commit SHA;
- `npm run typecheck` result;
- `npm run build:runtime` result;
- `npm test` result;
- `npm run verify` result;
- focused lease-scoped acceptance-suite result;
- confirmation that the dogfood caller shape `{lease_ref, changes, commit_message}` is now executable without branch/repository/base/head/idempotency selection.
