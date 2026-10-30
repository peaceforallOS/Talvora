#!/usr/bin/env bash
# ==============================================================================
# Packaging Deliverables: Linux Client, Windows Client & Linux Server Installer
# ==============================================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${PROJECT_ROOT}/dist"

# Each client must be built on its own platform: a Windows .exe built on Linux fails to unpack.
# Usage: package-deliverables.sh [linux] [server] [windows]
#   default on Linux/WSL: linux server    default on Windows (Git Bash): windows
# Only the chosen deliverables are replaced in dist/; the others are left as they are.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=1 ;; *) ON_WINDOWS="" ;; esac
TARGETS=" $* "
if [ -z "$*" ]; then TARGETS=$([ -n "${ON_WINDOWS}" ] && echo " windows " || echo " linux server "); fi
want() { [[ "${TARGETS}" == *" $1 "* ]]; }
if want windows && [ -z "${ON_WINDOWS}" ]; then
  echo "The Windows client must be built on Windows (Git Bash): an .exe built here fails to unpack."
  exit 1
fi
if { want linux || want server; } && [ -n "${ON_WINDOWS}" ]; then
  echo "The Linux client and the server installer must be built on Linux (or WSL)."
  exit 1
fi

echo ">> Preparing distribution directory at ${DIST_DIR}..."
for target in linux windows server; do
  if want "${target}"; then rm -rf "${DIST_DIR:?}/${target}"; mkdir -p "${DIST_DIR}/${target}"; fi
done
want server && rm -f "${DIST_DIR}/videocall-server.tar.gz"

cd "${PROJECT_ROOT}/client"
if [ ! -x node_modules/.bin/electron-builder ]; then
  npm install --no-audit --no-fund --silent
fi

if want linux; then
# --- 1. Package Linux Client ---
# A single VideoCall.AppImage (Electron + app bundled; double-click to run, no install).
# package.json selects the static AppImage runtime, which needs no libfuse2 (missing on
# current Ubuntu/Fedora). main.js handles the Chromium sandbox, so nothing asks for sudo.
echo ">> Packaging Deliverable 1: Linux Client..."
LINUX_DIR="${DIST_DIR}/linux"
APPIMAGE_TOOLS=""
if command -v mksquashfs >/dev/null 2>&1; then
  # The toolset's bundled mksquashfs wrapper sets LD_LIBRARY_PATH to libraries that break
  # system tools on some distributions, so assemble a toolset around the system mksquashfs
  APPIMAGE_TOOLS="$(mktemp -d)"
  trap 'rm -rf "${APPIMAGE_TOOLS}"' EXIT
  RUNTIME=$(node -e "
const version = require('./package.json').build.toolsets.appimage;
require('app-builder-lib/out/toolsets/linux').getAppImageTools(version, 1 /* x64 */)
  .then(tools => console.log(tools.runtime));
" | tail -n 1) # the first run downloads the toolset and may print progress before the path
  [ -f "${RUNTIME}" ] || { echo "AppImage runtime not found: ${RUNTIME}"; exit 1; }
  mkdir -p "${APPIMAGE_TOOLS}/runtimes" "${APPIMAGE_TOOLS}/lib/x64"
  ln -s "${RUNTIME}" "${APPIMAGE_TOOLS}/runtimes/runtime-x64"
  ln -s "$(command -v mksquashfs)" "${APPIMAGE_TOOLS}/mksquashfs"
  ln -s "$(command -v desktop-file-validate || echo /usr/bin/true)" "${APPIMAGE_TOOLS}/desktop-file-validate"
fi
rm -rf release
APPIMAGE_TOOLS_PATH="${APPIMAGE_TOOLS}" npx electron-builder --linux AppImage --x64 > "${DIST_DIR}/linux-build.log" 2>&1 || {
  echo "Linux build failed; see ${DIST_DIR}/linux-build.log"
  exit 1
}
[ -n "${APPIMAGE_TOOLS}" ] && rm -rf "${APPIMAGE_TOOLS}"
cp release/VideoCall.AppImage "${LINUX_DIR}/VideoCall.AppImage"
chmod +x "${LINUX_DIR}/VideoCall.AppImage"
rm -rf release "${DIST_DIR}/linux-build.log"

cat > "${LINUX_DIR}/README-LINUX.txt" << 'EOF'
================================================================================
VIDEO CALL APPLICATION — LINUX CLIENT
================================================================================

HOW TO RUN:
1. Double-click VideoCall.AppImage. No installation, terminal or password needed.
   (If your file manager does not start it: right-click -> Properties ->
   Permissions -> enable "Allow executing file as program".)
2. Enter your username and the join link provided by the admin.
3. Click "Join Room" to begin your call.

To pass a join link directly from a terminal:
   ./VideoCall.AppImage "http://<server-ip>:8080/join?room=main-room&user=Omid&token=..."

SYSTEM REQUIREMENTS:
- Any 64-bit Linux distribution (Ubuntu, Debian, Fedora, openSUSE, Arch, ...).
- Microphone and webcam (optional for listening/viewing only).
- Missing system libraries are detected when VideoCall starts: it asks, then installs them
  with your package manager (apt, dnf, zypper or pacman; your password is required once).

UPDATES:
- When your VideoCall server has a newer version, the app shows it after you join a room.
  Click "Install": it downloads, checks the update's signature, replaces this AppImage file
  and restarts. (Keep the AppImage in a folder you can write to, e.g. ~/Apps.)
================================================================================
EOF
echo "✓ Linux client packaged: ${LINUX_DIR}/VideoCall.AppImage"
fi


if want windows; then
# --- 2. Package Windows Client ---
# VideoCall-Setup.exe: installs once for the current Windows user (no administrator password), then
# starts in about a second. (A portable .exe unpacked ~270 MB on every launch, ~14 s each time.)
# Built on Windows: electron-builder's Windows launchers built on Linux do not work.
echo ">> Packaging Deliverable 2: Windows Client..."
WIN_DIR="${DIST_DIR}/windows"
rm -rf release
npx electron-builder --win nsis --x64 > "${DIST_DIR}/windows-build.log" 2>&1 || {
  echo "Windows build failed; see ${DIST_DIR}/windows-build.log"
  exit 1
}
cp release/VideoCall-Setup.exe "${WIN_DIR}/VideoCall-Setup.exe"
rm -rf release "${DIST_DIR}/windows-build.log"

cat > "${WIN_DIR}/README-WINDOWS.txt" << 'EOF'
================================================================================
VIDEO CALL APPLICATION — WINDOWS CLIENT
================================================================================

HOW TO INSTALL AND RUN:
1. Double-click VideoCall-Setup.exe and follow the steps:
   - "Only for me" (no administrator password) or "Anyone who uses this computer"
   - the installation folder
   - desktop and Start menu shortcuts
   - "Run VideoCall" on the last page
2. Afterwards, start VideoCall from the Start menu or the desktop shortcut.
3. Enter your username and the join link provided by the admin, then click "Join Room".

UPDATES:
- When your VideoCall server has a newer version, the app shows it after you join a
  room. Click "Install": it downloads, checks the update's signature, installs it in the
  same place and restarts. Nothing else is needed.

NOTES:
- The app is not code-signed, so Windows SmartScreen may show
  "Windows protected your PC". Click "More info" -> "Run anyway".
- Allow camera and microphone access if Windows asks.
- You can also update by running a newer VideoCall-Setup.exe; settings and recent servers are kept.
- To uninstall: Settings -> Apps -> Installed apps -> VideoCall -> Uninstall.

SYSTEM REQUIREMENTS:
- Windows 10 or Windows 11 (64-bit).
- Microphone and webcam (optional for listening/viewing only).
================================================================================
EOF
echo "✓ Windows client packaged: ${WIN_DIR}/VideoCall-Setup.exe"
fi


if want server; then
# --- 3. Package Linux Server Installer ---
echo ">> Packaging Deliverable 3: Linux Server Installer..."
# The installer needs the server, shared protocol and web client next to it.
# data/ (server secret) and node_modules/ are deliberately left out.
SERVER_BUNDLE="${DIST_DIR}/server"
mkdir -p "${SERVER_BUNDLE}/server" "${SERVER_BUNDLE}/client"
cp "${PROJECT_ROOT}/server/install-server.sh" "${SERVER_BUNDLE}/"
cp -r "${PROJECT_ROOT}/server/src" "${PROJECT_ROOT}/server/public" "${PROJECT_ROOT}/server/stubs" \
  "${PROJECT_ROOT}/server/package.json" "${PROJECT_ROOT}/server/package-lock.json" "${SERVER_BUNDLE}/server/"
cp -r "${PROJECT_ROOT}/shared" "${SERVER_BUNDLE}/"
cp -r "${PROJECT_ROOT}/client/src" "${SERVER_BUNDLE}/client/"
chmod +x "${SERVER_BUNDLE}/install-server.sh"
# One archive to copy to the server machine, so no part of the bundle gets left behind
tar czf "${DIST_DIR}/videocall-server.tar.gz" -C "${DIST_DIR}" --transform 's,^server,videocall-server,' server
echo "✓ Server installer packaged: ${SERVER_BUNDLE} (single file: ${DIST_DIR}/videocall-server.tar.gz)"

# --- 4. Release files (for GitHub: scripts/publish-release.js) ---
# All three deliverables plus manifest.json/manifest.sig, signed with the release key. Apps and
# servers install only signed releases. Build the Windows installer on Windows first.
RELEASE_DIR="${DIST_DIR}/release"
rm -rf "${RELEASE_DIR}"
if [ -f "${DIST_DIR}/windows/VideoCall-Setup.exe" ] && [ -f "${DIST_DIR}/linux/VideoCall.AppImage" ]; then
  mkdir -p "${RELEASE_DIR}"
  cp "${DIST_DIR}/windows/VideoCall-Setup.exe" "${DIST_DIR}/linux/VideoCall.AppImage" "${DIST_DIR}/videocall-server.tar.gz" "${RELEASE_DIR}/"
  node "${PROJECT_ROOT}/scripts/sign-updates.js" "${RELEASE_DIR}" || {
    echo "Release not signed (needs the release key, see scripts/sign-updates.js)."
    rm -rf "${RELEASE_DIR}"
  }
else
  echo "Note: no release files (needs dist/windows/VideoCall-Setup.exe from a Windows build and the Linux client)."
fi
fi

echo -e "\n========================================================"
echo " PACKAGED:${TARGETS}"
want windows && echo " Windows Client:   ${DIST_DIR}/windows/VideoCall-Setup.exe"
want linux && echo " Linux Client:     ${DIST_DIR}/linux/VideoCall.AppImage"
want server && echo " Server Installer: ${DIST_DIR}/videocall-server.tar.gz (or ${DIST_DIR}/server/install-server.sh)"
echo " Build the other platform's deliverables there too, so all three stay in step."
[ -d "${DIST_DIR}/release" ] && echo " Signed release:   ${DIST_DIR}/release (publish: node scripts/publish-release.js)"
echo " Raise \"version\" in client/package.json and server/package.json for every release:"
echo " apps and servers only install newer versions."
echo "========================================================"
