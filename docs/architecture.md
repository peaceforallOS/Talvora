# System Architecture & Protocol Specification

## 1. Overview
The Video Call Application is a cross-platform (Windows & Linux) real-time voice, video, chat, and synchronized music collaboration system supported by a Linux-based relay server and an Admin Web Management Panel.

---

## 2. Cryptographic Token & Authentication Model

### 2.1 Problem Statement & Requirements
- When an admin sets up a server, an Admin Link and Management Panel URL are generated.
- When an admin (or a user with invite permissions) generates an invite link for a username (e.g., `Omid`), that link is strictly bound to `Omid`.
- If another user (e.g., `Ali`) attempts to join using `Omid`'s link, the server and client reject the join request with:
  > *"Username and link do not match"*

### 2.2 Token Format & Signature
Each join link contains a cryptographically signed payload using HMAC-SHA256 with the server's master secret `SERVER_ROOM_SECRET`:
```
Payload = {
  roomId: string,           // Unique room ID
  username: string,         // Canonical username (case-insensitive normalized)
  role: 'admin' | 'user',   // Role assigned to token
  canInvite: boolean,       // Default true for admin, false for user
  issuedAt: number,         // Unix timestamp (ms)
  nonce: string             // Random cryptographic salt
}
```

The token string is formatted as:
```
Token = Base64Url(JSON(Payload)) + "." + Base64Url(HMAC_SHA256(Payload, SERVER_ROOM_SECRET))
```

### 2.3 Invitation Link Structure
Join links follow a portable URL format accepted by both the desktop client and web interface:
```
http://<server-ip>:<port>/join?room=<roomId>&user=<username>&token=<token>
```
Or native URI scheme:
```
videocall://join?server=<server-address>&room=<roomId>&user=<username>&token=<token>
```

### 2.4 Verification Logic
```
function verifyJoinCredentials(inputUsername, tokenString):
  1. Split token into [payloadB64, signatureB64]
  2. Compute expectedSignature = HMAC_SHA256(payloadB64, SERVER_ROOM_SECRET)
  3. If timingSafeEqual(expectedSignature, signatureB64) is FALSE:
       Return ERROR("Invalid or tampered token.")
  4. Decode payload JSON
  5. If payload.username.trim().toLowerCase() != inputUsername.trim().toLowerCase():
       Return ERROR("Username and link do not match")
  6. If payload.issuedAt <= revokedUsers[username]:
       Return ERROR("ERR_LINK_REVOKED")
  7. Return SUCCESS(payload)
```

### 2.5 Management Panel Login
The panel is protected by an admin password (stored as a salted scrypt hash in
`server/data/server-config.json`, which is written with mode 0600).
- **First visit:** opening the one-time panel link printed at install time (`/admin?setup=…`) asks the
  admin to choose a password and enter it twice (`POST /api/admin/setup`). The setup token is separate
  from the admin's app link and is deleted once the password is set, so nobody else can claim the panel.
- **Sign in:** `POST /api/admin/login` sets an `HttpOnly; SameSite=Strict` session cookie with no expiry
  date, so it ends when the browser closes. The server also ends every session 3 hours after sign-in,
  and after 15 minutes with no panel open (browsers that restore their last session keep session
  cookies). After 5 wrong passwords a client (IPv4 address or IPv6 /64) is locked out, starting at
  1 minute and doubling up to 15 minutes. Admin POSTs must be same-origin JSON (CSRF protection).
- **Sign out:** `POST /api/admin/logout`. Panel sessions never affect the running server or the call.
- **Forgotten password:** `videocall-server reset-password` (or `npm run reset-password`) prints a new
  one-time setup link. It applies immediately; the running server picks it up without a restart.

### 2.6 Removing a User
The panel's **Kick** button only disconnects a user; their link keeps working. **Remove User**
(`POST /api/admin/remove { token, userId }`) disconnects them and records the removal time in
`revokedUsers` (persisted in `server/data/server-config.json`). Every link issued to that username
before the removal is rejected from then on; a new invite generated later works normally.
The admin cannot be removed.

---

## 3. Communication Protocols

All client-to-server and panel-to-server communications use WebSockets (`ws://` / `wss://`) for signaling, state synchronization, chat, and event management. Audio/video uses WebRTC. Peers connect directly when they can; otherwise media flows through the TURN relay built into the server (`server/src/turnServer.js`, UDP 3478 plus relay ports 49152-49452/udp; override with `TURN_PORT`, `TURN_MIN_PORT`, `TURN_MAX_PORT`, `TURN_EXTERNAL_IP`, or set `TURN_PORT=0` to disable). Each participant receives the relay address and their own credentials in `auth_success.iceServers`; the credentials and any relay allocations are revoked as soon as they leave, are kicked or are removed. The relay refuses unspecified, link-local and multicast peers, only relays to the server itself on relay ports, and caps allocations per participant.

### 2.7 HTTPS Certificates
Installed servers use HTTPS (`TLS_MODE=auto` in `server.env`; ports 443 and 80 when installed as root).
Encryption is mandatory: without `TLS_MODE=auto` the server only listens on `127.0.0.1` (development and tests) and refuses
any other `HOST` unless `ALLOW_INSECURE_HTTP=1` is set; HTTPS responses carry `Strict-Transport-Security`. The app
refuses `http://` join links except to `localhost`, and its main process cancels every plain `http://`/`ws://` request
that would leave the computer. The installer has no plain-HTTP option and switches older `TLS_MODE=off` settings to `auto`.
`server/src/certManager.js` chooses the certificate automatically:

| Situation | Certificate | Lifetime | Renewal |
|-----------|-------------|----------|---------|
| A domain name is set (`DOMAIN`) | Let's Encrypt | 90 days | automatic, ~30 days before expiry |
| No domain, public IPv4 on the server (or `PUBLIC_IP`) | Let's Encrypt IP certificate (`shortlived` profile) | ~6 days | automatic, ~2 days before expiry |
| Neither (home/office network behind a router) | The server's own CA (10-year CA, stored in `data/tls/`) | 30 days | automatic, ~10 days before expiry |

Let's Encrypt verifies the server over port 80 (http-01). If that fails, the server keeps HTTPS working
with its own CA and retries with growing intervals (1 hour up to 1 day). Renewed certificates are
swapped in without restarting, so calls continue. While the server's own CA is in use, every invite
link carries its SHA-256 fingerprint (`&ca=…`); the desktop app trusts a certificate the system does
not know only if it is valid for that address and signed by a CA with exactly that fingerprint.
Browsers show a warning for such certificates. Plain HTTP on port 80 redirects to HTTPS.

### 2.8 Ports and Reachability
| Port | Purpose |
|------|---------|
| 443/tcp (8443 without root) | App, sign-in, chat and management panel (HTTPS) |
| 80/tcp (8080 without root) | Let's Encrypt checks, redirect to HTTPS |
| 3478/udp, 49152-49452/udp | Audio/video relay (TURN) |

- **Server firewall:** the installer opens these in ufw, firewalld or plain iptables (before the service starts).
- **Router (NAT):** with `PORT_FORWARDING=auto` the server forwards the ports on the router itself via UPnP
  (`server/src/portAccess.js`), renews the forwards every 20 minutes and removes them when it stops.
  `PUBLIC_IP=auto` then uses the router's public address for links and a Let's Encrypt IP certificate.
  Without UPnP, the log, installer and panel list exactly which ports to forward to which address.
- **Admin panel:** "Network & ports" shows each port's state, with a Retry button.
- **Clients** only make outgoing connections. When joining fails (and in the background after joining),
  the app checks the server's web port and the media relay port (a STUN request to 3478/udp) and
  explains whether the server, the network or this computer blocks it. If this computer's firewall is
  the cause (Windows Firewall without a VideoCall rule, or ufw blocking outgoing traffic), it asks
  for permission and allows VideoCall through the system administrator prompt (`client/firewall.js`).

### 3.0 Recent Servers
After every successful join the client remembers the server, username, room and join link
(`client/src/serverHistory.js`, stored locally on the user's machine, newest first, up to 12 entries).
The join screen lists them with a reachability check (`GET /api/health`, 4 s timeout) that runs on
start-up and on demand ("Ping all" or the per-server ping button), and a Connect button that rejoins
with the saved link. Entries can be removed from the list.

### 3.1 Audio Processing
Microphone audio passes through a high-pass filter and RNNoise neural noise suppression
(`client/src/vendor/rnnoise`, AudioWorklet + WebAssembly) before being sent. The speaking
indicator uses the cleaned signal: RMS above -50 dBFS, held for 400 ms between words.

### 3.1 Signaling Message Schema

#### Client -> Server Messages
| Type | Payload | Description |
|------|---------|-------------|
| `auth` | `{ username, token, roomId, capabilities: ['music-light'] }` | Authenticates and joins the room. `music-light`: the client keeps a track's audio, so pause/resume/seek updates may omit it. |
| `invite_generate` | `{ targetUsername }` | Requests invite link generation for `targetUsername`. |
| `chat_message` | `{ mode: 'public'\|'direct'\|'group', recipients: [userId], text: string }` | Sends a message. |
| `music_action` | `{ action: 'play'\|'pause'\|'resume'\|'stop'\|'seek', trackInfo: {...}, time: number }` | Music player actions (`play` carries the song as an audio data URL). |
| `media_state` | `{ audio: boolean, video: boolean, screen: boolean }` | Reports client media mute/active state. |
| `webrtc_signal` | `{ targetPeerId, signal }` | ICE candidates & SDP offer/answer for media relay. |

#### Server -> Client Messages
| Type | Payload | Description |
|------|---------|-------------|
| `auth_success` | `{ user: {...}, roomState: { ..., features: ['music-resume', 'music-light'] }, iceServers: [...] }` | Emitted on valid join; `iceServers` includes the TURN relay; `features` lists what the server supports (absent on older servers). |
| `auth_error` | `{ code: 'ERR_CREDENTIAL_MISMATCH', message: string }` | Emitted when username and link mismatch. |
| `user_joined` | `{ user: {...} }` | Notifies that a new user entered. |
| `user_left` | `{ userId: string, reason: string }` | Notifies user departure or kick. |
| `permissions_updated`| `{ userId: string, permissions: {...} }` | Real-time push when admin toggles permissions. |
| `chat_message` | `{ id, senderId, senderName, mode, recipients, text, timestamp }` | Delivered chat message. |
| `music_state` | `{ isPlaying, playedBy: { id, username }, trackInfo: { title, artist, audioDataUrl? }, trackId, currentTime, startedAt, position }` | Synchronized music state; `position` is computed at send time. The audio is included for a new track, on join, and always for clients without `music-light`. |
| `music_error` | `{ message: string }` | e.g. "Another user is currently playing music." |
| `kick` | `{ reason: string }` | Force disconnection notice. |

---

## 4. Permission Model & Management Schema

Each user entity in the room state contains a `permissions` object:
```json
{
  "can_audio": true,
  "can_video": true,
  "can_chat": true,
  "can_play_music": true,
  "can_invite": false
}
```

- **Admin default**: All permissions `true`.
- **Regular user default**: `can_invite` is `false`, all media/chat permissions `true` unless revoked.
- **Admin Panel Control**: The admin can revoke or restore any permission live.
- When `can_audio` is set to `false`, server cuts the user's incoming audio relay and notifies client to mute input.
- When `can_video` is set to `false`, server cuts the video relay and notifies client to turn off camera.
- When `can_chat` is set to `false`, client disables the chat input box with a clear banner.
- When `can_invite` is set to `true` by Admin, the user's client automatically reveals the "Invite" button.

---

## 5. Synchronized Music Player State Machine

### Rules
1. Only one user can play music at any given time.
2. First-come, first-served: Whoever starts playing first acquires the exclusive playback lock.
3. Other users attempting to start music will be rejected with an alert informing them who is currently playing.
4. The active DJ can pause, resume, seek, stop, or replace their track; a paused track keeps the lock.
5. The **Admin** has global override authority to pause, resume, seek or stop any music, regardless of who started it.
6. Pause, resume and seek send a few bytes to current clients (`music-light`); the song itself goes out only
   with a new track and to people joining mid-song. Each listener sets their own music volume.

### Devices and volume (client)
- Settings switch microphone, camera and speaker during the call: the microphone changes only the source of the
  noise-suppression graph (peers keep the same track); the camera is swapped with `replaceTrack`; the speaker is
  applied with `setSinkId` to every voice (peer tiles) and the music. Choices are remembered (`localStorage`) and
  used when the devices open next time.
- Each participant's voice plays from their tile, so its volume (0-100%, mute) is per person and only for you,
  remembered by username. It stays on the media element on purpose: routing voices through Web Audio (to boost
  above 100%) would bypass Chromium's echo cancellation.

```
                  +--------------+
                  |     IDLE     |
                  +--------------+
                     |        ^
      User starts    |        | User stops OR
   (if can_play_music|        | Admin force-stops
    & no lock held)  |        |
                     v        |
                  +--------------+
                  |   PLAYING    | (Locked by User X)
                  +--------------+
                     |
       User Y attempts to play
                     |
                     v
             [Rejected with error]
```

---

### Prerequisites
- **Windows app:** none. `VideoCall-Setup.exe` is a wizard: only me (no administrator rights, default
  `%LOCALAPPDATA%\Programs\videocall-client`) or all users, install folder, desktop / Start menu shortcuts
  (`client/build/installer.nsh`), and "Run VideoCall" at the end. It carries Electron, its media codecs and Node.js;
  launches take well under a second.
  (The earlier portable build unpacked ~270 MB to %TEMP% on every launch, ~14 s each time.) Allowing VideoCall
  through Windows Firewall needs an administrator prompt, opened via PowerShell; `firewall.js` starts that
  PowerShell in advance once the firewall is found blocking, so the prompt appears immediately on "Allow".
- **Linux app:** Electron links against ~30 system libraries (NSS, ALSA, GTK, ...). Desktop installs have them;
  minimal ones may not, and then Electron cannot even load. The AppImage therefore starts through
  `client/build/linux-launcher.sh`: it lists missing libraries (`ldd`), maps them to packages for apt (incl.
  Ubuntu/Debian `t64` names), dnf/yum/zypper (by library name) or pacman, asks (terminal, zenity or kdialog),
  installs them as root (sudo or pkexec) and only then starts Electron. `VIDEOCALL_SKIP_PREREQS=1` skips the check.
- **Server:** `install-server.sh` needs Node.js 18+ with npm. If it is missing or older, the installer downloads
  the current Node.js LTS from nodejs.org (verified against `SHASUMS256.txt`) into `<install dir>/node`, which
  `start-server.sh` puts first on `PATH`; system packages are not changed. curl is installed first if neither curl
  nor wget exists.

### Server calculator
The join screen's "Planning a server?" opens a calculator (`client/src/serverSizing.js`, tested in
`client/test/serverSizing.test.js`). The user enters only the number of people per call; `estimateForUsers` assumes a
busy typical call (up to 6 cameras at 720p, one screen share, mixed home/office networks, occasional music) and shows
traffic per hour of calls. The underlying `estimateServer` takes all factors: cameras, video quality, screen sharing,
where people join from (share of connections that need the TURN relay: LAN 0%, homes 10%, mixed 20%, strict networks
40%), music use and song size, hours per month. Model: signaling CPU interpolated from `docs/load-test-report.md`; relayed media =
relay share x full-mesh streams (audio 0.05, video 0.5 / 1.5 / 2.5, screen 1.5 Mbit/s per stream), relay CPU from
packets per second (estimated 60k pps per core); everything on one core (single-threaded process), so at most 2 vCPU
is recommended; music sends each new song (base64) to every participant and buffers it once per
participant. Calls with more than ~26 people or more than 8 cameras are reported as not workable (mesh limit on the
participants' side) instead of being sized.

### Updates (GitHub releases)
New versions are published as releases of https://github.com/peaceforallOS/Talvora (public). Apps and servers
check the latest release; they trust it only if its manifest is signed with the release key.
- **Release:** give `client/package.json` and `server/package.json` the same new `version`; build the Windows
  installer on Windows, then the AppImage + server package on Linux/WSL. `package-deliverables.sh` puts all three
  into `dist/release/` and signs them with `scripts/sign-updates.js`: `manifest.json` (version; per system `win32`,
  `linux`, `server`: file, size, SHA-256) and `manifest.sig` (Ed25519). `GITHUB_TOKEN=… node scripts/publish-release.js`
  creates the release `vX.Y.Z` (as a draft until every file is uploaded). The private release key stays on the
  release machine (`~/.videocall/release-key.pem`, or `VIDEOCALL_RELEASE_KEY`); its public half is in
  `client/release-key.pub.pem` (app) and `shared/release-key.pub.pem` (server).
- **App:** `client/updater.js` (main process) checks the latest release 5 s after start and every 6 hours. It
  accepts it only with a valid signature, a strictly newer version and a file for this system, so neither GitHub nor
  a network in between can push other programs. The page shows "Talvora x.y.z is available — Install"; the main
  process downloads (with progress), checks size and SHA-256 and then: Windows runs the installer silently with
  `--updated --force-run` (same folder, install mode and shortcut choices; restarts the app), Linux replaces the
  running AppImage file and starts it again. Leftover downloaded installers are removed on the next start.
- **Server:** `server/src/releases.js` checks at start and every 6 hours (installed HTTPS servers; `RELEASE_CHECK=on`
  elsewhere). A newer signed server package appears as a banner in the management panel and once in the log, with
  the command `sudo videocall-server update`. That command downloads `videocall-server.tar.gz`, checks it against the
  signed manifest, unpacks it and runs its `install-server.sh`, which keeps settings, data and certificates and
  restarts the service. The server never replaces itself unattended (it runs as an unprivileged user).

## 6. Directory Structure
```
Video_Call_88/
├── client/                     # Desktop client (Electron)
│   ├── main.js                 # Electron main process (incl. own-CA certificate pinning)
│   ├── preload.js              # Bridge: CA fingerprint pinning and local firewall check
│   ├── firewall.js             # Checks/allows VideoCall in Windows Firewall or ufw
│   ├── updater.js              # Verifies and installs updates offered by the server
│   ├── release-key.pub.pem     # Public release key: updates must be signed with its private half
│   ├── linuxIntegration.js     # AppImage icon, menu entry and file icon on Linux
│   ├── icons/                  # App icon sizes (16-512 px)
│   ├── src/                    # UI: index.html, app.js, chat.js, clientCore.js, mediaEngine.js, serverHistory.js, serverSizing.js, style.css
│   │   └── vendor/rnnoise/     # RNNoise noise suppression worklet (MIT)
│   ├── build/                  # Build resources: app icons, afterPack.js and linux-launcher.sh (installs
│   │                           #   missing system libraries before the Linux app starts)
│   ├── test/                   # Client integration tests (npm test)
│   └── package.json
├── server/                     # Linux server edition & relay
│   ├── src/                    # index.js (HTTP(S) + WebSocket), auth.js, adminSession.js, certManager.js, portAccess.js, releases.js, roomManager.js, turnServer.js
│   ├── public/                 # Admin management panel
│   ├── stubs/                  # Empty stand-ins for log4js and js-yaml: node-turn lists them only for its own
│   │                           #   command-line starter, which the server never runs (see "overrides" in package.json)
│   ├── test/                   # Server tests (npm test)
│   ├── data/                   # Runtime config incl. the server secret (created on first start)
│   ├── install-server.sh       # Linux server installer
│   └── package.json
├── shared/
│   ├── protocol.js             # Token signing/verification & protocol constants
│   └── release-key.pub.pem     # Public release key the server checks releases with
├── docs/
│   ├── architecture.md         # This document
│   ├── RELEASING.md            # How new versions are built, signed and published (maintainers)
│   ├── extra.txt               # Extra features (spec instruction 8)
│   └── load-test-report.md     # Load test results (scripts/load-test.js)
├── scripts/
│   ├── package-deliverables.sh # Builds dist/: Linux app + server on Linux/WSL, Windows app on Windows
│   ├── sign-updates.js         # Release key creation and signed update manifests
│   ├── publish-release.js      # Publishes dist/release as a GitHub release
│   ├── load-test.js            # Simulated-user load test (results: docs/load-test-report.md)
│   └── test-e2e.js             # End-to-end verification suite
└── dist/                       # Built deliverables (regenerated by package-deliverables.sh)
    ├── windows/                # VideoCall-Setup.exe — per-user installer, no admin needed
    ├── linux/                  # VideoCall.AppImage — portable, double-click to run
    ├── server/                 # install-server.sh + server, shared and web client files
    └── release/                # all three + signed manifest, published with scripts/publish-release.js
```
