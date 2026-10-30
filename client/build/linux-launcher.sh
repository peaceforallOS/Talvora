#!/usr/bin/env bash
# Talvora launcher (Linux). Electron needs a set of system libraries that minimal installs can
# lack, and without them the app cannot even start. This script runs first: it finds missing
# libraries, asks for permission, installs them with the system's package manager, then starts
# the app (videocall-bin). See build/afterPack.js.
#
#   VIDEOCALL_SKIP_PREREQS=1          start without checking
#   VIDEOCALL_PREREQS_DRY_RUN=1       print what would be installed instead (tests)
#   VIDEOCALL_PREREQS_MISSING="..."   treat these libraries as missing (tests)
#   VIDEOCALL_PREREQS_PM=apt          use this package manager (tests)

HERE="$(dirname "$(readlink -f "$0")")"
BIN="${HERE}/videocall-bin"

missing_libs() {
  if [ -n "${VIDEOCALL_PREREQS_MISSING+x}" ]; then
    printf '%s\n' ${VIDEOCALL_PREREQS_MISSING} | grep .
    return
  fi
  command -v ldd >/dev/null 2>&1 || return # not a glibc system: nothing to check with
  LD_LIBRARY_PATH="${HERE}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ldd "${BIN}" 2>/dev/null |
    awk '/=> not found/ { print $1 }' | sort -u
}

package_manager() {
  if [ -n "${VIDEOCALL_PREREQS_PM}" ]; then echo "${VIDEOCALL_PREREQS_PM}"; return; fi
  for pm in apt-get dnf yum zypper pacman; do
    if command -v "${pm}" >/dev/null 2>&1; then echo "${pm%-get}"; return; fi
  done
}

# Debian/Ubuntu and Arch package for a library ("apt|pacman"). Alternatives are separated by "/":
# Ubuntu 24.04+ and Debian 13 renamed some packages with a t64 suffix.
# RPM systems (dnf, yum, zypper) install by the library name itself, e.g. 'libnss3.so()(64bit)'.
lib_packages() {
  case "$1" in
    libnss3.so|libnssutil3.so|libsmime3.so) echo "libnss3|nss" ;;
    libnspr4.so) echo "libnspr4|nspr" ;;
    libasound.so.2) echo "libasound2t64/libasound2|alsa-lib" ;;
    libgtk-3.so.0) echo "libgtk-3-0t64/libgtk-3-0|gtk3" ;;
    libgbm.so.1) echo "libgbm1|mesa" ;;
    libatk-1.0.so.0) echo "libatk1.0-0t64/libatk1.0-0|at-spi2-core" ;;
    libatk-bridge-2.0.so.0) echo "libatk-bridge2.0-0t64/libatk-bridge2.0-0|at-spi2-core" ;;
    libatspi.so.0) echo "libatspi2.0-0t64/libatspi2.0-0|at-spi2-core" ;;
    libcups.so.2) echo "libcups2t64/libcups2|libcups" ;;
    libdrm.so.2) echo "libdrm2|libdrm" ;;
    libdbus-1.so.3) echo "libdbus-1-3|dbus" ;;
    libexpat.so.1) echo "libexpat1|expat" ;;
    libudev.so.1) echo "libudev1|systemd-libs" ;;
    libglib-2.0.so.0|libgobject-2.0.so.0|libgio-2.0.so.0) echo "libglib2.0-0t64/libglib2.0-0|glib2" ;;
    libpango-1.0.so.0) echo "libpango-1.0-0|pango" ;;
    libcairo.so.2) echo "libcairo2|cairo" ;;
    libX11.so.6) echo "libx11-6|libx11" ;;
    libXcomposite.so.1) echo "libxcomposite1|libxcomposite" ;;
    libXdamage.so.1) echo "libxdamage1|libxdamage" ;;
    libXext.so.6) echo "libxext6|libxext" ;;
    libXfixes.so.3) echo "libxfixes3|libxfixes" ;;
    libXrandr.so.2) echo "libxrandr2|libxrandr" ;;
    libxcb.so.1) echo "libxcb1|libxcb" ;;
    libxkbcommon.so.0) echo "libxkbcommon0|libxkbcommon" ;;
    *) echo "" ;;
  esac
}

# First apt alternative this system offers (falls back to the first one listed)
apt_choice() {
  local alt
  for alt in ${1//\// }; do
    if apt-cache policy "${alt}" 2>/dev/null | grep -q 'Candidate: [^(]'; then echo "${alt}"; return; fi
  done
  echo "${1%%/*}"
}

# Packages to install for the missing libraries ("UNKNOWN:<lib>" when there is no known package)
packages_for() {
  local pm="$1" lib entry pkg
  shift
  for lib in "$@"; do
    case "${pm}" in
      dnf|yum|zypper)
        echo "${lib}()(64bit)"
        continue ;;
    esac
    entry="$(lib_packages "${lib}")"
    if [ -z "${entry}" ]; then echo "UNKNOWN:${lib}"; continue; fi
    case "${pm}" in
      apt) pkg="$(apt_choice "${entry%%|*}")" ;;
      pacman) pkg="${entry##*|}" ;;
      *) pkg="" ;;
    esac
    echo "${pkg:-UNKNOWN:${lib}}"
  done | sort -u
}

install_command() {
  local pm="$1"
  shift
  case "${pm}" in
    apt) echo "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y $*" ;;
    dnf) echo "dnf install -y $*" ;;
    yum) echo "yum install -y $*" ;;
    zypper) echo "zypper --non-interactive install $*" ;;
    pacman) echo "pacman -S --noconfirm --needed $*" ;;
  esac
}

# Dialogs run without the app's library path (they are system programs)
show_error() {
  if [ -t 2 ]; then echo "Talvora: $1" >&2; fi
  if command -v zenity >/dev/null 2>&1; then LD_LIBRARY_PATH="" zenity --error --title=Talvora --text="$1" 2>/dev/null
  elif command -v kdialog >/dev/null 2>&1; then LD_LIBRARY_PATH="" kdialog --title Talvora --error "$1" 2>/dev/null
  elif command -v notify-send >/dev/null 2>&1; then LD_LIBRARY_PATH="" notify-send Talvora "$1" 2>/dev/null
  fi
}

ask_permission() {
  local text="$1"
  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s\nInstall now? [Y/n] ' "${text}"
    read -r answer
    [[ -z "${answer}" || "${answer}" =~ ^[Yy] ]]
    return
  fi
  if command -v zenity >/dev/null 2>&1; then
    LD_LIBRARY_PATH="" zenity --question --title=Talvora --width=420 --text="${text}" --ok-label=Install 2>/dev/null
  elif command -v kdialog >/dev/null 2>&1; then
    LD_LIBRARY_PATH="" kdialog --title Talvora --yesno "${text}" 2>/dev/null
  else
    return 0 # no dialog program: the system's password prompt below asks instead
  fi
}

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then sh -c "$1"
  elif [ -t 0 ] && command -v sudo >/dev/null 2>&1; then sudo sh -c "$1"
  elif command -v pkexec >/dev/null 2>&1; then LD_LIBRARY_PATH="" pkexec sh -c "$1"
  else return 1
  fi
}

ensure_prerequisites() {
  local missing pm packages unknown cmd
  mapfile -t missing < <(missing_libs)
  [ "${#missing[@]}" -eq 0 ] && return 0

  pm="$(package_manager)"
  mapfile -t packages < <(packages_for "${pm}" "${missing[@]}")
  unknown=()
  local known=()
  for p in "${packages[@]}"; do
    if [[ "${p}" == UNKNOWN:* ]]; then unknown+=("${p#UNKNOWN:}"); else known+=("${p}"); fi
  done
  cmd=""
  [ -n "${pm}" ] && [ "${#known[@]}" -gt 0 ] && cmd="$(install_command "${pm}" "${known[@]}")"

  if [ -n "${VIDEOCALL_PREREQS_DRY_RUN}" ]; then
    echo "missing: ${missing[*]}"
    echo "package manager: ${pm:-none}"
    echo "packages: ${known[*]}"
    echo "unknown: ${unknown[*]}"
    echo "command: ${cmd}"
    exit 0
  fi

  if [ -z "${cmd}" ]; then
    show_error "Talvora cannot start: these system libraries are missing: ${missing[*]}. Install them with your distribution's package manager, then start Talvora again."
    exit 1
  fi
  if ! ask_permission "Talvora needs some system components that are not installed yet: ${known[*]}. They will be installed with your system's package manager (your password is required)."; then
    show_error "Talvora cannot start without: ${known[*]}. Install them with: ${cmd}"
    exit 1
  fi
  if ! run_as_root "${cmd}"; then
    show_error "The system components could not be installed. Install them with: sudo sh -c '${cmd}'"
    exit 1
  fi

  mapfile -t missing < <(missing_libs)
  if [ "${#missing[@]}" -gt 0 ]; then
    show_error "Talvora cannot start: still missing ${missing[*]}. Install them with your distribution's package manager."
    exit 1
  fi
}

[ -z "${VIDEOCALL_SKIP_PREREQS}" ] && ensure_prerequisites
exec "${BIN}" "$@"
