#!/usr/bin/env bash
# mesh installer — downloads source from GitHub and installs via bun.
#
# Usage (latest release):
#   curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | bash
#
# Usage (pinned tag):
#   curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | MESH_REF=v1.2.3 bash
#
# Usage (bleeding edge main branch):
#   curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | MESH_REF=main bash
#
# Environment overrides:
#   MESH_REPO      GitHub "owner/repo"  (default: kaizen-hq/mesh)
#   MESH_REF       branch, tag, or SHA  (default: latest release tag)
#   INSTALL_DIR    where source lands   (default: ~/.local/share/mesh)
#   BIN_DIR        where shim lands     (default: ~/.local/bin)

set -euo pipefail

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is required but not found" >&2
    echo "       $2" >&2
    exit 1
  fi
}

need bun   "install from https://bun.sh/docs/installation"
need unzip "brew install unzip  (or apt install unzip)"
need curl  "brew install curl   (or apt install curl)"

MESH_REPO="${MESH_REPO:-kaizen-hq/mesh}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/mesh}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

# Resolve MESH_REF: if unset, fetch the latest release tag from the GitHub API.
if [[ -z "${MESH_REF:-}" ]]; then
  MESH_REF="$(curl -fsSL "https://api.github.com/repos/$MESH_REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [[ -z "$MESH_REF" ]]; then
    echo "error: could not resolve latest release from GitHub API" >&2
    exit 1
  fi
  echo "==> resolved latest release: $MESH_REF"
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

TMP="$(mktemp -d -t mesh-install)"
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading mesh ($MESH_REPO @ $MESH_REF)..."

# For version tags (v*), prefer the release asset (mesh-src.zip uploaded by CI)
# because it's the canonical packaged build. Fall back to GitHub's archive API
# for branch names or SHAs.
if [[ "$MESH_REF" == v* ]]; then
  RELEASE_URL="https://github.com/$MESH_REPO/releases/download/$MESH_REF/mesh-src.zip"
  if curl -fsSL "$RELEASE_URL" -o "$TMP/mesh-src.zip" 2>/dev/null; then
    echo "    (from release asset)"
  else
    echo "    (release asset not found, falling back to tag archive)"
    curl -fsSL "https://github.com/$MESH_REPO/archive/refs/tags/$MESH_REF.zip" \
      -o "$TMP/mesh-src.zip"
  fi
else
  curl -fsSL "https://github.com/$MESH_REPO/archive/refs/heads/$MESH_REF.zip" \
    -o "$TMP/mesh-src.zip"
fi

echo "==> extracting..."
unzip -oq "$TMP/mesh-src.zip" -d "$TMP/extracted"

# Release assets (mesh-src.zip) unzip flat. GitHub branch/tag archives unzip
# into a top-level directory like "mesh-main/" or "mesh-1.2.3/". Detect which.
SRC_DIR="$(find "$TMP/extracted" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "$SRC_DIR" || ! -f "$SRC_DIR/package.json" ]]; then
  # Flat zip (release asset) — extracted dir IS the source root
  SRC_DIR="$TMP/extracted"
fi
if [[ -z "$SRC_DIR" ]]; then
  echo "error: could not find extracted source directory" >&2
  exit 1
fi

echo "==> installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/package.json" \
       "$INSTALL_DIR/tsconfig.json" "$INSTALL_DIR/README.md"
cp -r "$SRC_DIR/." "$INSTALL_DIR/"

echo "==> running bun install..."
(cd "$INSTALL_DIR" && bun install --frozen-lockfile >/dev/null)

echo "==> writing shim to $BIN_DIR/mesh..."
cat > "$BIN_DIR/mesh" <<EOF
#!/usr/bin/env bash
exec bun "$INSTALL_DIR/src/main.ts" "\$@"
EOF
chmod +x "$BIN_DIR/mesh"

echo ""
echo "mesh installed successfully."
echo "  source: $INSTALL_DIR"
echo "  shim:   $BIN_DIR/mesh"
echo ""
echo "Next steps:"
echo "  mesh init"
echo "  mesh pubkey   # share with teammates"
echo "  mesh start"
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "Note: $BIN_DIR is not in your PATH. Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
