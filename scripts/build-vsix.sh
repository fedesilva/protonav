#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but not found in PATH." >&2
  exit 1
fi

VERSION_FILE="$ROOT_DIR/VERSION"
if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Missing VERSION file at $VERSION_FILE" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid VERSION format: '$VERSION' (expected MAJOR.MINOR.PATCH)" >&2
  exit 1
fi

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  echo "Version mismatch: VERSION=$VERSION, package.json=$PACKAGE_VERSION" >&2
  echo "Sync them before building." >&2
  exit 1
fi

echo "[1/4] Checking dependencies"
if npm ls --depth=0 >/dev/null 2>&1; then
  echo "Dependencies are already installed."
else
  echo "Installing dependencies with npm ci"
  npm ci
fi

AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-low}"
echo "[2/4] Running security audit (level: $AUDIT_LEVEL)"
if ! npm audit --audit-level="$AUDIT_LEVEL"; then
  echo "Security audit failed. Refusing to package without a successful audit." >&2
  echo "Fix dependency issues or resolve npm registry access, then retry." >&2
  exit 1
fi

echo "[3/4] Compiling extension"
npm run compile

PACKAGE_NAME="$(node -p "require('./package.json').name")"
VSIX_FILE="${PACKAGE_NAME}-${VERSION}.vsix"

if [[ -f "$VSIX_FILE" ]]; then
  rm -f "$VSIX_FILE"
fi

echo "[4/4] Packaging VSIX -> $VSIX_FILE"
npm exec -- @vscode/vsce package --allow-missing-repository --out "$VSIX_FILE"

echo "Built: $ROOT_DIR/$VSIX_FILE"
