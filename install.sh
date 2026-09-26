#!/usr/bin/env bash
# mesh installer
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
#   INSTALL_DIR    where source lands when falling back to source install
#                  (default: ~/.local/share/mesh)
#   BIN_DIR        where the binary/shim lands  (default: ~/.local/bin)

set -euo pipefail

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is required but not found" >&2
    echo "       $2" >&2
    exit 1
  fi
}

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

mkdir -p "$BIN_DIR"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/mesh-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── Helpers ────────────────────────────────────────────────────────────────────

# Install from a source zip. Extracts, runs bun install, writes a path-independent shim.
_install_from_zip() {
  local zip="$1"
  need bun   "install from https://bun.sh/docs/installation"
  need unzip "brew install unzip  (or apt install unzip)"

  echo "==> extracting..."
  unzip -oq "$zip" -d "$TMP/extracted"

  # Release assets (mesh-src.zip) unzip flat. GitHub branch/tag archives unzip
  # into a top-level directory like "mesh-main/" or "mesh-1.2.3/". Detect which.
  local src_dir
  src_dir="$(find "$TMP/extracted" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [[ -z "$src_dir" || ! -f "$src_dir/package.json" ]]; then
    src_dir="$TMP/extracted"
  fi
  if [[ -z "$src_dir" ]]; then
    echo "error: could not find extracted source directory" >&2
    exit 1
  fi

  echo "==> installing to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/package.json" \
         "$INSTALL_DIR/tsconfig.json" "$INSTALL_DIR/README.md"
  cp -r "$src_dir/." "$INSTALL_DIR/"

  echo "==> running bun install..."
  (cd "$INSTALL_DIR" && bun install --frozen-lockfile >/dev/null)

  # Write a path-independent shim so the binary works regardless of which user
  # installed it. Resolves the source relative to the shim's own location using
  # the standard prefix layout: bin/ and share/mesh/ are siblings under the same
  # prefix (e.g. ~/.local/, /usr/local/, /usr/).
  echo "==> writing shim to $BIN_DIR/mesh..."
  cat > "$BIN_DIR/mesh" <<'SHIM'
#!/usr/bin/env bash
MESH_SRC="$(dirname "$(readlink -f "$0")")/../share/mesh"
exec bun "$MESH_SRC/src/main.ts" "$@"
SHIM
  chmod +x "$BIN_DIR/mesh"
}

# ── Install ────────────────────────────────────────────────────────────────────

# Detect platform for compiled binary download.
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  linux-x86_64)              PLATFORM="linux-x64"    ;;
  linux-arm64|linux-aarch64) PLATFORM="linux-arm64"  ;;
  darwin-x86_64)             PLATFORM="darwin-x64"   ;;
  darwin-arm64)              PLATFORM="darwin-arm64"  ;;
  *)                         PLATFORM=""              ;;
esac

INSTALLED_BINARY=false

# For version tags (v*), prefer the compiled binary — self-contained, no bun or
# source files required at runtime. Fall back to source zip if unavailable.
if [[ "$MESH_REF" == v* && -n "$PLATFORM" ]]; then
  BINARY_URL="https://github.com/$MESH_REPO/releases/download/$MESH_REF/mesh-$PLATFORM"
  echo "==> downloading mesh ($MESH_REPO @ $MESH_REF, $PLATFORM)..."
  if curl -fsSL "$BINARY_URL" -o "$TMP/mesh" 2>/dev/null; then
    install -m 755 "$TMP/mesh" "$BIN_DIR/mesh"
    INSTALLED_BINARY=true
    echo "    (compiled binary — no bun required at runtime)"
  else
    echo "    (compiled binary not found for $PLATFORM, falling back to source)"
  fi
fi

if [[ "$INSTALLED_BINARY" == false ]]; then
  if [[ "$MESH_REF" == v* ]]; then
    RELEASE_URL="https://github.com/$MESH_REPO/releases/download/$MESH_REF/mesh-src.zip"
    echo "==> downloading mesh source ($MESH_REPO @ $MESH_REF)..."
    if ! curl -fsSL "$RELEASE_URL" -o "$TMP/mesh-src.zip" 2>/dev/null; then
      echo "    (release asset not found, falling back to tag archive)"
      curl -fsSL "https://github.com/$MESH_REPO/archive/refs/tags/$MESH_REF.zip" \
        -o "$TMP/mesh-src.zip"
    fi
  else
    echo "==> downloading mesh source ($MESH_REPO @ $MESH_REF)..."
    curl -fsSL "https://github.com/$MESH_REPO/archive/refs/heads/$MESH_REF.zip" \
      -o "$TMP/mesh-src.zip"
  fi
  _install_from_zip "$TMP/mesh-src.zip"
fi

# ── Done ───────────────────────────────────────────────────────────────────────

echo ""
echo "mesh installed successfully."
if [[ "$INSTALLED_BINARY" == true ]]; then
  echo "  binary: $BIN_DIR/mesh"
else
  echo "  source: $INSTALL_DIR"
  echo "  shim:   $BIN_DIR/mesh"
fi
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
