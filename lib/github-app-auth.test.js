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
