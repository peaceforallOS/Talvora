#!/usr/bin/env bash
# ==============================================================================
# Video Call Application — Linux Server Edition Automated Installer
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}"
echo "========================================================================"
echo "    VIDEO CALL APPLICATION — LINUX SERVER EDITION INSTALLER            "
echo "========================================================================"
echo -e "${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Options (all optional; without them the installer asks):
#   --domain example.com   use this domain for the HTTPS certificate (Let's Encrypt)
#   --email you@example.com  contact address for certificate expiry notices
#   --lan-only             do not open ports on the router (only this network can join)
# Connections are always encrypted (HTTPS); there is no plain-HTTP option.
ARG_DOMAIN=""; ARG_EMAIL=""; ARG_LAN_ONLY=""; ARGS_GIVEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) ARG_DOMAIN="$2"; ARGS_GIVEN=1; shift 2 ;;
    --email) ARG_EMAIL="$2"; ARGS_GIVEN=1; shift 2 ;;
    --no-https) echo "--no-https is no longer supported: VideoCall only accepts encrypted (HTTPS) connections."; exit 1 ;;
    --lan-only) ARG_LAN_ONLY=1; ARGS_GIVEN=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
SERVER_SRC="${SCRIPT_DIR}/server"

if [ ! -d "$SERVER_SRC" ]; then
  if [ -f "${SCRIPT_DIR}/src/index.js" ]; then
    SERVER_SRC="$SCRIPT_DIR"
  else
    echo -e "${RED}Error: Could not locate server source files.${NC}"
    exit 1
  fi
fi

# Shared protocol and the web client live next to the server (bundle) or one level up (repo)
find_dir() {
  for candidate in "$@"; do
    if [ -d "$candidate" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}
SHARED_SRC=$(find_dir "${SCRIPT_DIR}/shared" "${SERVER_SRC}/../shared") || {
  echo -e "${RED}Error: Could not locate the shared protocol files (folder 'shared').${NC}"
  echo "Run this installer from the complete server bundle, which contains:"
  echo "  install-server.sh  server/  shared/  client/"
  echo "Copy the whole bundle (e.g. videocall-server.tar.gz) and run:"
  echo "  tar xzf videocall-server.tar.gz && cd videocall-server && sudo ./install-server.sh"
  exit 1
}
CLIENT_SRC=$(find_dir "${SCRIPT_DIR}/client/src" "${SERVER_SRC}/../client/src") || CLIENT_SRC=""

INSTALL_DIR="/opt/videocall-server"
if [ "$EUID" -ne 0 ]; then
  INSTALL_DIR="${HOME}/.local/share/videocall-server"
fi

# 1. Node.js runtime (v18 or newer, with npm). When the system has none or an older one, a private
#    copy of the current Node.js LTS is downloaded from nodejs.org, checksum-verified, into
#    ${INSTALL_DIR}/node; the system's own packages are left untouched. Works on any Linux.
echo -e "${YELLOW}>> Checking system dependencies...${NC}"
MIN_NODE_MAJOR=18
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
PRIVATE_NODE_DIR="${INSTALL_DIR}/node"

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Small tools the installer itself needs, from the system's package manager (root only)
install_system_packages() {
  [ "$EUID" -eq 0 ] || return 1
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then yum install -y "$@"
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install "$@"
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed "$@"
  elif command -v apk >/dev/null 2>&1; then apk add "$@"
  else return 1
  fi
}

install_private_node() {
  local arch sums file tmp
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    ppc64le) arch=ppc64le ;;
    s390x) arch=s390x ;;
    *) echo -e "${RED}No Node.js build for this processor ($(uname -m)). Install Node.js ${MIN_NODE_MAJOR}+ and re-run the installer.${NC}"; exit 1 ;;
  esac
  if [ -f /etc/alpine-release ]; then
    # nodejs.org builds need glibc; Alpine's own package is current enough
    install_system_packages nodejs npm && return 0
    echo -e "${RED}Install Node.js ${MIN_NODE_MAJOR}+ (apk add nodejs npm) and re-run the installer.${NC}"; exit 1
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "Installing curl to download Node.js..."
    install_system_packages curl ca-certificates || {
      echo -e "${RED}curl or wget is required to download Node.js. Install one of them and re-run the installer.${NC}"; exit 1; }
  fi
  fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

  echo "Downloading Node.js LTS for ${arch} from nodejs.org..."
  sums="$(fetch "${NODE_DIST}/SHASUMS256.txt")" || { echo -e "${RED}Could not reach nodejs.org. Check the internet connection and re-run the installer.${NC}"; exit 1; }
  file="$(echo "${sums}" | awk -v want="-linux-${arch}.tar.gz" '{ if (substr($2, length($2) - length(want) + 1) == want) { print $2; exit } }')"
  [ -n "${file}" ] || { echo -e "${RED}No Node.js download found for linux-${arch}.${NC}"; exit 1; }
  tmp="$(mktemp -d)"
  fetch "${NODE_DIST}/${file}" > "${tmp}/${file}" || { rm -rf "${tmp}"; echo -e "${RED}Node.js download failed.${NC}"; exit 1; }
  if ! (cd "${tmp}" && echo "${sums}" | grep "  ${file}\$" | sha256sum -c - >/dev/null 2>&1); then
    rm -rf "${tmp}"; echo -e "${RED}The Node.js download did not match its published checksum; nothing was installed.${NC}"; exit 1
  fi
  rm -rf "${PRIVATE_NODE_DIR}"
  mkdir -p "${PRIVATE_NODE_DIR}"
  tar -xzf "${tmp}/${file}" -C "${PRIVATE_NODE_DIR}" --strip-components=1 --no-same-owner
  rm -rf "${tmp}"
  if ! "${PRIVATE_NODE_DIR}/bin/node" -v >/dev/null 2>&1; then
    rm -rf "${PRIVATE_NODE_DIR}"
    echo -e "${RED}The downloaded Node.js does not run on this system (it needs glibc 2.28 or newer). Install Node.js ${MIN_NODE_MAJOR}+ and re-run the installer.${NC}"
    exit 1
  fi
}

if [ -x "${PRIVATE_NODE_DIR}/bin/node" ] && [ "$(node_major "${PRIVATE_NODE_DIR}/bin/node")" -ge "${MIN_NODE_MAJOR}" ]; then
  export PATH="${PRIVATE_NODE_DIR}/bin:${PATH}"
  echo -e "${GREEN}✓ Node.js $(node -v) (VideoCall's own copy)${NC}"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "${MIN_NODE_MAJOR}" ] && command -v npm >/dev/null 2>&1; then
  echo -e "${GREEN}✓ Node.js $(node -v) is installed${NC}"
else
  if command -v node >/dev/null 2>&1; then
    echo -e "${YELLOW}Node.js $(node -v) is too old (VideoCall needs ${MIN_NODE_MAJOR} or newer, with npm).${NC}"
  else
    echo -e "${YELLOW}Node.js is not installed.${NC}"
  fi
  mkdir -p "${INSTALL_DIR}"
  install_private_node
  [ -x "${PRIVATE_NODE_DIR}/bin/node" ] && export PATH="${PRIVATE_NODE_DIR}/bin:${PATH}"
  echo -e "${GREEN}✓ Node.js $(node -v) installed for VideoCall${NC}"
fi

# 2. Setup Server Directory

echo -e "\n${YELLOW}>> Deploying server files to ${INSTALL_DIR}...${NC}"
mkdir -p "${INSTALL_DIR}"
# Never copy data/ (it holds this machine's server secret and would overwrite an existing
# install's config) or node_modules/ (dependencies are installed fresh below)
for item in src public package.json package-lock.json; do
  if [ -e "${SERVER_SRC}/${item}" ]; then
    rm -rf "${INSTALL_DIR:?}/${item}"
    cp -r "${SERVER_SRC}/${item}" "${INSTALL_DIR}/"
  fi
done
rm -rf "${INSTALL_DIR}/shared"
cp -r "${SHARED_SRC}" "${INSTALL_DIR}/shared"
if [ -n "${CLIENT_SRC}" ]; then
  # Served at /join so invitees can use the call from a browser
  rm -rf "${INSTALL_DIR}/client"
  mkdir -p "${INSTALL_DIR}/client"
  cp -r "${CLIENT_SRC}" "${INSTALL_DIR}/client/src"
else
  echo -e "${YELLOW}Warning: web client files not found; browser join links (/join) will not work.${NC}"
fi

cd "${INSTALL_DIR}"

# 3. Install npm dependencies
if ! command -v npm >/dev/null 2>&1; then
  echo -e "${RED}npm is required to install server dependencies.${NC}"
  exit 1
fi
echo "Installing required dependencies..."
npm install --omit=dev --no-audit --no-fund --silent

# 4. HTTPS settings (kept in server.env, read by the service and the launcher)
echo -e "\n${YELLOW}>> Configuring HTTPS...${NC}"
ENV_FILE="${INSTALL_DIR}/server.env"
if [ "$EUID" -eq 0 ]; then
  HTTPS_PORT=443; HTTP_PORT=80
else
  # Ports below 1024 need root, so Let's Encrypt (which checks port 80) is not possible here
  HTTPS_PORT=8443; HTTP_PORT=8080
fi

if [ -f "${ENV_FILE}" ] && [ -z "${ARGS_GIVEN}" ]; then
  echo -e "${GREEN}✓ Keeping the existing settings in ${ENV_FILE}${NC}"
else
  DOMAIN="${ARG_DOMAIN}"; ACME_EMAIL="${ARG_EMAIL}"
  if [ -z "${ARGS_GIVEN}" ] && [ -t 0 ] && [ "$EUID" -eq 0 ]; then
    echo "The server uses HTTPS so calls and passwords are encrypted."
    echo "If this server has a domain name (e.g. call.example.com) pointing to it, enter it now."
    echo "No domain? Just press Enter: the server gets a certificate for its IP address instead."
    read -r -p "Domain name (optional): " DOMAIN
    read -r -p "Email for certificate notices (optional): " ACME_EMAIL
    echo ""
    echo "Should people outside this network (over the internet) be able to join?"
    echo "If yes and the server is behind a home/office router, it opens its ports on the router"
    echo "automatically (UPnP) and removes them again when the server stops."
    read -r -p "Allow joining over the internet? [Y/n] " ANSWER
    [[ "${ANSWER}" =~ ^[Nn] ]] && ARG_LAN_ONLY=1
  fi
  # server.env is read by bash as root: accept only plain host names and email addresses
  DOMAIN="$(echo "${DOMAIN}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  ACME_EMAIL="$(echo "${ACME_EMAIL}" | tr -d '[:space:]')"
  if [ -n "${DOMAIN}" ] && ! [[ "${DOMAIN}" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
    echo -e "${RED}Error: '${DOMAIN}' is not a valid domain name (example: call.example.com).${NC}"
    exit 1
  fi
  if [ -n "${ACME_EMAIL}" ] && ! [[ "${ACME_EMAIL}" =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$ ]]; then
    echo -e "${RED}Error: '${ACME_EMAIL}' is not a valid email address.${NC}"
    exit 1
  fi
  TLS_MODE=auto
  if [ -n "${ARG_LAN_ONLY}" ]; then PORT_FORWARDING=off; PUBLIC_IP=""; else PORT_FORWARDING=auto; PUBLIC_IP=auto; fi
  umask 077
  cat > "${ENV_FILE}" << EOF
# Video Call server settings. Re-run the installer (or edit this file and restart) to change them.
TLS_MODE=${TLS_MODE}
DOMAIN=${DOMAIN}
# Reachable from the internet: PORT_FORWARDING=auto opens the ports on the router (UPnP) and
# PUBLIC_IP=auto then uses the router's public address (and a Let's Encrypt certificate for it).
# A fixed address can be given instead; leave both off for a server used only on this network.
PORT_FORWARDING=${PORT_FORWARDING}
PUBLIC_IP=${PUBLIC_IP}
ACME_EMAIL=${ACME_EMAIL}
HTTPS_PORT=${HTTPS_PORT}
HTTP_PORT=${HTTP_PORT}
PORT=8080
EOF
  umask 022
fi
# shellcheck disable=SC1090
. "${ENV_FILE}"

# Settings from older versions may have HTTPS turned off: connections must be encrypted now
if [ "${TLS_MODE}" != "auto" ]; then
  if grep -q '^TLS_MODE=' "${ENV_FILE}"; then
    sed -i 's/^TLS_MODE=.*/TLS_MODE=auto/' "${ENV_FILE}"
  else
    echo "TLS_MODE=auto" >> "${ENV_FILE}"
  fi
  TLS_MODE=auto
  echo -e "${YELLOW}HTTPS was off in ${ENV_FILE}; it is now on. Send your users new (https://) invite links.${NC}"
fi

if [ "${TLS_MODE}" = "auto" ] && [ -n "${DOMAIN}" ] && command -v getent >/dev/null 2>&1; then
  if ! getent hosts "${DOMAIN}" >/dev/null; then
    echo -e "${YELLOW}Warning: ${DOMAIN} does not resolve yet. Point its DNS A record to this server;${NC}"
    echo -e "${YELLOW}until then the server uses its own certificate and keeps retrying.${NC}"
  fi
fi

# 5. Create Service Launcher Script
LAUNCHER="${INSTALL_DIR}/start-server.sh"
cat > "${LAUNCHER}" << 'EOF'
#!/bin/bash
# Resolve symlinks: this script is usually invoked through the videocall-server link
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "$DIR"
# Node.js the installer downloaded for VideoCall (when the system's own was missing or too old)
if [ -x node/bin/node ]; then
  export PATH="$DIR/node/bin:$PATH"
fi
# Settings chosen at install time (HTTPS mode, domain, ports). The system service gets them from
# systemd instead (EnvironmentFile), since it runs as the unprivileged "videocall" user.
if [ -r server.env ]; then
  set -a
  . ./server.env
  set +a
fi
if [ "$1" = "update" ]; then
  # Download, verify and install the latest Talvora server release (keeps settings and data)
  exec node src/releases.js update
fi
if [ "$1" = "reset-password" ]; then
  # Write the config as the service's own user, so the running server can still read it
  if [ "$EUID" -eq 0 ] && id -u videocall >/dev/null 2>&1; then
    exec runuser -u videocall -- node src/resetAdminPassword.js
  fi
  exec node src/resetAdminPassword.js
fi
export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"
exec node src/index.js
EOF
chmod +x "${LAUNCHER}"

# Create convenient symlink in /usr/local/bin or ~/.local/bin
BIN_DIR="/usr/local/bin"
if [ "$EUID" -ne 0 ]; then
  BIN_DIR="${HOME}/.local/bin"
fi
mkdir -p "${BIN_DIR}"
ln -sf "${LAUNCHER}" "${BIN_DIR}/videocall-server"

# 6. Open the server's ports in this machine's firewall (before starting, so certificate checks get through)
if [ "$EUID" -eq 0 ]; then
  if [ "${TLS_MODE}" = "auto" ]; then WEB_PORTS="${HTTPS_PORT} ${HTTP_PORT}"; else WEB_PORTS="${PORT}"; fi
  OPENED="${WEB_PORTS// //}/tcp, 3478/udp and 49152-49452/udp"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in ${WEB_PORTS}; do ufw allow "${p}/tcp" >/dev/null; done
    ufw allow 3478/udp >/dev/null && ufw allow 49152:49452/udp >/dev/null
    echo -e "${GREEN}✓ Firewall (ufw): opened ${OPENED}${NC}"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for p in ${WEB_PORTS}; do firewall-cmd --permanent --add-port="${p}/tcp" >/dev/null; done
    firewall-cmd --permanent --add-port=3478/udp --add-port=49152-49452/udp >/dev/null
    firewall-cmd --reload >/dev/null
    echo -e "${GREEN}✓ Firewall (firewalld): opened ${OPENED}${NC}"
  elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)'; then
    # Plain iptables/nftables with a closed-by-default policy
    allow() { iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || iptables -I INPUT -p "$1" --dport "$2" -j ACCEPT; }
    for p in ${WEB_PORTS}; do allow tcp "$p"; done
    allow udp 3478; allow udp 49152:49452
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1
      echo -e "${GREEN}✓ Firewall (iptables): opened ${OPENED} (saved)${NC}"
    else
      echo -e "${GREEN}✓ Firewall (iptables): opened ${OPENED}${NC}"
      echo -e "${YELLOW}  These rules are lost on reboot unless saved (e.g. install iptables-persistent).${NC}"
    fi
  else
    echo -e "${GREEN}✓ Firewall: no active firewall blocks the server's ports${NC}"
  fi
fi

# 7. Systemd service configuration if running as root
if [ "$EUID" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  # The server runs as its own unprivileged user; it only gets the right to use ports 80 and 443
  if ! id -u videocall >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "${INSTALL_DIR}" --shell "$(command -v nologin || echo /bin/false)" videocall
  fi
  mkdir -p "${INSTALL_DIR}/data"
  chown -R videocall:videocall "${INSTALL_DIR}/data"
  chmod 700 "${INSTALL_DIR}/data"

  cat > /etc/systemd/system/videocall-server.service << EOF
[Unit]
Description=Video Call Relay Server & Management Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=videocall
Group=videocall
WorkingDirectory=${INSTALL_DIR}
ExecStart=${LAUNCHER}
EnvironmentFile=${ENV_FILE}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${INSTALL_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable videocall-server
  rm -f "${INSTALL_DIR}/data/connection-info.json"
  systemctl restart videocall-server
  echo -e "${GREEN}✓ Systemd service 'videocall-server' enabled and started.${NC}"
  echo "Waiting for the server to obtain its HTTPS certificate (up to 2 minutes)..."
  for _ in $(seq 1 120); do
    [ -f "${INSTALL_DIR}/data/connection-info.json" ] && break
    sleep 1
  done
else
  # User mode launcher
  echo -e "${GREEN}✓ Installed launcher binary to ${BIN_DIR}/videocall-server${NC}"
fi

echo -e "\n${GREEN}${BOLD}"
echo "========================================================================"
echo "          SERVER INSTALLATION COMPLETED SUCCESSFULLY!                  "
echo "========================================================================"
echo -e "${NC}"
INFO_FILE="${INSTALL_DIR}/data/connection-info.json"
if [ -f "${INFO_FILE}" ]; then
  info() { node -e "const d=require(process.argv[1]); const v=process.argv[2].split('.').reduce((o,k)=>o&&o[k],d); console.log(v==null?'':v)" "${INFO_FILE}" "$1"; }
  echo -e "${BOLD}IMPORTANT CREDENTIALS (SAVE THESE):${NC}"
  echo -e "------------------------------------------------------------------------"
  echo -e "${YELLOW}1. User Management Panel Address:${NC}"
  echo -e "   ${BOLD}$(info panelUrl)${NC}"
  echo ""
  echo -e "${YELLOW}2. Admin Application Login Link:${NC}"
  echo -e "   ${BOLD}$(info adminLink)${NC}"
  echo -e "------------------------------------------------------------------------"
  ISSUER="$(info certificate.issuedBy)"
  if [ "${ISSUER}" = "acme" ]; then
    echo -e "${BLUE}HTTPS:${NC}          Let's Encrypt certificate (valid until $(info certificate.validUntil); renewed automatically)"
  elif [ -n "${ISSUER}" ]; then
    echo -e "${BLUE}HTTPS:${NC}          the server's own certificate (renewed automatically). Invite links carry its"
    echo -e "                 fingerprint, so the VideoCall app trusts it. Browsers will show a warning."
    if [ -z "${DOMAIN}" ] && [ "$(info certificate.mode)" = "ip" ]; then
      echo -e "                 A Let's Encrypt IP certificate is being retried: check that port ${HTTP_PORT}/tcp is reachable."
    fi
  else
    echo -e "${YELLOW}HTTPS:${NC}          not ready yet; check the server log: journalctl -u videocall-server"
  fi
  echo -e "${BLUE}Panel password:${NC} chosen on your first visit to the panel address above"
  echo -e "                 (that link works once; forgot the password? run: videocall-server reset-password)"
else
  echo -e "${BOLD}Start the server with:${NC} videocall-server"
  echo -e "It prints the management panel address and the admin login link when it starts."
fi
echo -e "${BLUE}Server Directory:${NC} ${INSTALL_DIR}"
echo -e "${BLUE}Start Command:${NC}   videocall-server (or ${LAUNCHER})"
if [ -f "${INFO_FILE}" ]; then
  echo -e "${BLUE}Network ports:${NC}"
  node -e "
const n = require(process.argv[1]).network || {};
const states = { forwarded: 'open on the router (UPnP)', partial: 'partly open on the router', failed: 'router refused',
  manual: 'forward on your router to ' + n.localIp, direct: 'server is directly on the internet', disabled: 'this network only' };
for (const p of n.ports || []) console.log('                 ' + p.label.padEnd(17) + (states[p.state] || p.state) + (p.error ? ' (' + p.error + ')' : '') + '  - ' + p.purpose);
if (n.method === 'direct') console.log('                 If this is a cloud server, also allow these ports in its provider firewall / security group.');
" "${INFO_FILE}"
else
  echo -e "${BLUE}Network ports:${NC}   ${HTTPS_PORT}/tcp, ${HTTP_PORT}/tcp, 3478/udp, 49152-49452/udp"
fi
echo -e "========================================================================\n"
