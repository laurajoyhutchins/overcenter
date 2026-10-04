#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: materialize-private-source-ferry.sh <manifest.json> <source.tar.gz.cms> <recipient-cert.pem> <recipient-key.pem> <destination>" >&2
  exit 2
fi

manifest="$1"
ciphertext="$2"
cert="$3"
key="$4"
destination="$5"

command -v openssl >/dev/null
command -v python3 >/dev/null
command -v git >/dev/null
command -v tar >/dev/null

read -r expected_sha expected_tree expected_cipher_sha expected_bytes < <(python3 - "$manifest" <<'PY'
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
if value.get("schema") != "overcenter/private-source-ferry/v1":
    raise SystemExit("unsupported ferry manifest schema")
if value.get("repository") != "laurajoyhutchins/arcata":
    raise SystemExit("ferry manifest is not for Arcata")
sha = value.get("source_sha")
tree = value.get("tree_sha")
digest = value.get("ciphertext_sha256")
size = value.get("ciphertext_bytes")
for label, candidate in (("source SHA", sha), ("tree SHA", tree), ("ciphertext SHA-256", digest)):
    pattern = r"[0-9a-f]{40}" if label != "ciphertext SHA-256" else r"[0-9a-f]{64}"
    if not isinstance(candidate, str) or re.fullmatch(pattern, candidate) is None:
        raise SystemExit(f"invalid {label}")
if not isinstance(size, int) or size <= 0:
    raise SystemExit("invalid ciphertext size")
print(sha, tree, digest, size)
PY
)

python3 - "$ciphertext" "$expected_cipher_sha" "$expected_bytes" <<'PY'
import hashlib
import os
import sys
path, expected, expected_size = sys.argv[1:]
if os.path.getsize(path) != int(expected_size):
    raise SystemExit("ciphertext size mismatch")
h = hashlib.sha256()
with open(path, "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        h.update(chunk)
if h.hexdigest() != expected:
    raise SystemExit("ciphertext digest mismatch")
PY

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

openssl cms -decrypt -binary -inform DER \
  -in "$ciphertext" -recip "$cert" -inkey "$key" \
  -out "$tmp/source.tar.gz"

mkdir "$tmp/extracted"
tar -xzf "$tmp/source.tar.gz" -C "$tmp/extracted"
mapfile -t roots < <(find "$tmp/extracted" -mindepth 1 -maxdepth 1 -type d -print)
[[ ${#roots[@]} -eq 1 ]]

rm -rf "$destination"
mkdir -p "$destination"
cp -a "${roots[0]}/." "$destination/"

git -C "$destination" init -q
git -C "$destination" -c core.autocrlf=false -c core.safecrlf=false add -A -f
observed_tree="$(git -C "$destination" write-tree)"
if [[ "$observed_tree" != "$expected_tree" ]]; then
  rm -rf "$destination"
  echo "materialized Git tree mismatch: expected $expected_tree, observed $observed_tree" >&2
  exit 1
fi
rm -rf "$destination/.git"
printf 'materialized Arcata %s (tree %s) at %s\n' "$expected_sha" "$expected_tree" "$destination"
