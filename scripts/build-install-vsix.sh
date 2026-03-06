#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VSCODE_CLI="${VSCODE_CLI:-}"
if [[ -z "$VSCODE_CLI" ]]; then
  if command -v code >/dev/null 2>&1; then
    VSCODE_CLI="$(command -v code)"
  else
    echo "Could not find VS Code CLI ('code') in PATH." >&2
    echo "Set VSCODE_CLI explicitly, e.g. VSCODE_CLI=/path/to/code scripts/build-install-vsix.sh" >&2
    exit 1
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but not found in PATH." >&2
  exit 1
fi

echo "[1/5] Checking dependencies"
if npm ls --depth=0 >/dev/null 2>&1; then
  echo "Dependencies are already installed."
else
  echo "Installing dependencies with npm ci"
  npm ci
fi

AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-low}"
echo "[2/5] Running security audit (level: $AUDIT_LEVEL)"
if ! npm audit --audit-level="$AUDIT_LEVEL"; then
  echo "Security audit failed. Refusing to package/install without a successful audit." >&2
  echo "Fix dependency issues or resolve npm registry access, then retry." >&2
  exit 1
fi

echo "[3/5] Compiling extension"
npm run compile

VSIX_FILE="$(node -p "const p=require('./package.json'); p.name + '-' + p.version + '.vsix'")"

if [[ -f "$VSIX_FILE" ]]; then
  rm -f "$VSIX_FILE"
fi

echo "[4/5] Packaging VSIX -> $VSIX_FILE"
npm exec -- @vscode/vsce package --allow-missing-repository --out "$VSIX_FILE"

echo "[5/5] Installing VSIX via $VSCODE_CLI"
"$VSCODE_CLI" --install-extension "$ROOT_DIR/$VSIX_FILE" --force

echo "Installed: $ROOT_DIR/$VSIX_FILE"
