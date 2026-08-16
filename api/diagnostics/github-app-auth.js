import { probeGitHubAppRepositoryWithRevocation } from "lib/github-app-poc.js";

export const access = "admin";
export const methods = ["POST"];

export default async function (req, res) {
  try {
    const result = await probeGitHubAppRepositoryWithRevocation(req.body?.repo);
    res.json(result);
  } catch (error) {
    const status = error?.code === "INVALID_REPO" || error?.code === "INVALID_GITHUB_APP_ID" || error?.code === "INVALID_GITHUB_APP_PRIVATE_KEY"
      ? 400
      : error?.status || 500;
    res.status(status).json({
      ok: false,
      error: error?.code || "GITHUB_APP_POC_ERROR",
      message: error?.message || "GitHub App authentication proof failed.",
      upstream_status: error?.status || null
    });
  }
}