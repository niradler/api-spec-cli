#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -e "console.log(require('./package.json').version)")
TAG="v${VERSION}"
DIST="dist"

echo "Building spec-cli ${TAG}..."

rm -rf "$DIST"
mkdir -p "$DIST"

# Build for each target
targets=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
  "bun-windows-x64"
)

for target in "${targets[@]}"; do
  ext=""
  [[ "$target" == *"windows"* ]] && ext=".exe"

  out="${DIST}/spec-${target}${ext}"
  echo "  -> $out"
  bun build ./bin/spec.js --compile --target="$target" --outfile="$out"
done

echo "Build complete. Files in ${DIST}/:"
ls -lh "$DIST/"

# Create GitHub release and upload binaries
echo ""
echo "Creating GitHub release ${TAG}..."

gh release create "$TAG" \
  --title "spec-cli ${TAG}" \
  --notes "Release ${TAG}" \
  "${DIST}/"*

echo "Done: https://github.com/niradler/api-spec-cli/releases/tag/${TAG}"
