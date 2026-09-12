import assert from "node:assert/strict";
import test from "node:test";

import {
  githubAppCapabilityCatalog,
  githubAppChangesetPermissionProfile,
  githubAppFallbackPolicy,
  githubAppPermissionProfile,
  inspectGitHubAppCapabilities,
} from "./github-app-auth.js";

test("github App auth uses least-privilege capability profiles", () => {
  assert.deepEqual(githubAppPermissionProfile("changeset"), { contents: "write" });
  assert.deepEqual(githubAppPermissionProfile("workflow_changeset"), {
    contents: "write",
    workflows: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("project_facts"), { contents: "read" });
});

test("github App auth applies workflow permission only when the changeset touches workflows", () => {
  assert.equal(githubAppChangesetPermissionProfile(["lib/example.js"]), "changeset");
  assert.equal(githubAppChangesetPermissionProfile([".github/workflows/verify.yml"]), "workflow_changeset");
  assert.equal(githubAppChangesetPermissionProfile(["lib/example.js", ".github/workflows"]), "workflow_changeset");
});

test("github App capability catalog exposes permission and fallback policy together", () => {
  const catalog = githubAppCapabilityCatalog();
  assert.deepEqual(catalog.changeset, {
    permissions: { contents: "write" },
    fallback: { class: "fail_closed", mechanism: null },
  });
  assert.deepEqual(catalog.integration_update, {
    permissions: { contents: "write", pull_requests: "write" },
    fallback: { class: "equivalent_fallback", mechanism: "isolated_worktree_update" },
  });
});

test("github App fallback policy remains command-owned", () => {
  assert.deepEqual(githubAppFallbackPolicy("review_checks"), {
    class: "degraded_observation",
    mechanism: "partial_review_packet",
  });
  assert.deepEqual(githubAppFallbackPolicy("changeset"), {
    class: "fail_closed",
    mechanism: null,
  });
});

test("GitHub App capability inspection classifies permission denial per capability", async () => {
  const result = await inspectGitHubAppCapabilities("laurajoyhutchins/overcenter", {
    withGitHubAppApiClient: async (_repo, callback, options = {}) => {
      if (options.permissionProfile === "changeset") {
        throw Object.assign(new Error("Resource not accessible by integration permission"), { status: 403 });
      }
      return callback({});
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.changeset.permission_available, false);
  assert.equal(result.capabilities.changeset.unavailable_reason, "permission_denied");
  assert.equal(result.capabilities.changeset.error, "GITHUB_APP_PERMISSION_DENIED");
  assert.equal(result.capabilities.project_facts.permission_available, true);
});

test("GitHub App capability inspection reuses probes for identical permission sets", async () => {
  const profiles = [];
  const result = await inspectGitHubAppCapabilities("laurajoyhutchins/overcenter", {
    withGitHubAppApiClient: async (_repo, callback, options = {}) => {
      profiles.push(options.permissionProfile);
      return callback({});
    },
  });

  assert.equal(result.ok, true);
  assert.ok(profiles.length < Object.keys(githubAppCapabilityCatalog()).length);
  assert.ok(Object.values(result.capabilities).every((capability) => capability.permission_available === true));
});

test("GitHub App capability inspection classifies missing installations", async () => {
  const result = await inspectGitHubAppCapabilities("laurajoyhutchins/overcenter", {
    withGitHubAppApiClient: async () => {
      throw Object.assign(new Error("installation missing"), { status: 404 });
    },
  });

  assert.equal(result.capabilities.changeset.permission_available, false);
  assert.equal(result.capabilities.changeset.unavailable_reason, "installation_not_found");
  assert.equal(result.capabilities.changeset.error, "GITHUB_APP_INSTALLATION_NOT_FOUND");
  assert.equal(result.capabilities.changeset.upstream_status, 404);
});

test("GitHub App capability inspection classifies setup-required probes", async () => {
  const result = await inspectGitHubAppCapabilities("laurajoyhutchins/overcenter", {
    withGitHubAppApiClient: async () => {
      throw new Error("config/get 412: declared as required but not set");
    },
  });

  assert.equal(result.capabilities.changeset.permission_available, false);
  assert.equal(result.capabilities.changeset.unavailable_reason, "setup_required");
  assert.equal(result.capabilities.changeset.error, "GITHUB_APP_SETUP_REQUIRED");
});

test("GitHub App internal capability lookups fail closed for unknown names", () => {
  assert.throws(
    () => githubAppPermissionProfile("not-a-profile"),
    (error) => error?.code === "INVALID_GITHUB_APP_PERMISSION_PROFILE",
  );
  assert.throws(
    () => githubAppFallbackPolicy("not-a-capability"),
    (error) => error?.code === "INVALID_GITHUB_APP_CAPABILITY",
  );
});

test("github App privileged permission profiles remain command-scoped", () => {
  assert.deepEqual(githubAppPermissionProfile("delete_branch"), {
    contents: "write",
    pull_requests: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("review_packet"), {
    pull_requests: "read",
    metadata: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("required_checks"), {
    administration: "write",
    checks: "read",
  });

  const changeset = githubAppPermissionProfile("changeset");
  assert.equal("pull_requests" in changeset, false);
  assert.equal("checks" in changeset, false);
  assert.equal("statuses" in changeset, false);
  assert.equal("administration" in changeset, false);
});

test("github App optional review observation remains degraded rather than fabricated", () => {
  assert.deepEqual(githubAppFallbackPolicy("review_pull_requests"), {
    class: "degraded_observation",
    mechanism: "partial_review_packet",
  });
  assert.deepEqual(githubAppFallbackPolicy("review_statuses"), {
    class: "degraded_observation",
    mechanism: "partial_review_packet",
  });
});

test("github App repository policy mutation profiles remain narrowly scoped", () => {
  assert.deepEqual(githubAppPermissionProfile("branch_policy"), {
    administration: "write",
    checks: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("stack_reconcile"), {
    pull_requests: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("integration_merge"), {
    contents: "write",
    pull_requests: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("default_branch_migrate"), {
    administration: "write",
    contents: "write",
  });
});

test("github App Pages capabilities do not widen ordinary changeset authority", () => {
  assert.deepEqual(githubAppPermissionProfile("pages_ensure"), {
    pages: "write",
    administration: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("pages_dispatch"), {
    actions: "write",
  });

  const changeset = githubAppPermissionProfile("changeset");
  assert.equal("pages" in changeset, false);
  assert.equal("actions" in changeset, false);
  assert.equal("administration" in changeset, false);
});
