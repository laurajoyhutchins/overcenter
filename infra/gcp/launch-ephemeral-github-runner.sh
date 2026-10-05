#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${TARGET_REPOSITORY_ID:?TARGET_REPOSITORY_ID is required}"
: "${TARGET_JOB_ID:?TARGET_JOB_ID is required}"
: "${RUNNER_IMAGE:?RUNNER_IMAGE is required}"

case "${TARGET_REPOSITORY}:${TARGET_REPOSITORY_ID}" in
  "laurajoyhutchins/arcata:1402666660"|"laurajoyhutchins/overcenter:1354872053")
    ;;
  *)
    echo "repository is outside the GCP runner allowlist" >&2
    exit 2
    ;;
esac

if [[ ! "$TARGET_JOB_ID" =~ ^[0-9]+$ ]]; then
  echo "TARGET_JOB_ID must be numeric" >&2
  exit 2
fi
if [[ ! "$RUNNER_IMAGE" =~ ^us-west1-docker\.pkg\.dev/project-6b810532-a302-48dc-b56/ ]]; then
  echo "RUNNER_IMAGE is outside the pinned project registry" >&2
  exit 2
fi

config="${RUNNER_TEMP:-/tmp}/overcenter-gcp-runner-${TARGET_JOB_ID}.yaml"
cat > "$config" <<YAML
serviceAccount: projects/${PROJECT_ID}/serviceAccounts/overcenter-runtime@${PROJECT_ID}.iam.gserviceaccount.com
timeout: 1200s
steps:
  - id: authorize-job
    name: node:22-bookworm
    entrypoint: node
    secretEnv: [GITHUB_APP_PRIVATE_KEY]
    env:
      - GITHUB_APP_ID=4616688
      - TARGET_REPOSITORY=${TARGET_REPOSITORY}
      - TARGET_REPOSITORY_ID=${TARGET_REPOSITORY_ID}
      - TARGET_JOB_ID=${TARGET_JOB_ID}
    args:
      - -e
      - |
        const crypto = require("crypto");
        const fs = require("fs");

        const repository = process.env.TARGET_REPOSITORY;
        const repositoryId = Number(process.env.TARGET_REPOSITORY_ID);
        const jobId = Number(process.env.TARGET_JOB_ID);
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

        const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const unsigned =
          b64({alg:"RS256",typ:"JWT"}) + "." +
          b64({iat:now-60,exp:now+540,iss:appId});
        const signature = crypto
          .sign("RSA-SHA256", Buffer.from(unsigned), privateKey)
          .toString("base64url");
        const appJwt = unsigned + "." + signature;

        const headers = token => ({
          Accept:"application/vnd.github+json",
          Authorization:"Bearer " + token,
          "X-GitHub-Api-Version":"2026-03-10",
          "User-Agent":"overcenter-gcp-runner",
        });

        async function json(response, label) {
          const text = await response.text();
          let body = null;
          try { body = text ? JSON.parse(text) : null; } catch {}
          if (!response.ok) {
            throw new Error(label + " HTTP " + response.status + ": " + text.slice(0,300));
          }
          return body;
        }

        async function main() {
          const installation = await json(
            await fetch("https://api.github.com/repos/" + repository + "/installation", {
              headers: headers(appJwt),
            }),
            "installation lookup",
          );
          const installationPermissions =
            installation && typeof installation.permissions === "object"
              ? installation.permissions
              : {};
          if (String(installationPermissions.administration || "") !== "write") {
            throw new Error(
              "GitHub App installation lacks administration:write required for ephemeral runner registration",
            );
          }
          if (!["read", "write"].includes(String(installationPermissions.actions || ""))) {
            throw new Error(
              "GitHub App installation lacks actions:read required to validate queued jobs",
            );
          }

          const access = await json(
            await fetch(
              "https://api.github.com/app/installations/" + installation.id + "/access_tokens",
              {
                method:"POST",
                headers:{...headers(appJwt),"Content-Type":"application/json"},
                body:JSON.stringify({
                  repository_ids:[repositoryId],
                  permissions:{administration:"write",actions:"read"},
                }),
              },
            ),
            "installation token",
          );
          const token = String(access && access.token || "");
          if (!token) throw new Error("installation token was empty");

          const metadata = await json(
            await fetch("https://api.github.com/repos/" + repository, {
              headers: headers(token),
            }),
            "repository identity",
          );
          if (
            Number(metadata && metadata.id) !== repositoryId ||
            String(metadata && metadata.full_name || "").toLowerCase() !== repository.toLowerCase() ||
            Number(metadata && metadata.owner && metadata.owner.id) !== 219002713
          ) {
            throw new Error("repository identity mismatch");
          }

          const job = await json(
            await fetch(
              "https://api.github.com/repos/" + repository + "/actions/jobs/" + jobId,
              {headers:headers(token)},
            ),
            "workflow job",
          );
          const labels = new Set(
            Array.isArray(job && job.labels) ? job.labels.map(value => String(value).toLowerCase()) : [],
          );
          if (!labels.has("self-hosted") || !labels.has("overcenter-gcp")) {
            throw new Error("workflow job no longer requests the overcenter-gcp runner");
          }
          if (String(job && job.status) !== "queued") {
            fs.writeFileSync("/workspace/skip-runner", "not-queued\n");
            return;
          }

          const registration = await json(
            await fetch(
              "https://api.github.com/repos/" + repository + "/actions/runners/registration-token",
              {
                method:"POST",
                headers:{...headers(token),"Content-Type":"application/json"},
              },
            ),
            "runner registration token",
          );
          const registrationToken = String(registration && registration.token || "");
          if (!registrationToken) throw new Error("runner registration token was empty");
          fs.writeFileSync("/workspace/registration-token", registrationToken, {mode:0o600});
        }

        main().catch(error => {
          console.error(String(error && error.message || error));
          process.exit(1);
        });

  - id: github-runner
    name: gcr.io/cloud-builders/docker
    entrypoint: bash
    args:
      - -ceu
      - |
        if [ -f /workspace/skip-runner ]; then
          echo "GitHub job is no longer queued; no runner required."
          exit 0
        fi
        docker run --rm \
          --network bridge \
          --volume /workspace:/workspace \
          --env TARGET_REPOSITORY=${TARGET_REPOSITORY} \
          --env TARGET_JOB_ID=${TARGET_JOB_ID} \
          --env RUNNER_NAME=overcenter-gcp-${TARGET_JOB_ID}-\$BUILD_ID \
          ${RUNNER_IMAGE}

availableSecrets:
  secretManager:
    - versionName: projects/${PROJECT_ID}/secrets/overcenter-github-app-private-key/versions/latest
      env: GITHUB_APP_PRIVATE_KEY

options:
  logging: CLOUD_LOGGING_ONLY
YAML

build_id="$(
  gcloud builds submit     --async     --no-source     --project="$PROJECT_ID"     --region="$REGION"     --config="$config"     --format='value(id)'
)"
test -n "$build_id"

printf 'Cloud Build: %s\n' "$build_id"
status=""
for _ in $(seq 1 600); do
  status="$(
    gcloud builds describe "$build_id"       --project="$PROJECT_ID"       --region="$REGION"       --format='value(status)'
  )"
  case "$status" in
    SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
      break
      ;;
  esac
  sleep 2
done

printf 'Cloud Build status: %s\n' "$status"
gcloud builds describe "$build_id"   --project="$PROJECT_ID"   --region="$REGION"   --format='table(steps.id,steps.status)'

if [[ "$status" != "SUCCESS" ]]; then
  gcloud builds describe "$build_id"     --project="$PROJECT_ID"     --region="$REGION"     --format='value(failureInfo.detail)' >&2 || true
  exit 1
fi
