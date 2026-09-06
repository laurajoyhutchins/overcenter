#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
RUNTIME_SA="${OVERCENTER_RUNTIME_SERVICE_ACCOUNT:-overcenter-runtime@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com}"
SECRET="${OVERCENTER_GITHUB_APP_PRIVATE_KEY_SECRET:-overcenter-github-app-private-key}"
APP_ID="${GITHUB_APP_ID:-4616688}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-laurajoyhutchins/overcenter}"

for command in gcloud gh openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 2
  fi
done

if [[ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)" ]]; then
  echo "gcloud must have an active Google Cloud account" >&2
  exit 2
fi

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "gh must be authenticated to github.com" >&2
  exit 2
fi

PEM_PATH="${1:-}"
if [[ -z "$PEM_PATH" ]]; then
  mapfile -t PEM_FILES < <(find . -maxdepth 1 -type f -name '*.pem' -print | sort)
  if [[ ${#PEM_FILES[@]} -ne 1 ]]; then
    echo "Expected exactly one .pem file in the current directory; found ${#PEM_FILES[@]}." >&2
    if [[ ${#PEM_FILES[@]} -gt 0 ]]; then printf '  %s\n' "${PEM_FILES[@]}" >&2; fi
    echo "Either leave only the new Overcenter GitHub App key here or pass its path explicitly." >&2
    exit 2
  fi
  PEM_PATH="${PEM_FILES[0]}"
fi

if [[ ! -f "$PEM_PATH" ]]; then
  echo "Private key file not found: $PEM_PATH" >&2
  exit 2
fi

# Validate that the file is a parseable private key without printing its content.
openssl pkey -in "$PEM_PATH" -noout -check >/dev/null

gcloud config set project "$PROJECT_ID" >/dev/null

if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets versions add "$SECRET" \
    --project="$PROJECT_ID" \
    --data-file="$PEM_PATH" >/dev/null
  ACTION="added a new version to"
else
  gcloud secrets create "$SECRET" \
    --project="$PROJECT_ID" \
    --replication-policy=automatic \
    --data-file="$PEM_PATH" >/dev/null
  ACTION="created"
fi

gcloud secrets add-iam-policy-binding "$SECRET" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

# App ID is configuration, not a secret. Persist it as a GitHub Actions variable
# so deployment configuration does not need to hard-code it.
gh variable set GITHUB_APP_ID --repo "$GITHUB_REPOSITORY" --body "$APP_ID"

printf '%s\n' \
  "Overcenter GitHub App credential ready" \
  "Google project:   ${PROJECT_ID}" \
  "GitHub App ID:    ${APP_ID}" \
  "Private key:      ${ACTION} Secret Manager secret ${SECRET}" \
  "Runtime identity: ${RUNTIME_SA}" \
  "GitHub repo:      ${GITHUB_REPOSITORY}" \
  "The private key contents were not printed."
