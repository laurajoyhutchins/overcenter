#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-6b810532-a302-48dc-b56}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="${GCP_SERVICE:-overcenter-shadow}"
EXACT_REVISION="${EXACT_REVISION:?EXACT_REVISION is required}"
SOURCE_FREEZE_DIGEST="${SOURCE_FREEZE_DIGEST:?SOURCE_FREEZE_DIGEST is required}"

if [[ ! "$EXACT_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXACT_REVISION must be a lowercase 40-character Git SHA" >&2
  exit 2
fi
if [[ ! "$SOURCE_FREEZE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "SOURCE_FREEZE_DIGEST must be sha256:<64 hex>" >&2
  exit 2
fi

gcloud config set project "$PROJECT_ID" >/dev/null
TMP="${RUNNER_TEMP:-/tmp}/overcenter-cutover-service.json"

describe() {
  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > "$TMP"
}

field() {
  python3 - "$TMP" "$1" <<'PY'
import json,sys
path=sys.argv[2]
with open(sys.argv[1], encoding='utf-8') as f: value=json.load(f)
for part in path.split('.'):
    if isinstance(value, dict): value=value.get(part)
    else: value=None
print('' if value is None else value)
PY
}

env_value() {
  python3 - "$TMP" "$1" <<'PY'
import json,sys
name=sys.argv[2]
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
env=((body.get('spec') or {}).get('template') or {}).get('spec',{}).get('containers',[{}])[0].get('env',[])
for item in env:
    if item.get('name') == name:
        print(item.get('value',''))
        break
else:
    print('')
PY
}

image_value() {
  python3 - "$TMP" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: body=json.load(f)
print(((body.get('spec') or {}).get('template') or {}).get('spec',{}).get('containers',[{}])[0].get('image',''))
PY
}

describe
BEFORE_READY="$(field status.latestReadyRevisionName)"
BEFORE_CREATED="$(field status.latestCreatedRevisionName)"
BEFORE_MODE="$(env_value OVERCENTER_AUTHORITY_MODE)"
BEFORE_SOURCE="$(env_value OVERCENTER_SOURCE_REVISION)"
BEFORE_FREEZE="$(env_value OVERCENTER_SOURCE_FREEZE_DIGEST)"
BEFORE_IMAGE="$(image_value)"

if [[ -z "$BEFORE_READY" || "$BEFORE_READY" != "$BEFORE_CREATED" ]]; then
  echo "Cloud Run has no single ready latest revision" >&2
  exit 1
fi
if [[ "$BEFORE_SOURCE" != "$EXACT_REVISION" ]]; then
  echo "Cloud Run source revision mismatch: expected $EXACT_REVISION observed ${BEFORE_SOURCE:-<none>}" >&2
  exit 1
fi
if [[ "$BEFORE_MODE" == "authoritative" ]]; then
  if [[ "$BEFORE_FREEZE" != "$SOURCE_FREEZE_DIGEST" ]]; then
    echo "authoritative replay freeze digest mismatch" >&2
    exit 1
  fi
  echo "Overcenter GCP writer already authoritative at exact requested cutover identity"
  echo "Revision: $BEFORE_READY"
  exit 0
fi
if [[ "$BEFORE_MODE" != "shadow" ]]; then
  echo "Cloud Run is neither shadow nor authoritative: ${BEFORE_MODE:-<none>}" >&2
  exit 1
fi

gcloud run services update "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="OVERCENTER_AUTHORITY_MODE=authoritative,OVERCENTER_SOURCE_FREEZE_DIGEST=${SOURCE_FREEZE_DIGEST}" \
  --quiet >/dev/null

describe
AFTER_READY="$(field status.latestReadyRevisionName)"
AFTER_CREATED="$(field status.latestCreatedRevisionName)"
AFTER_MODE="$(env_value OVERCENTER_AUTHORITY_MODE)"
AFTER_SOURCE="$(env_value OVERCENTER_SOURCE_REVISION)"
AFTER_FREEZE="$(env_value OVERCENTER_SOURCE_FREEZE_DIGEST)"
AFTER_IMAGE="$(image_value)"

if [[ -z "$AFTER_READY" || "$AFTER_READY" != "$AFTER_CREATED" ]]; then
  echo "authoritative Cloud Run revision did not become ready" >&2
  exit 1
fi
if [[ "$AFTER_READY" == "$BEFORE_READY" ]]; then
  echo "writer cutover did not create a new Cloud Run revision" >&2
  exit 1
fi
if [[ "$AFTER_MODE" != "authoritative" || "$AFTER_SOURCE" != "$EXACT_REVISION" || "$AFTER_FREEZE" != "$SOURCE_FREEZE_DIGEST" ]]; then
  echo "authoritative cutover readback mismatch" >&2
  exit 1
fi
if [[ -z "$BEFORE_IMAGE" || "$AFTER_IMAGE" != "$BEFORE_IMAGE" ]]; then
  echo "cutover changed the deployed image instead of only authority configuration" >&2
  exit 1
fi

printf '%s\n' \
  "Overcenter GCP authoritative writer enabled" \
  "Source revision: ${AFTER_SOURCE}" \
  "Source freeze:   ${AFTER_FREEZE}" \
  "Before revision: ${BEFORE_READY}" \
  "After revision:  ${AFTER_READY}" \
  "Image unchanged: ${AFTER_IMAGE}"
