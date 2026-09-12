import assert from "node:assert/strict";
import test from "node:test";

import {
  createInstallationResolver,
  githubAppCapabilityCatalog,
  githubAppChangesetPermissionProfile,
  githubAppFallbackPolicy,
  githubAppPermissionProfile,
  githubRequest,
  inspectGitHubAppCapabilities,
  installationTokenRequestBody,
  withInstallationTokenClient,
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

test("github App pull-request mutations remain fail closed", () => {
  const catalog = githubAppCapabilityCatalog();
  assert.deepEqual(catalog.pull_request_create.permissions, {
    contents: "read",
    pull_requests: "write",
  });
  assert.deepEqual(catalog.pull_request_create.fallback, {
    class: "fail_closed",
    mechanism: null,
  });
  assert.deepEqual(catalog.pull_request_mark_ready.permissions, {
    contents: "write",
    pull_requests: "write",
  });
  assert.deepEqual(catalog.pull_request_mark_ready.fallback, {
    class: "fail_closed",
    mechanism: null,
  });
});

test("github App review observation permission profiles remain isolated", () => {
  assert.deepEqual(githubAppPermissionProfile("review_pull_requests"), {
    pull_requests: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("review_checks"), {
    checks: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("review_statuses"), {
    statuses: "read",
  });
});

test("github App equivalent mutation fallback stays limited to integration update", () => {
  const equivalents = Object.entries(githubAppCapabilityCatalog())
    .filter(([, entry]) => entry.fallback.class === "equivalent_fallback")
    .map(([name]) => name);

  assert.deepEqual(equivalents, ["integration_update"]);
  assert.deepEqual(githubAppFallbackPolicy("integration_update"), {
    class: "equivalent_fallback",
    mechanism: "isolated_worktree_update",
  });
  assert.equal(githubAppFallbackPolicy("stack_reconcile").class, "fail_closed");
});

test("github App repository administration capabilities remain distinct", () => {
  assert.deepEqual(githubAppPermissionProfile("repository_metadata"), {
    administration: "write",
    metadata: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("repository_template"), {
    administration: "write",
    metadata: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("repository_from_template"), {
    administration: "write",
    contents: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("milestone"), {
    pull_requests: "write",
    metadata: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("release"), {
    contents: "write",
  });
});

test("github App Actions capabilities remain operation-specific", () => {
  assert.deepEqual(githubAppPermissionProfile("actions_storage_read"), {
    actions: "read",
  });
  assert.deepEqual(githubAppPermissionProfile("actions_storage_delete"), {
    actions: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("production_materialization_dispatch"), {
    actions: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("actions_retention"), {
    administration: "write",
  });
  assert.deepEqual(githubAppPermissionProfile("workflow_dispatch"), {
    actions: "write",
  });
});

test("github App workflow permission detection rejects lookalike prefixes", () => {
  assert.equal(
    githubAppChangesetPermissionProfile([".github/workflows-not-really/ci.yml"]),
    "changeset",
  );
  assert.equal("workflows" in githubAppPermissionProfile("changeset"), false);
});

test("github App fallback taxonomy is closed and permission profiles match the catalog", () => {
  const catalog = githubAppCapabilityCatalog();
  const allowed = new Set(["equivalent_fallback", "degraded_observation", "fail_closed"]);

  assert.ok(Object.keys(catalog).length > 0);
  for (const [name, entry] of Object.entries(catalog)) {
    assert.equal(allowed.has(entry.fallback.class), true, `${name} has an unknown fallback class`);
    assert.deepEqual(
      entry.permissions,
      githubAppPermissionProfile(name),
      `${name} permission profile diverged from capability catalog`,
    );
  }
});

test("github App removed classic protection profile remains unavailable", () => {
  assert.throws(
    () => githubAppPermissionProfile("review_protection"),
    (error) => error?.code === "INVALID_GITHUB_APP_PERMISSION_PROFILE",
  );
});

test("GitHub App capability inspection keeps denied stack authority fail closed", async () => {
  const result = await inspectGitHubAppCapabilities("laurajoyhutchins/overcenter", {
    withGitHubAppApiClient: async (_repo, callback, options = {}) => {
      if (options.permissionProfile === "stack_reconcile") {
        throw Object.assign(new Error("permissions not permitted"), { status: 422 });
      }
      return callback({});
    },
  });

  assert.equal(result.capabilities.stack_reconcile.permission_available, false);
  assert.equal(result.capabilities.stack_reconcile.fallback.class, "fail_closed");
  assert.equal(result.capabilities.integration_update.permission_available, true);
});

test("GitHub App installation-wide token scope stays reserved for repository templates", () => {
  assert.deepEqual(
    installationTokenRequestBody("owner/repo", "changeset", "repository"),
    { repositories: ["repo"], permissions: { contents: "write" } },
  );

  const template = installationTokenRequestBody(
    "owner/template",
    "repository_from_template",
    "installation",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(template, "repositories"), false);
  assert.deepEqual(template.permissions, { administration: "write", contents: "read" });
  assert.throws(
    () => installationTokenRequestBody("owner/repo", "changeset", "installation"),
    (error) => error?.code === "GITHUB_APP_INSTALLATION_WIDE_TOKEN_FORBIDDEN",
  );
});

test("GitHub App installation tokens stay hidden and are revoked after use", async () => {
  const auth = { token: "secret-token", installationId: 1 };
  let revoked = false;
  const result = await withInstallationTokenClient(
    auth,
    async (client) => {
      assert.equal("token" in client, false);
      await client.call("github", { path: "/fixture" });
      return { ok: true };
    },
    {
      rawRequest: async () => ({ status: 200, body: { ok: true } }),
      revokeRequest: async (path, options) => {
        revoked = path === "/installation/token"
          && options.method === "DELETE"
          && options.token === "secret-token";
        return { status: 204 };
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(revoked, true);
});

test("GitHub App token client does not log token material", async () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    await withInstallationTokenClient(
      { token: "secret-token", installationId: 1 },
      async (client) => {
        await client.call("github", { path: "/fixture" });
        return { ok: true };
      },
      {
        rawRequest: async () => ({ status: 200, body: {} }),
        revokeRequest: async () => ({ status: 204 }),
      },
    );
  } finally {
    console.log = original;
  }

  assert.equal(captured.join("\n").includes("secret-token"), false);
});

test("GitHub App installation identity cache supports reuse and invalidation", async () => {
  let lookups = 0;
  const resolver = createInstallationResolver({
    lookup: async () => {
      lookups += 1;
      return 40 + lookups;
    },
    now: () => 1000,
    sleep: async () => {},
    cache: new Map(),
  });

  const first = await resolver.resolve("owner/repo", "jwt-1");
  const cached = await resolver.resolve("owner/repo", "jwt-2");
  assert.equal(first, 41);
  assert.equal(cached, 41);
  assert.equal(lookups, 1);

  resolver.invalidate("owner/repo");
  const refreshed = await resolver.resolve("owner/repo", "jwt-3");
  assert.equal(refreshed, 42);
  assert.equal(lookups, 2);
});

test("GitHub App installation lookup retries bounded transient read failures", async () => {
  let lookups = 0;
  const resolver = createInstallationResolver({
    lookup: async () => {
      lookups += 1;
      if (lookups < 3) {
        throw Object.assign(new Error("temporary"), { status: 503 });
      }
      return 77;
    },
    now: () => 1000,
    sleep: async () => {},
    random: () => 0,
    cache: new Map(),
  });

  assert.equal(await resolver.resolve("owner/repo", "jwt"), 77);
  assert.equal(lookups, 3);
});

test("GitHub App auth upstream errors preserve bounded retry evidence", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      status: 503,
      headers: new Headers({ "x-github-request-id": `AUTH-${calls}`, "retry-after": "1" }),
      async text() { return JSON.stringify({ message: "temporary auth failure" }); },
    };
  };

  let failure = null;
  try {
    await githubRequest("/repos/owner/repo/installation", {
      token: "jwt",
      phase: "auth.installation_lookup",
      retrySafeRead: true,
      sleep: async () => {},
      random: () => 0,
    });
  } catch (error) {
    failure = error;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(failure?.phase, "auth.installation_lookup");
  assert.equal(failure?.githubPath, "/repos/owner/repo/installation");
  assert.equal(failure?.githubRequestId, "AUTH-3");
  assert.equal(failure?.retryAfter, "1");
  assert.equal(failure?.attempts, 3);
  assert.equal(calls, 3);
});
