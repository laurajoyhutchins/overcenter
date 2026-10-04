#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  private-source-ferry.sh self-test
  private-source-ferry.sh ferry <request>

request grammar:
  /ferry arcata <40-hex-commit> <32-hex-nonce> <base64-DER-X509-certificate>
USAGE
}

parse_request() {
  local request="$1"
  local command target source_sha nonce cert_b64 extra

  [[ "$request" != *$'\n'* ]] || return 1
  [[ "$request" != *$'\r'* ]] || return 1
  IFS=' ' read -r command target source_sha nonce cert_b64 extra <<<"$request"

  [[ "$command" == "/ferry" ]] || return 1
  [[ "$target" == "arcata" ]] || return 1
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ "$cert_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  (( ${#cert_b64} >= 256 && ${#cert_b64} <= 4096 )) || return 1
  [[ -z "${extra:-}" ]] || return 1

  printf '%s\n%s\n%s\n' "$source_sha" "$nonce" "$cert_b64"
}

self_test() {
  local tmp request parsed source_sha nonce cert_b64
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  openssl req -x509 -newkey rsa:3072 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj '/CN=Overcenter private source ferry self-test' -days 1 >/dev/null 2>&1
  cert_b64="$(openssl x509 -in "$tmp/cert.pem" -outform DER | openssl base64 -A)"
  source_sha="0123456789abcdef0123456789abcdef01234567"
  nonce="0123456789abcdef0123456789abcdef"
  request="/ferry arcata $source_sha $nonce $cert_b64"
  parsed="$(parse_request "$request")"
  [[ "$(sed -n '1p' <<<"$parsed")" == "$source_sha" ]]
  [[ "$(sed -n '2p' <<<"$parsed")" == "$nonce" ]]

  if parse_request "/ferry other $source_sha $nonce $cert_b64" >/dev/null 2>&1; then
    echo "wrong target accepted" >&2
    return 1
  fi
  if parse_request "/ferry arcata main $nonce $cert_b64" >/dev/null 2>&1; then
    echo "symbolic ref accepted" >&2
    return 1
  fi
  if parse_request "$request extra" >/dev/null 2>&1; then
    echo "extra token accepted" >&2
    return 1
  fi

  printf 'private source ferry test payload\n' > "$tmp/plain"
  openssl cms -encrypt -binary -aes-256-gcm \
    -in "$tmp/plain" -outform DER -out "$tmp/cipher.cms" "$tmp/cert.pem"
  openssl cms -decrypt -binary -inform DER \
    -in "$tmp/cipher.cms" -recip "$tmp/cert.pem" -inkey "$tmp/key.pem" \
    -out "$tmp/recovered"
  cmp "$tmp/plain" "$tmp/recovered"
}

ferry() {
  local request="$1"
  local parsed source_sha nonce cert_b64 work out commit_json tree_sha ciphertext_sha ciphertext_bytes

  : "${ARCATA_FERRY_TOKEN:?ARCATA_FERRY_TOKEN is required}"
  : "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
  : "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
  : "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
  : "${GITHUB_SHA:?GITHUB_SHA is required}"
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  : "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
  : "${REQUEST_ISSUE:?REQUEST_ISSUE is required}"
  : "${REQUEST_COMMENT_ID:?REQUEST_COMMENT_ID is required}"

  command -v curl >/dev/null
  command -v openssl >/dev/null
  command -v python3 >/dev/null

  parsed="$(parse_request "$request")"
  source_sha="$(sed -n '1p' <<<"$parsed")"
  nonce="$(sed -n '2p' <<<"$parsed")"
  cert_b64="$(sed -n '3p' <<<"$parsed")"

  umask 077
  work="$(mktemp -d)"
  out="$GITHUB_WORKSPACE/ferry-out"
  rm -rf "$out"
  mkdir -p "$out"
  cleanup() {
    local status=$?
    rm -rf "$work"
    if (( status != 0 )); then rm -rf "$out"; fi
    return "$status"
  }
  trap cleanup EXIT

  printf '%s' "$cert_b64" | openssl base64 -d -A > "$work/recipient.der"
  openssl x509 -inform DER -in "$work/recipient.der" -out "$work/recipient.pem"
  openssl x509 -in "$work/recipient.pem" -checkend 0 -noout >/dev/null

  commit_json="$work/commit.json"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer ${ARCATA_FERRY_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "https://api.github.com/repos/laurajoyhutchins/arcata/git/commits/${source_sha}" \
    > "$commit_json"

  tree_sha="$(python3 - "$commit_json" "$source_sha" <<'PY'
import json
import re
import sys

path, expected = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)
sha = value.get("sha")
tree = value.get("tree", {}).get("sha")
if sha != expected:
    raise SystemExit("GitHub commit read-back did not match requested SHA")
if not isinstance(tree, str) or re.fullmatch(r"[0-9a-f]{40}", tree) is None:
    raise SystemExit("GitHub commit read-back did not contain a valid tree SHA")
print(tree)
PY
)"

  curl --fail --silent --show-error --location \
    -H "Authorization: Bearer ${ARCATA_FERRY_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "https://api.github.com/repos/laurajoyhutchins/arcata/tarball/${source_sha}" \
    | openssl cms -encrypt -binary -aes-256-gcm \
        -outform DER -out "$out/source.tar.gz.cms" "$work/recipient.pem"

  read -r ciphertext_sha ciphertext_bytes < <(python3 - "$out/source.tar.gz.cms" <<'PY'
import hashlib
import os
import sys
path = sys.argv[1]
h = hashlib.sha256()
with open(path, "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest(), os.path.getsize(path))
PY
)

  python3 - "$out/manifest.json" <<PY
import json
import os
import sys

path = sys.argv[1]
manifest = {
    "schema": "overcenter/private-source-ferry/v1",
    "repository": "laurajoyhutchins/arcata",
    "source_sha": "${source_sha}",
    "tree_sha": "${tree_sha}",
    "nonce": "${nonce}",
    "ciphertext": "source.tar.gz.cms",
    "ciphertext_sha256": "${ciphertext_sha}",
    "ciphertext_bytes": int("${ciphertext_bytes}"),
    "encryption": "CMS EnvelopedData / AES-256-GCM",
    "request_issue": int(os.environ["REQUEST_ISSUE"]),
    "request_comment_id": int(os.environ["REQUEST_COMMENT_ID"]),
    "workflow_repository": os.environ["GITHUB_REPOSITORY"],
    "workflow_sha": os.environ["GITHUB_SHA"],
    "workflow_event": os.environ["GITHUB_EVENT_NAME"],
    "run_id": int(os.environ["GITHUB_RUN_ID"]),
    "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\\n")
PY

  printf 'source_sha=%s\n' "$source_sha" >> "${GITHUB_OUTPUT:-/dev/null}"
  printf 'tree_sha=%s\n' "$tree_sha" >> "${GITHUB_OUTPUT:-/dev/null}"
  printf 'nonce=%s\n' "$nonce" >> "${GITHUB_OUTPUT:-/dev/null}"
}

case "${1:-}" in
  self-test)
    self_test
    ;;
  ferry)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    ferry "$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac
