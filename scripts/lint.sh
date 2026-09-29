#!/usr/bin/env bash
set -euo pipefail

BIOME_VERSION=2.5.14

# Lint TypeScript and every repository JSON document, including contract/evidence JSON, without rewriting bytes.
npx --yes "@biomejs/biome@$BIOME_VERSION" lint .

# Formatting remains scoped to handwritten TypeScript plus the two project config files.
mapfile -t biome_format_files < <(
  git ls-files '*.ts' biome.json package.json \
    | grep -v '^src/generated/' \
    | grep -v '^src/providers/github/operations\.generated\.ts$'
)
npx --yes "@biomejs/biome@$BIOME_VERSION" format "${biome_format_files[@]}"

go_runtime_version="$(tr -d '\r\n' < .go-version)"
go_language_version="$(awk '$1 == "go" { print $2; exit }' src/execution/executor/go.mod)"
if [[ -z "$go_language_version" || "$go_runtime_version" != "$go_language_version".* ]]; then
  printf 'Go version drift: .go-version=%s, go.mod=%s\n' "$go_runtime_version" "$go_language_version" >&2
  exit 1
fi

# TypeScript identifiers use the product's canonical GitHub casing. Lowercase github remains valid
# in wire values, schema IDs, paths, and filenames.
if git grep -nE '(^|[^A-Za-z0-9_])Github[A-Z][A-Za-z0-9_]*' -- '*.ts'; then
  echo 'TypeScript identifiers must spell the product name GitHub, not Github.' >&2
  exit 1
fi

go_unformatted="$(gofmt -l src/execution/executor)"
if [[ -n "$go_unformatted" ]]; then
  printf 'gofmt required:\n%s\n' "$go_unformatted" >&2
  exit 1
fi
(
  cd src/execution/executor
  go vet ./...
)

find src experiments -name '*.rs' -print0 | xargs -0 -n 1 rustfmt --check
