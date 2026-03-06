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
    echo "Set VSCODE_CLI explicitly, e.g. VSCODE_CLI=/path/to/code scripts/install-vsix.sh" >&2
    exit 1
  fi
fi

"$ROOT_DIR/scripts/build-vsix.sh"

VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
PACKAGE_NAME="$(node -p "require('./package.json').name")"
VSIX_FILE="${PACKAGE_NAME}-${VERSION}.vsix"

if [[ ! -f "$ROOT_DIR/$VSIX_FILE" ]]; then
  echo "Expected VSIX not found: $ROOT_DIR/$VSIX_FILE" >&2
  exit 1
fi

echo "Installing VSIX via $VSCODE_CLI"
"$VSCODE_CLI" --install-extension "$ROOT_DIR/$VSIX_FILE" --force

echo "Installed: $ROOT_DIR/$VSIX_FILE"
