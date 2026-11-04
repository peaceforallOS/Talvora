# System Architecture & Protocol Specification

## 1. Overview
Talvora is a cross-platform (Windows & Linux) real-time voice, video and chat system supported by a Linux-based relay server and an Admin Web Management Panel.

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

### 2.7b The Stage
- The admin is always on stage; invited people join the audience (`onStage: false` in the participant state). The
  audience sees and hears the stage but sends nothing: the server keeps its announced audio, video and screen sharing
  off whatever its permissions, and its apps keep the microphone closed and the buttons disabled. On stage, the
  permissions apply as before (and nothing starts until the person turns it on).
- The admin brings someone up or back with `stage_set { userId, onStage }` (admins only; the admin cannot leave the
  stage), from a checkmark next to each name in the People list. Going back to the audience turns their media off.
- The audience raises a hand with `hand_raise { raised }`; the admin sees it at the top of the screen with an
  **Accept** button (`stage_set`), or dismisses it for themselves. Coming on stage lowers the hand.
- Both are broadcast as `room_state` (`stage_changed` with `onStage`, `handRaised`, `mediaState`;
  `hand_changed` with `handRaised`). Receivers hide audience tiles from the grid and mute them, so even an app
  from before 1.15.0 sending from the audience is not heard. Apps on a server without a stage (no `onStage`) treat
  everyone as on it. The stage is per session: rejoining starts in the audience again.

### 2.7a The Admin Opens the Room
- Invited users can only join while the admin is in the room; otherwise `auth_error` with code
  `ERR_ADMIN_ABSENT` ("The admin is not in the room yet. Please try again later.").
- When the admin leaves for any reason (Leave, closed app, lost connection, kicked from the panel), the others get a
  `room_notice` and stay for 10 seconds (`ADMIN_GRACE_MS`, `server/src/roomManager.js`). If the admin is back by then
  they stay (`room_notice` "The admin is back."); otherwise everyone is kicked with the reason "The admin left the room."
  The admin joining again from another window replaces the old session without starting the wait.
- The server pings every connection every 5 seconds and closes one that misses a round, so a sleeping laptop or a
  dropped network counts as leaving within about 10 seconds.
- The admin's app rejoins by itself when its connection is lost (not after Leave), retrying for 10 seconds.

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
  the cause (Windows Firewall without a Talvora rule, or ufw blocking outgoing traffic), it asks
  for permission and allows Talvora through the system administrator prompt (`client/firewall.js`).

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

**Shared sound** (always shared with the screen when the system offers it): the main process grants system
audio with the screen. On Windows it asks for `loopbackWithoutChrome` (Electron 45; Electron 33 ignored it): the
capture leaves out everything Talvora itself plays (the others' voices and shared sound), measured -49 -> -110 dB
with other programs' sound untouched, so the track needs no echo cancellation and stays stereo. Linux sound
systems cannot leave one program out (`loopbackWithoutChrome` captures it all there, -34 dB), so on Linux the
track keeps echo cancellation, which removes Talvora's playback (-34 -> -97 dB), and is mono. Noise suppression
and automatic gain are always off (speech processing damages music; echo cancellation does too, which is why
Windows now avoids it), and it never passes through RNNoise. It is its own track (`contentHint = 'music'`) on its
own sender per connection, reused across shares like the video slot. Our encoders follow the codec parameters in
the peer's description, so before applying a remote description (`MediaEngine.tuneRemoteSdp`) the shared-sound
m-line gets `stereo=1;sprop-stereo=1;maxaveragebitrate=128000;usedtx=0` and our voice m-lines `stereo=0` (mono);
our own descriptions say `stereo=1` on every audio m-line (`allowStereo`), without which the receiving decoder
mixes a peer's shared sound down to mono (measured). The shared sound's bitrate follows the screen level below
(`setParameters` maxBitrate, 48-128 kbit/s; verified to take effect at runtime). Each description we send names
that m-line (`screenAudioMid`), so the receiver plays it from a separate `<audio>` element on the tile (at that
person's volume, through the chosen speaker) and never counts it as their voice.

**Screen sharing quality** adapts to each connection (`MediaEngine.adaptScreenQuality`): capture at most
1920x1080 at 30 frames per second (`contentHint = 'detail'` for sharp text, `maxBitrate` 4 Mbit/s), then every
2 seconds WebRTC's bandwidth estimate (`availableOutgoingBitrate`) picks a level - 1080p from 3 Mbit/s, 720p from
1.8, 540p from 0.9, 360p from 0.45, else 270p - applied as `scaleResolutionDownBy`. Two low measurements step
straight down to the level that fits; three measurements 25% above the next level step up one. Measured with
motion on screen: Chromium keeps a shared screen at full resolution and drops the frame rate instead (1 Mbit/s:
1080p 8 fps, 540p 29 fps; 500 kbit/s: 360p 22 fps), which is what made screen sharing stutter on ordinary
connections. Over really throttled links (Linux `tc`) the levels settled at 540p for 1 Mbit/s and 360p for 500 kbit/s
within 6 s. VP8 in software is kept: Intel's hardware H.264 encoder dropped to 6 fps at 1 Mbit/s. Stopping the
share gives the camera its own settings back. `talvoraStats()` in the developer tools shows each connection's
codec, resolution, frame rate, bitrate and limits.
**Ducking** happens on the listener's side: while any participant speaks, every shared sound fades to 35% (about
-9 dB) within about 0.15 s and returns over about 0.5 s after they stop. Peers before 1.12.0 do not name the
m-line: they receive the shared sound as a second audio track of the person's stream.

### 3.1 Signaling Message Schema

#### Client -> Server Messages
| Type | Payload | Description |
|------|---------|-------------|
| `auth` | `{ username, token, roomId }` | Authenticates and joins the room. |
| `invite_generate` | `{ targetUsername }` | Requests invite link generation for `targetUsername`. |
| `chat_message` | `{ mode: 'public'\|'direct', recipients: [userId], text: string }` | Sends a message (direct: to the one recipient). |
| `media_state` | `{ audio: boolean, video: boolean, screen: boolean }` | Reports client media mute/active state. |
| `stage_set` | `{ userId: string, onStage: boolean }` | Admin only: bring someone on stage or back to the audience. |
| `hand_raise` | `{ raised: boolean }` | Audience: ask the admin to come on stage (or take it back). |
| `webrtc_signal` | `{ targetPeerId, signal }` | ICE candidates & SDP offer/answer for media relay. |

#### Server -> Client Messages
| Type | Payload | Description |
|------|---------|-------------|
| `auth_success` | `{ user: {...}, roomState: { roomId, participants }, iceServers: [...] }` | Emitted on valid join; `iceServers` includes the TURN relay. |
| `auth_error` | `{ code: 'ERR_CREDENTIAL_MISMATCH' \| 'ERR_ADMIN_ABSENT' \| ..., message: string }` | Emitted when joining is refused (e.g. username and link mismatch, or the admin is not in the room). |
| `user_joined` | `{ user: {...} }` | Notifies that a new user entered. |
| `user_left` | `{ userId: string, reason: string }` | Notifies user departure or kick. |
| `permissions_updated`| `{ userId: string, permissions: {...} }` | Real-time push when admin toggles permissions. |
| `chat_message` | `{ id, senderId, senderName, mode, recipients, text, timestamp }` | Delivered chat message. |
| `chat_history` | `{ messages: [...] }` | Sent right after `auth_success` on every join: the saved messages this person may see. Replaces what the client shows. |
| `chat_cleared` | `{}` | The admin cleared the chat history; clients empty their chat. |
| `kick` | `{ reason: string }` | Force disconnection notice. |
| `room_notice` | `{ message: string }` | Room news shown to everyone (the admin left / is back). |
| `room_state` `stage_changed` / `hand_changed` | `{ userId, onStage?, handRaised, mediaState? }` | Someone came on stage, went back to the audience, or raised / lowered a hand. |

#### Chat history
`server/src/chatHistory.js` appends every delivered message to `data/chat-history.jsonl` (mode 0600, one JSON message
per line, not encrypted; the installer and updater never touch `data/`). It keeps the newest 5,000 messages. On every
join the server sends `chat_history`: all public messages, plus direct messages this person sent or received, matched
by username because connection ids change per session. A newly invited person therefore sees earlier public messages,
and reusing a removed person's username gives access to that name's direct messages. The panel's **Clear chat history**
(`POST /api/admin/chat/clear`) deletes the file and sends `chat_cleared` to the room; the panel only sees the number of
messages, never their text.

---

## 4. Permission Model & Management Schema

Each user entity in the room state contains a `permissions` object (an invited user's defaults):
```json
{
  "can_audio": false,
  "can_video": false,
  "can_screen": false,
  "can_chat": true,
  "can_invite": false
}
```

- **Admin**: always every permission; the panel cannot change an admin's permissions (`403`), and saved changes never apply to admins.
- **Invited user default**: no voice, no video, no screen sharing, no inviting; chat on. The admin turns each on
  separately per user in the management panel; the choice is kept for that username across rejoins and restarts.
  (Before 1.10.0 the Video switch also allowed screen sharing: saved settings with video on keep screen sharing on.
  Apps on a server without `can_screen` follow `can_video` for screen sharing.)
- **Admin Panel Control**: The admin can grant or revoke any permission live.
- Being allowed never turns anything on: the microphone, camera and screen share stay off until the user clicks
  Unmute / Start Video / Share Screen.
- When `can_audio` is `false`, the server keeps the user's announced audio off and the client mutes its input.
- When `can_video` is `false`, the server keeps the announced video off and the client closes the camera.
- When `can_screen` is `false`, the server keeps the announced screen sharing off and the client stops any screen share.
- The management panel lists participants in two groups by `onStage`: **On stage** (the admin first) and **Audience**. It refreshes from `/api/admin/info` every 1.5 seconds, so people move as the admin brings them up.
- When `can_chat` is set to `false`, client disables the chat input box with a clear banner. Saved messages stay readable.
- When `can_invite` is set to `true` by Admin, the user's client automatically reveals the "Invite" button.

---

## 5. Devices and Volume (Client)
- Everyone joins muted with the camera off. With voice permission the microphone is opened on join (muted), so
  unmuting is instant and the settings' input meter works; without it nothing is opened, and the first Unmute after
  the admin allows voice opens it (`MediaEngine.startMicrophone`, one negotiation). Peers' speaking detection runs
  either way (`ensureAudioContext`). The camera is opened only while it is on (`MediaEngine.startCamera` / `stopCamera`):
  off releases the device and its capture, encoding and preview memory. Each connection keeps one video sender
  (`videoSenders`); the first video adds it (one negotiation), after that camera on/off and screen sharing only call
  `replaceTrack` (a track, or `null` for nothing). Peers show the avatar from the announced media state, so a sender
  without a track needs no extra signal.
- Graphics card, chosen automatically at start (`client/gpuDetect.js`, before the app is ready as Electron requires):
  - **Dedicated card** (NVIDIA; AMD Radeon RX/Pro or any AMD adapter not named "... Graphics"; Intel Arc A/B): the app
    draws and decodes video on the GPU and passes `force_high_performance_gpu`, so Chromium picks the high-performance
    adapter. Not on Windows laptops with both (built-in graphics next to the card): there the screen hangs on the
    built-in graphics and Windows' fast screen capture (Desktop Duplication) does not work from the dedicated card
    (Microsoft KB 3019314), which made screen sharing slow in 1.13.0; Windows keeps choosing the adapter there. On Linux laptops whose screen is driven by the other GPU it also sets PRIME render
    offload (`__NV_PRIME_RENDER_OFFLOAD`/`__GLX_VENDOR_LIBRARY_NAME`/`__VK_LAYER_NV_optimus` for the NVIDIA driver,
    `DRI_PRIME=1` for Mesa), unless the user set them.
  - **Integrated graphics only** (Intel, AMD Ryzen "... Graphics", Intel "Arc Graphics"): no GPU
    (`app.disableHardwareAcceleration()`), which saves memory.
  - Windows reads each adapter's `DriverDesc`, `MatchingDeviceId` (PCI vendor) and, for AMD, `qwMemorySize` from the
    display class in the registry (three `reg query /v` calls, about 0.1 s; a full `/s` dump takes over 3 s). Linux reads
    `/sys/class/drm/card*/device` (`vendor`, the bound `driver`, `mem_info_vram_total`, `boot_vga`). `VIDEOCALL_GPU=on|off`
    overrides it. The manual setting of 1.8-1.12 is gone (its `<userData>/display.json` is deleted).
  The GPU process alone held 100-210 MB; measured with the private working set of all processes, without it: join screen
  181 -> 64 MB, two-person call with cameras 311 -> 167 MB, four-person call 412 -> 255 MB, for some more CPU in big calls
  (four-person grid 12.6% -> 19.1% of an i3-1115G4, one video full screen 26% -> 24%). Also kept cheap: no background
  blur over live video (tile labels and buttons), a still join-screen background (a moving one forced the card's blur to
  redraw every frame: 25% CPU without the GPU), and the device-change listener exists only while the settings are open
  (otherwise Chromium keeps its video capture service, about 20 MB, running).
- Settings switch microphone, camera and speaker during the call: the microphone changes only the source of the
  noise-suppression graph (peers keep the same track); the camera is swapped with `replaceTrack`; the speaker is
  applied with `setSinkId` to every voice (peer tiles). Choices are remembered (`localStorage`) and
  used when the devices open next time.
- Each participant's voice plays from their tile, so its volume (0-100%, mute) is per person and only for you,
  remembered by username. It stays on the media element on purpose: routing voices through Web Audio (to boost
  above 100%) would bypass Chromium's echo cancellation.

---

### Prerequisites
- **Windows app:** none. `Talvora-Setup.exe` is a wizard: only me (no administrator rights, default
  `%LOCALAPPDATA%\Programs\Talvora`; an update keeps the folder of the version it replaces) or all users, install folder, desktop / Start menu shortcuts
  (`client/build/installer.nsh`), and "Run Talvora" at the end. It carries Electron, its media codecs and Node.js;
  launches take well under a second.
  (The earlier portable build unpacked ~270 MB to %TEMP% on every launch, ~14 s each time.) Allowing Talvora
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
busy typical call (up to 6 cameras at 720p, one screen share, mixed home/office networks) and shows
traffic per hour of calls. The underlying `estimateServer` takes all factors: cameras, video quality, screen sharing,
where people join from (share of connections that need the TURN relay: LAN 0%, homes 10%, mixed 20%, strict networks
40%), hours per month. Model: signaling CPU interpolated from `docs/load-test-report.md`; relayed media =
relay share x full-mesh streams (audio 0.05, video 0.5 / 1.5 / 2.5, screen 1.5 Mbit/s per stream), relay CPU from
packets per second (estimated 60k pps per core); everything on one core (single-threaded process), so at most 2 vCPU
is recommended. Calls with more than ~26 people or more than 8 cameras are reported as not workable (mesh limit on the
participants' side) instead of being sized.

### Updates (GitHub releases)
New versions are published as releases of https://github.com/peaceforallOS/Talvora (public). Apps and servers
check the latest release; they trust it only if its manifest is signed with the release key. They read the release
files directly (`releases/latest/download/manifest.json`, then the signature and package from `releases/download/vX.Y.Z/`
of the version that manifest names), never through GitHub's API, which allows only 60 requests an hour per internet
address and answers 403 once a shared address (an office, a cloud provider) has used them up.
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
- **Server:** `server/src/releases.js` checks at start, every hour and when the management panel is opened and the
  last check is over 10 minutes old (installed HTTPS servers; `RELEASE_CHECK=on` elsewhere); the panel shows the
  version, when it last checked or why the check failed, and a "Check now" button (`POST /api/admin/release/check`).
  A newer signed server package appears as a banner in the management panel and once in the log, with an
  **Update now** button and the command `sudo videocall-server update`. The button (`POST /api/admin/update`) cannot
  install anything itself, since the server runs as an unprivileged user: as the system service it writes
  `data/update-request`, which `videocall-server-update.path` (set up by the installer) turns into one run of the root
  `videocall-server-update.service` = `videocall-server update`; a server started by hand from an install it may
  write to runs that command itself (output in `update.log`). The updater records its progress in
  `data/update-status.json` (running / failed with the reason / done), which the panel shows; panel sign-ins are kept
  in `data/admin-sessions.json` (SHA-256 of the cookie only) so the restart does not sign the admin out. The command
  downloads `videocall-server.tar.gz`, checks it against the
  signed manifest, unpacks it and runs its `install-server.sh`, which keeps settings, data and certificates and
  restarts the server. The package carries the server's production dependencies (pure JavaScript, about 2 MB packed;
  `package-deliverables.sh` refuses compiled ones), so installing and updating never need the npm registry. The
  installer assembles the new version, dependencies included, in a staging folder next to the install (not inside it:
  Node would find the installed version's packages in a parent folder), checks the dependencies load, and only then
  swaps it in; any failure leaves the installed version and the running server untouched and says why. It then waits until `data/running.json` (written by the server once it listens) shows the new
  version and says so. The system service is restarted with systemd (only where systemd runs the machine; a server
  started by hand from the same folder, which would hold the ports, is stopped first). A server started by hand with
  `videocall-server` runs under the launcher's restart loop: the installer sends it SIGUSR2, it exits with code 75
  and the launcher starts the new version in the same terminal. One started by an older launcher (no loop) is
  stopped and started again in the background, logging to `server.log`. The server never replaces itself
  unattended (it runs as an unprivileged user).

## 6. Directory Structure
```
Video_Call_88/
├── client/                     # Desktop client (Electron)
│   ├── main.js                 # Electron main process (incl. own-CA certificate pinning)
│   ├── preload.js              # Bridge: CA fingerprint pinning and local firewall check
│   ├── firewall.js             # Checks/allows Talvora in Windows Firewall or ufw
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
│   ├── src/                    # index.js (HTTP(S) + WebSocket), auth.js, adminSession.js, certManager.js, chatHistory.js, portAccess.js, releases.js, roomManager.js, turnServer.js
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
    ├── windows/                # Talvora-Setup.exe — per-user installer, no admin needed
    ├── linux/                  # Talvora.AppImage — portable, double-click to run
    ├── server/                 # install-server.sh + server, shared and web client files
    └── release/                # all three + signed manifest, published with scripts/publish-release.js
```
