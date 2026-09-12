import assert from "node:assert/strict";
import test from "node:test";

import {
  githubAppCapabilityCatalog,
  githubAppChangesetPermissionProfile,
  githubAppFallbackPolicy,
  githubAppPermissionProfile,
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
