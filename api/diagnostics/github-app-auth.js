import { probeGitHubAppRepositoryWithRevocation } from "lib/github-app-poc.js";

export const access = "admin";
export const methods = ["POST"];

export default async function (req, res) {
  try {
    const result = await probeGitHubAppRepositoryWithRevocation(req.body?.repo);
    res.json(result);
  } catch (error) {
    const message = error?.message || "GitHub App authentication proof failed.";
    const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
    const status = setupRequired
      ? 412
      : error?.code === "INVALID_REPO" || error?.code === "INVALID_GITHUB_APP_ID" || error?.code === "INVALID_GITHUB_APP_PRIVATE_KEY"
        ? 400
        : error?.status || 500;
    res.status(status).json({
      ok: false,
      error: setupRequired ? "GITHUB_APP_SETUP_REQUIRED" : error?.code || "GITHUB_APP_POC_ERROR",
      message,
      upstream_status: error?.status || null,
      upstream_path: error?.githubPath || null
    });
  }
}