#!/usr/bin/env bash
# Colima Desktop installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/scripts/install.sh | bash
#
# Options:
#   --version vX.Y.Z   Install a specific release instead of the latest.
#   --uninstall        Remove a previously installed Colima Desktop.
#   --appimage         Force AppImage install on Linux (skip deb/rpm package managers).
#   --help             Show this help text.
#
# Hidden/testing options:
#   --dry-run          Print the chosen asset URL and install method, then exit
#                       without downloading or installing anything.
#
# Environment overrides (for --dry-run testing only):
#   CD_TEST_OS            "macos" or "linux" — overrides OS detection.
#   CD_TEST_ARCH           "x86_64" or "aarch64" — overrides arch detection.
#   CD_TEST_PM             "apt", "dnf", "yum", "zypper", or "none" — overrides package manager detection.
#   CD_TEST_ASSETS_JSON    Path to a JSON file with a fake GitHub release asset list.
set -euo pipefail

REPO="alperen-selcuk/colima-desktop"
APP_NAME="Colima Desktop"
BIN_NAME="colima-desktop"
BUNDLE_ID="dev.colima.desktop"
ICON_RAW_URL="https://raw.githubusercontent.com/${REPO}/main/src-tauri/icons/128x128%402x.png"

VERSION=""
UNINSTALL=false
FORCE_APPIMAGE=false
DRY_RUN=false

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  COLOR_RED=$'\033[0;31m'
  COLOR_GREEN=$'\033[0;32m'
  COLOR_YELLOW=$'\033[0;33m'
  COLOR_BLUE=$'\033[0;34m'
  COLOR_BOLD=$'\033[1m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_RED=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_BLUE=""
  COLOR_BOLD=""
  COLOR_RESET=""
fi

info()  { printf '%s==>%s %s\n' "${COLOR_BLUE}" "${COLOR_RESET}" "$*"; }
ok()    { printf '%s==>%s %s\n' "${COLOR_GREEN}" "${COLOR_RESET}" "$*"; }
warn()  { printf '%s==> Warning:%s %s\n' "${COLOR_YELLOW}" "${COLOR_RESET}" "$*" >&2; }
fail()  { printf '%s==> Error:%s %s\n' "${COLOR_RED}" "${COLOR_RESET}" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

print_help() {
  cat <<EOF
${APP_NAME} installer

Usage:
  install.sh [options]

Options:
  --version vX.Y.Z   Install a specific release instead of the latest.
  --uninstall         Remove a previously installed ${APP_NAME}.
  --appimage          Force AppImage install on Linux.
  --help              Show this help text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      [ -n "$VERSION" ] || fail "--version requires an argument (e.g. --version v0.1.0)"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --appimage)
      FORCE_APPIMAGE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      fail "Unknown option: $1 (see --help)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Detection (overridable for tests via CD_TEST_* env vars)
# ---------------------------------------------------------------------------

detect_os() {
  if [ -n "${CD_TEST_OS:-}" ]; then
    echo "$CD_TEST_OS"
    return
  fi
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) fail "Unsupported operating system: $(uname -s)" ;;
  esac
}

detect_arch() {
  if [ -n "${CD_TEST_ARCH:-}" ]; then
    echo "$CD_TEST_ARCH"
    return
  fi
  case "$(uname -m)" in
    x86_64|amd64) echo "x86_64" ;;
    arm64|aarch64) echo "aarch64" ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac
}

detect_package_manager() {
  if [ -n "${CD_TEST_PM:-}" ]; then
    echo "$CD_TEST_PM"
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v dnf >/dev/null 2>&1; then
    echo "dnf"
  elif command -v yum >/dev/null 2>&1; then
    echo "yum"
  elif command -v zypper >/dev/null 2>&1; then
    echo "zypper"
  else
    echo "none"
  fi
}

SUDO=""
need_sudo() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      fail "This step requires root privileges, and 'sudo' was not found. Re-run as root."
    fi
  fi
}

# ---------------------------------------------------------------------------
# GitHub release API helpers
# ---------------------------------------------------------------------------

# Prints the resolved version tag (e.g. "v0.1.0") to stdout.
resolve_version() {
  if [ -n "$VERSION" ]; then
    echo "$VERSION"
    return
  fi

  if [ -n "${CD_TEST_ASSETS_JSON:-}" ]; then
    echo "v0.0.0-test"
    return
  fi

  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
  local tag=""

  if command -v curl >/dev/null 2>&1; then
    tag=$(curl -fsSL "$api_url" 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/') || true
  fi

  if [ -z "$tag" ]; then
    # Fall back to following the redirect of /releases/latest, in case the
    # API is rate-limited.
    local redirect_url="https://github.com/${REPO}/releases/latest"
    tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$redirect_url" 2>/dev/null | sed -E 's#.*/tag/##') || true
  fi

  [ -n "$tag" ] || fail "Could not determine the latest release version. Try again with --version vX.Y.Z."
  echo "$tag"
}

# Prints the JSON asset list (an array of {"name", "browser_download_url"}) for
# the given tag to stdout. Uses CD_TEST_ASSETS_JSON when set (for --dry-run
# testing), otherwise queries the GitHub API.
fetch_assets_json() {
  local tag="$1"

  if [ -n "${CD_TEST_ASSETS_JSON:-}" ]; then
    cat "$CD_TEST_ASSETS_JSON"
    return
  fi

  local api_url="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
  curl -fsSL "$api_url" || fail "Could not fetch release metadata for tag ${tag}."
}

# Extracts "name" and "browser_download_url" pairs from the asset JSON with a
# small grep/sed pipeline (avoids requiring jq). Prints one "name\turl" pair
# per line.
list_assets() {
  local json="$1"
  # Each asset object contains a "name" and a "browser_download_url" key;
  # walk them in order and pair them up.
  local names urls
  names=$(printf '%s' "$json" | grep -o '"name": *"[^"]*"' | sed -E 's/"name": *"([^"]*)"/\1/')
  urls=$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*"' | sed -E 's/"browser_download_url": *"([^"]*)"/\1/')
  paste -d'\t' <(printf '%s\n' "$names") <(printf '%s\n' "$urls")
}

# Picks the first asset whose name matches the given extended regex.
# Args: json, regex
pick_asset() {
  local json="$1"
  local regex="$2"
  list_assets "$json" | grep -E "$(printf '%s' "$regex")" | head -n1 | cut -f2
}

# ---------------------------------------------------------------------------
# Asset selection
# ---------------------------------------------------------------------------

# Determines the install method and matching asset URL for the current
# platform. Prints "method\turl" on stdout (method is one of: macos-dmg,
# linux-deb, linux-rpm, linux-appimage).
select_asset() {
  local os="$1" arch="$2" pm="$3" json="$4"

  if [ "$os" = "macos" ]; then
    local url
    url=$(pick_asset "$json" '\.dmg$')
    [ -n "$url" ] || fail "No .dmg asset found in the release."
    printf 'macos-dmg\t%s\n' "$url"
    return
  fi

  # Linux
  local arch_alt
  if [ "$arch" = "x86_64" ]; then
    arch_alt="amd64"
  else
    arch_alt="arm64"
  fi

  if [ "$FORCE_APPIMAGE" = "true" ]; then
    local url
    url=$(pick_asset "$json" "(${arch}|${arch_alt}).*\\.AppImage$")
    [ -z "$url" ] && url=$(pick_asset "$json" '\.AppImage$')
    [ -n "$url" ] || fail "No AppImage asset found in the release."
    printf 'linux-appimage\t%s\n' "$url"
    return
  fi

  case "$pm" in
    apt)
      local url
      url=$(pick_asset "$json" "(${arch}|${arch_alt}).*\\.deb$")
      [ -z "$url" ] && url=$(pick_asset "$json" '\.deb$')
      if [ -n "$url" ]; then
        printf 'linux-deb\t%s\n' "$url"
        return
      fi
      warn "No matching .deb asset found; falling back to AppImage."
      ;;
    dnf|yum|zypper)
      local url
      url=$(pick_asset "$json" "(${arch}|${arch_alt}).*\\.rpm$")
      [ -z "$url" ] && url=$(pick_asset "$json" '\.rpm$')
      if [ -n "$url" ]; then
        printf 'linux-rpm\t%s\n' "$url"
        return
      fi
      warn "No matching .rpm asset found; falling back to AppImage."
      ;;
  esac

  local url
  url=$(pick_asset "$json" "(${arch}|${arch_alt}).*\\.AppImage$")
  [ -z "$url" ] && url=$(pick_asset "$json" '\.AppImage$')
  [ -n "$url" ] || fail "No matching Linux package found in the release for this system."
  printf 'linux-appimage\t%s\n' "$url"
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------

download() {
  local url="$1" dest="$2"
  info "Downloading $(basename "$dest")..."
  curl -fL --progress-bar "$url" -o "$dest" || fail "Download failed: $url"
}

install_linux_deb() {
  local file="$1"
  need_sudo
  info "Installing .deb package..."
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  $SUDO apt-get install -y "./${file}"
  ok "${APP_NAME} installed."
}

install_linux_rpm() {
  local file="$1" pm="$2"
  need_sudo
  info "Installing .rpm package with ${pm}..."
  case "$pm" in
    dnf) $SUDO dnf install -y "./${file}" ;;
    yum) $SUDO yum install -y "./${file}" ;;
    zypper) $SUDO zypper --non-interactive install "./${file}" ;;
    *) fail "Unknown package manager for rpm install: ${pm}" ;;
  esac
  ok "${APP_NAME} installed."
}

install_linux_appimage() {
  local file="$1"
  local bin_dir="${HOME}/.local/bin"
  local apps_dir="${HOME}/.local/share/applications"
  local icons_dir="${HOME}/.local/share/icons/hicolor/256x256/apps"

  mkdir -p "$bin_dir" "$apps_dir" "$icons_dir"

  local dest="${bin_dir}/${BIN_NAME}"
  cp "$file" "$dest"
  chmod +x "$dest"

  info "Downloading application icon..."
  if ! curl -fsSL "$ICON_RAW_URL" -o "${icons_dir}/${BIN_NAME}.png" 2>/dev/null; then
    warn "Could not download the app icon; continuing without one."
  fi

  cat > "${apps_dir}/${BIN_NAME}.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Desktop GUI for Colima container runtimes
Exec=${dest}
Icon=${BIN_NAME}
Categories=Development;Utility;
Terminal=false
EOF

  ok "${APP_NAME} installed as an AppImage to ${dest}"

  case ":$PATH:" in
    *":${bin_dir}:"*) ;;
    *) warn "${bin_dir} is not on your PATH. Add this to your shell profile: export PATH=\"${bin_dir}:\$PATH\"" ;;
  esac
}

install_macos_dmg() {
  local file="$1"

  if command -v brew >/dev/null 2>&1; then
    info "Homebrew detected. You can install/update via Homebrew instead:"
    echo "    brew tap alperen-selcuk/tap"
    echo "    brew trust --cask alperen-selcuk/tap/colima-desktop  # older Homebrew versions can skip this"
    echo "    brew install colima-desktop"
    info "Continuing with direct .dmg install..."
  fi

  info "Mounting disk image..."
  local mount_point
  mount_point=$(mktemp -d "${TMP_DIR}/mount.XXXXXX")
  hdiutil attach -nobrowse -mountpoint "$mount_point" "$file" >/dev/null

  local app_src="${mount_point}/${APP_NAME}.app"
  [ -d "$app_src" ] || fail "Could not find ${APP_NAME}.app inside the disk image."

  local target_dir="/Applications"
  if [ ! -w "$target_dir" ]; then
    target_dir="${HOME}/Applications"
    mkdir -p "$target_dir"
  fi

  info "Copying ${APP_NAME}.app to ${target_dir}..."
  rm -rf "${target_dir:?}/${APP_NAME}.app"
  cp -R "$app_src" "$target_dir/"

  hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true

  info "Removing quarantine attribute (unsigned build)..."
  xattr -dr com.apple.quarantine "${target_dir}/${APP_NAME}.app" 2>/dev/null || true

  ok "${APP_NAME} installed to ${target_dir}/${APP_NAME}.app"
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
  local os
  os=$(detect_os)

  if [ "$os" = "macos" ]; then
    local removed=false
    for dir in "/Applications" "${HOME}/Applications"; do
      if [ -d "${dir}/${APP_NAME}.app" ]; then
        info "Removing ${dir}/${APP_NAME}.app..."
        rm -rf "${dir:?}/${APP_NAME}.app"
        removed=true
      fi
    done
    rm -rf "${HOME}/Library/Application Support/${BUNDLE_ID}" \
           "${HOME}/Library/Caches/${BUNDLE_ID}" \
           "${HOME}/Library/Preferences/${BUNDLE_ID}.plist" \
           "${HOME}/Library/Saved Application State/${BUNDLE_ID}.savedState" 2>/dev/null || true
    if [ "$removed" = "true" ]; then
      ok "${APP_NAME} uninstalled."
    else
      warn "${APP_NAME}.app was not found in /Applications or ~/Applications."
    fi
    return
  fi

  # Linux: try package managers first, then the AppImage install location.
  if command -v dpkg >/dev/null 2>&1 && dpkg -s colima-desktop >/dev/null 2>&1; then
    need_sudo
    info "Removing .deb package..."
    $SUDO apt-get remove -y colima-desktop
    ok "${APP_NAME} uninstalled."
    return
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -q colima-desktop >/dev/null 2>&1; then
    need_sudo
    info "Removing .rpm package..."
    if command -v dnf >/dev/null 2>&1; then $SUDO dnf remove -y colima-desktop
    elif command -v yum >/dev/null 2>&1; then $SUDO yum remove -y colima-desktop
    else $SUDO zypper --non-interactive remove colima-desktop; fi
    ok "${APP_NAME} uninstalled."
    return
  fi

  local removed=false
  local bin="${HOME}/.local/bin/${BIN_NAME}"
  local desktop="${HOME}/.local/share/applications/${BIN_NAME}.desktop"
  local icon="${HOME}/.local/share/icons/hicolor/256x256/apps/${BIN_NAME}.png"
  for f in "$bin" "$desktop" "$icon"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      removed=true
    fi
  done
  if [ "$removed" = "true" ]; then
    ok "${APP_NAME} (AppImage install) uninstalled."
  else
    warn "No Colima Desktop installation found to remove."
  fi
}

# ---------------------------------------------------------------------------
# Post-install dependency check
# ---------------------------------------------------------------------------

print_next_steps() {
  local os="$1"
  echo
  info "Checking for required companion tools..."

  local missing=()
  command -v colima >/dev/null 2>&1 || missing+=("colima")
  command -v docker >/dev/null 2>&1 || missing+=("docker")
  command -v kubectl >/dev/null 2>&1 || missing+=("kubectl (optional, for the Kubernetes view)")

  if [ ${#missing[@]} -eq 0 ]; then
    ok "colima, docker and kubectl are all on your PATH. You're all set!"
    return
  fi

  warn "Some companion tools were not found on your PATH:"
  for m in "${missing[@]}"; do
    echo "    - $m"
  done

  echo
  if [ "$os" = "macos" ]; then
    echo "  Install them with Homebrew:"
    echo "    brew install colima docker kubectl"
  else
    echo "  Install options:"
    echo "    Homebrew on Linux: brew install colima docker"
    echo "    Or download the colima release binary directly:"
    echo "      https://github.com/abiosoft/colima/releases"
    echo "      (colima on Linux requires qemu or lima as a VM backend)"
    echo "    kubectl: https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/"
  fi
  echo
  echo "  ${COLOR_BOLD}${APP_NAME}${COLOR_RESET} is now installed. Launch it, then run 'colima start' inside the app."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  if [ "$UNINSTALL" = "true" ]; then
    do_uninstall
    exit 0
  fi

  local os arch pm
  os=$(detect_os)
  arch=$(detect_arch)
  pm=$(detect_package_manager)

  local tag
  tag=$(resolve_version)

  local assets_json
  assets_json=$(fetch_assets_json "$tag")

  local selection method url
  selection=$(select_asset "$os" "$arch" "$pm" "$assets_json")
  method=$(printf '%s' "$selection" | cut -f1)
  url=$(printf '%s' "$selection" | cut -f2)

  if [ "$DRY_RUN" = "true" ]; then
    printf 'method=%s\n' "$method"
    printf 'url=%s\n' "$url"
    printf 'os=%s\n' "$os"
    printf 'arch=%s\n' "$arch"
    printf 'pm=%s\n' "$pm"
    printf 'tag=%s\n' "$tag"
    exit 0
  fi

  info "${APP_NAME} installer — resolved version ${tag} (${os}/${arch})"

  TMP_DIR=$(mktemp -d)
  local filename="${url##*/}"
  local dest="${TMP_DIR}/${filename}"

  download "$url" "$dest"

  case "$method" in
    macos-dmg) install_macos_dmg "$dest" ;;
    linux-deb) install_linux_deb "$dest" ;;
    linux-rpm) install_linux_rpm "$dest" "$pm" ;;
    linux-appimage) install_linux_appimage "$dest" ;;
    *) fail "Unknown install method: $method" ;;
  esac

  print_next_steps "$os"
}

main "$@"
