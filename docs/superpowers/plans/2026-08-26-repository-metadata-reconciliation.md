# Repository Metadata Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permanent Overcenter command that idempotently reconciles ordinary GitHub repository metadata without exposing identity, visibility, default-branch, or archive mutations.

**Architecture:** Implement one narrow desired-state command around GitHub's repository and topics endpoints. The command observes the complete managed state, optionally applies a complete optimistic expected-state fence, writes only changed fields, and rereads authoritative GitHub state before claiming success. GitHub App permissions remain fixed by the command.

**Tech Stack:** JavaScript ESM, Hatchable runtime, GitHub REST API 2026-03-10, Overcenter command-response and orchestration journal, Node test harness.

**Spec:** GitHub issue #79

## Global Constraints

- GitHub is repository/source authority.
- Overcenter owns orchestration, leases, evidence, and settlement.
- The command MUST fail closed when authoritative state or mutation outcome is ambiguous.
- Rename, default-branch migration, visibility, transfer, and archive semantics are out of scope.
- The command MUST use a fixed `administration: write` GitHub App permission profile.

---

### Task 1: Lock the command boundary with a failing repository-static regression

**Files:**
- Create: `scripts/verify-repository-metadata-command.test.mjs`
- Modify: `.github/workflows/regression-suite-registry.yml`

**Interfaces:**
- Consumes: current Overcenter command conventions.
- Produces: a CI regression that requires the semantic command, MCP/API surfaces, command-owned capability, and fail-closed error vocabulary.

- [ ] **Step 1:** Add the regression before production files exist.
- [ ] **Step 2:** Run repository verification through a draft pull request and confirm the new regression fails for the missing capability.
- [ ] **Step 3:** Preserve that failing run as TDD evidence.

### Task 2: Implement desired-state reconciliation and behavior tests

**Files:**
- Create: `lib/github-repository-metadata.js`
- Create: `lib/github-repository-metadata.test.js`
- Modify: `lib/regression-suite-registry.js`

**Interfaces:**
- Consumes: `withGitHubAppApiClient`, `boundedSafeRead`, `githubTransportEvidence`.
- Produces: `normalizeGithubRepositoryMetadataRequest`, `ensureGithubRepositoryMetadata`, and `ensureGithubRepositoryMetadataWithGitHubApp`.

- [ ] **Step 1:** Test validation, no-op, field-only mutation, topics replacement, stale expected-state rejection, permission failure, indeterminate-write reconciliation, and verification failure.
- [ ] **Step 2:** Implement the minimal observer, comparator, patch planner, writer, and authoritative readback needed to pass those tests.
- [ ] **Step 3:** Register the behavior suite in the canonical regression registry.

### Task 3: Wire command-owned authority and transport surfaces

**Files:**
- Modify: `lib/github-app-auth.js`
- Modify: `lib/command-response.js`
- Create: `api/github-repository-metadata-ensure.js`
- Create: `mcp/github_repository_metadata_ensure.js`

**Interfaces:**
- Consumes: `ensureGithubRepositoryMetadataWithGitHubApp`.
- Produces: canonical `github.repository_metadata.ensure` and MCP transport `github_repository_metadata_ensure`.

- [ ] **Step 1:** Add a fixed `repository_metadata` GitHub App profile with `administration: write` and fail-closed fallback.
- [ ] **Step 2:** Register stale-state and indeterminate-write semantics in command-response classification.
- [ ] **Step 3:** Add HTTP and correlated MCP wrappers with schemas that expose only ordinary metadata fields.

### Task 4: Verify and integrate the exact candidate

**Files:**
- No additional production files unless verification finds a defect.

**Interfaces:**
- Consumes: exact feature-branch head.
- Produces: review packet, repository-owned checks, merge evidence, and post-merge verification.

- [ ] **Step 1:** Run the complete registered regression suite and repository-static verification on the exact head.
- [ ] **Step 2:** Review the exact candidate and confirm no identity, visibility, default-branch, or archive mutation surface leaked in.
- [ ] **Step 3:** Merge through `github.integration.reconcile` only after checks are green.
- [ ] **Step 4:** Verify the merge commit on `main`, then settle the Overcenter verification gate with exact evidence.