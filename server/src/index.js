/**
 * Video Call Application — Linux Server Edition & Relay Backend
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const AuthService = require('./auth');
const RoomManager = require('./roomManager');
const TurnRelay = require('./turnServer');
const AdminSessions = require('./adminSession');
const CertManager = require('./certManager');
const PortAccess = require('./portAccess');
const { ReleaseWatcher, CURRENT_VERSION } = require('./releases');
let protocol;
try {
  protocol = require('../../shared/protocol');
} catch (e) {
  try {
    protocol = require('../shared/protocol');
  } catch (e2) {
    protocol = require('./shared/protocol');
  }
}
const {
  MessageType,
  ChatMode,
  Role
} = protocol;

const PORT = parseInt(process.env.PORT, 10) || 8080;
const PUBLIC_DIR = path.join(__dirname, '../public');
const CLIENT_DIR = [
  path.join(__dirname, '../../client/src'),
  path.join(__dirname, '../client/src')
].find(dir => fs.existsSync(dir)) || path.join(__dirname, '../../client/src');
const SHARED_DIR = [
  path.join(__dirname, '../../shared'),
  path.join(__dirname, '../shared')
].find(dir => fs.existsSync(dir)) || path.join(__dirname, '../../shared');
const MAX_WS_PAYLOAD = 25 * 1024 * 1024; // room for an uploaded music track as a data URL
const MAX_CHAT_LENGTH = 4000;
const PERMISSION_KEYS = ['can_audio', 'can_video', 'can_chat', 'can_play_music', 'can_invite'];

// HTTPS (TLS_MODE=auto, set by the installer): see certManager.js for how the certificate is chosen.
// Without it the server only listens on this computer (development and tests): invite tokens,
// chat, the panel password and the keys that encrypt calls never cross a network in plain text.
// ALLOW_INSECURE_HTTP=1 opts out explicitly.
const TLS_ENABLED = process.env.TLS_MODE === 'auto';
const LOCAL_ONLY = !TLS_ENABLED && process.env.ALLOW_INSECURE_HTTP !== '1';
const HOST = process.env.HOST || (LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0');
if (LOCAL_ONLY && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error(`Refusing to serve plain HTTP on ${HOST}: connections must be encrypted. ` +
    'Set TLS_MODE=auto (the installer does this), or ALLOW_INSECURE_HTTP=1 to accept unencrypted connections.');
  process.exit(1);
}

// Detect local network IP
function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        return config.address;
      }
    }
  }
  return 'localhost';
}

const networkIp = getNetworkIp();

// Initialize services
const authService = new AuthService();

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 443;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 80; // Let's Encrypt checks and redirects to HTTPS
const DATA_DIR = path.dirname(authService.configPath);
const LISTEN_PORT = TLS_ENABLED ? HTTPS_PORT : PORT;

// Ports people must reach. Behind a router (PORT_FORWARDING=auto, set by the installer) they are
// forwarded automatically via UPnP; see portAccess.js
const turnRelay = new TurnRelay();
const portAccess = new PortAccess({
  enabled: process.env.PORT_FORWARDING === 'auto' && !LOCAL_ONLY,
  ports: [
    ...(TLS_ENABLED
      ? [{ protocol: 'TCP', port: HTTPS_PORT, purpose: 'App & management panel (HTTPS)' },
        { protocol: 'TCP', port: HTTP_PORT, purpose: "Certificate checks & redirect to HTTPS" }]
      : [{ protocol: 'TCP', port: PORT, purpose: 'App & management panel' }]),
    ...(turnRelay.enabled ? [{ protocol: 'UDP', port: turnRelay.port, purpose: 'Media relay' }] : [])
  ],
  ranges: turnRelay.enabled ? [{ protocol: 'UDP', from: turnRelay.minPort, to: turnRelay.maxPort, purpose: 'Media relay channels' }] : []
});

let certManager = null; // created at start-up, once the public address is known
let publicBaseUrl = process.env.PUBLIC_URL || (TLS_ENABLED ? null : `http://${LOCAL_ONLY ? 'localhost' : networkIp}:${PORT}`);
const localBaseUrl = `${TLS_ENABLED ? 'https' : 'http'}://localhost:${LISTEN_PORT}`;

// PUBLIC_IP: an address, "auto" (the router's public IP once ports are forwarded) or empty (LAN only)
function choosePublicIp(network) {
  const setting = (process.env.PUBLIC_IP || '').trim();
  if (setting && setting !== 'auto') return setting;
  if (setting === 'auto' && network.publicIp) {
    const main = portAccess.report().ports.filter(p => !p.label.includes('-'));
    if (!network.behindRouter || main.every(p => p.state === 'forwarded')) return network.publicIp;
  }
  return null;
}

// With the server's own CA, invite links carry its fingerprint so the app knows whom to trust
authService.linkSuffix = () => {
  const pin = certManager?.pinnedFingerprint();
  return pin ? `&ca=${pin}` : '';
};

const roomManager = new RoomManager(authService.roomId);
const adminSessions = new AdminSessions({ secureCookie: TLS_ENABLED || String(publicBaseUrl).startsWith('https:') });
// New Talvora releases on GitHub, shown in the management panel (installed servers; RELEASE_CHECK=on elsewhere)
const releaseWatcher = new ReleaseWatcher();
const RELEASE_CHECK = process.env.RELEASE_CHECK ? process.env.RELEASE_CHECK === 'on' : !LOCAL_ONLY;
// A participant's relay credentials stop working the moment they leave or are removed
roomManager.onParticipantRemoved = user => turnRelay.revokeCredentials(user.id);

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};

// Simple HTTP request helper
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  // The management panel is same-origin, so its API never allows cross-origin reads
  const cors = res.adminApi ? {} : {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...cors,
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

// HTTP Server
const server = (TLS_ENABLED ? https : http).createServer(async (req, res) => {
  // Browsers that reached this server over HTTPS never fall back to plain HTTP for a year
  if (TLS_ENABLED) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    // The management panel API is same-origin only
    if (req.url.startsWith('/api/admin/')) {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // --- API Routes for Admin Management Panel ---

  if (pathname === '/api/health') {
    return sendJson(res, 200, { status: 'healthy', uptime: process.uptime() });
  }

  // --- Management panel login ---

  if (pathname.startsWith('/api/admin/')) {
    res.adminApi = true;
    // A password reset done with `videocall-server reset-password` applies immediately
    if (authService.syncFromDisk()) adminSessions.destroyAll();

    // Panel actions only come from the panel itself: JSON requests from this origin. Plain
    // HTML forms (and pages on other ports of this host, which count as "same-site") are refused.
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let sameOrigin = !req.headers.origin;
      try {
        sameOrigin = sameOrigin || new URL(req.headers.origin).host === req.headers.host;
      } catch (e) {
        // malformed Origin header
      }
      if (contentType !== 'application/json' || !sameOrigin) {
        return sendJson(res, 403, { error: 'Forbidden' });
      }
    }
  }

  // What the panel should show: first-time setup, the login form, or the dashboard
  if (pathname === '/api/admin/session') {
    const expiresAt = adminSessions.get(req);
    return sendJson(res, 200, {
      passwordSet: authService.hasAdminPassword(),
      authenticated: !!expiresAt,
      expiresAt
    });
  }

  if ((pathname === '/api/admin/setup' || pathname === '/api/admin/login') && req.method === 'POST') {
    const setup = pathname === '/api/admin/setup';
    const address = req.socket.remoteAddress;
    // Counted before the body is read, so parallel requests cannot dodge the lockout
    const refusal = adminSessions.beginAttempt(address);
    if (refusal) return sendJson(res, 429, { error: refusal });

    let outcome; // true / false once a secret was checked
    try {
      const body = await parseJsonBody(req);

      if (setup) {
        if (authService.hasAdminPassword()) {
          return sendJson(res, 409, { error: 'A password has already been set. Please sign in.' });
        }
        // Only the holder of the one-time panel link printed at install may choose the password
        outcome = authService.validateSetupToken(body.setupToken);
        if (!outcome) {
          return sendJson(res, 401, { error: 'This setup link is not valid. Open the management panel link printed when the server was installed.' });
        }
        const problem = AdminSessions.validateNewPassword(body.password, body.confirm);
        if (problem) return sendJson(res, 400, { error: problem });
        await authService.setAdminPassword(body.password);
      } else {
        if (!authService.hasAdminPassword()) {
          return sendJson(res, 409, { error: 'No password has been set yet.' });
        }
        outcome = await authService.verifyAdminPassword(body.password);
        if (!outcome) return sendJson(res, 401, { error: 'Incorrect password.' });
      }

      const session = adminSessions.create();
      return sendJson(res, 200, { success: true, expiresAt: session.expiresAt }, { 'Set-Cookie': session.cookie });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    } finally {
      adminSessions.finishAttempt(address, outcome);
    }
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    return sendJson(res, 200, { success: true }, { 'Set-Cookie': adminSessions.destroy(req) });
  }

  // Every other admin API needs a signed-in panel session
  if (pathname.startsWith('/api/admin/') && !adminSessions.get(req)) {
    return sendJson(res, 401, { error: 'Your session has ended. Please sign in again.' });
  }

  if (pathname === '/api/admin/info') {
    return sendJson(res, 200, {
      roomId: roomManager.roomId,
      participants: roomManager.getAllPublicUsers(),
      musicState: roomManager.getMusicSummary(),
      network: { ...portAccess.report(), publicBaseUrl },
      release: releaseWatcher.state,
      serverStats: {
        uptime: process.uptime(),
        totalUsers: roomManager.participants.size
      }
    });
  }

  if (pathname === '/api/admin/permissions' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);

      const permissions = {};
      for (const key of PERMISSION_KEYS) {
        if (body.permissions && typeof body.permissions[key] === 'boolean') {
          permissions[key] = body.permissions[key];
        }
      }

      const user = roomManager.getParticipant(body.userId);
      if (!user) {
        return sendJson(res, 404, { error: 'User not found in room' });
      }

      // Saved first, so a rejoin with the same link cannot win the permissions back
      authService.setPermissionOverrides(user.username, permissions);
      const updated = roomManager.updatePermissions(user.id, permissions);

      return sendJson(res, 200, { success: true, permissions: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/admin/kick' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);

      const kicked = roomManager.kickParticipant(body.userId, body.reason || 'Kicked by administrator');
      if (!kicked) {
        return sendJson(res, 404, { error: 'User not found' });
      }

      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Kick the user AND void every invite link issued to them so far
  if (pathname === '/api/admin/remove' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);

      const user = roomManager.getParticipant(body.userId);
      const username = user ? user.username : body.username;
      if (!username) {
        return sendJson(res, 404, { error: 'User not found' });
      }

      authService.revokeUser(username);
      if (user) {
        roomManager.kickParticipant(user.id, 'You have been removed from the room by the administrator.');
      }

      return sendJson(res, 200, { success: true, username });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Ask the router again to forward the server's ports
  if (pathname === '/api/admin/network/retry' && req.method === 'POST') {
    await portAccess.renew();
    return sendJson(res, 200, { success: true, network: { ...portAccess.report(), publicBaseUrl } });
  }

  if (pathname === '/api/admin/stop-music' && req.method === 'POST') {
    try {
      await parseJsonBody(req); // no fields, but a malformed body is still refused

      // Admin has override authority
      roomManager.resetMusic();

      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/admin/invite' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);

      const linkData = authService.generateInviteLink({
        baseUrl: publicBaseUrl,
        targetUsername: body.targetUsername,
        canInvite: !!body.canInvite
      });

      return sendJson(res, 200, { success: true, ...linkData });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // --- Static File Serving (Admin Panel & Client App) ---

  // Resolve a request path inside a root directory, refusing anything that escapes it
  const resolveIn = (root, relPath) => {
    const resolved = path.join(root, relPath);
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
  };

  let filePath;
  if (pathname === '/' || pathname === '/admin') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (pathname === '/join' || pathname === '/app') {
    filePath = path.join(CLIENT_DIR, 'index.html');
  } else if (pathname.startsWith('/client/')) {
    filePath = resolveIn(CLIENT_DIR, pathname.slice('/client/'.length));
  } else if (pathname.startsWith('/shared/')) {
    filePath = resolveIn(SHARED_DIR, pathname.slice('/shared/'.length));
  } else {
    // Check public first, then client/src
    filePath = resolveIn(PUBLIC_DIR, pathname);
    if (!filePath || !fs.existsSync(filePath)) {
      filePath = resolveIn(CLIENT_DIR, pathname);
    }
  }

  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    // Browsers re-check every file, so a server update never runs an old script with a new page
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// WebSocket Server for Signaling, Chat, Music & Media Relay
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });

let nextConnectionId = 1;

wss.on('connection', (ws, req) => {
  const connectionId = `conn_${Date.now()}_${nextConnectionId++}`;
  let currentUser = null;

  const handleMessage = rawData => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // 1. Authentication / Join Room
    if (msg.type === MessageType.AUTH) {
      if (currentUser) {
        ws.send(JSON.stringify({
          type: MessageType.AUTH_ERROR,
          code: 'ERR_ALREADY_AUTHENTICATED',
          message: 'This connection has already joined the room.'
        }));
        return;
      }

      const { username, token } = msg;

      // Validate join credentials
      const validation = authService.validateJoin({
        inputUsername: username,
        token
      });

      if (!validation.success) {
        ws.send(JSON.stringify({
          type: MessageType.AUTH_ERROR,
          code: validation.code,
          message: validation.message
        }));
        return;
      }

      // A link is bound to one user: a new login replaces any stale session for the same username
      const existing = roomManager.getParticipantByUsername(validation.user.username);
      if (existing) {
        roomManager.kickParticipant(existing.id, 'You joined the room from another device or window.');
      }

      // Valid credentials: join room
      currentUser = roomManager.addParticipant({
        id: connectionId,
        username: validation.user.username,
        role: validation.user.role,
        permissions: validation.user.permissions,
        ws
      });

      // Send auth success and current room snapshot to the joining user
      ws.send(JSON.stringify({
        type: MessageType.AUTH_SUCCESS,
        user: roomManager.getPublicUser(currentUser),
        roomState: {
          roomId: roomManager.roomId,
          participants: roomManager.getAllPublicUsers(),
          musicState: roomManager.getMusicStateForClient()
        },
        iceServers: turnRelay.getIceServers(req.headers.host, currentUser.id)
      }));
      return;
    }

    // Ignore frames still in flight on a socket that was kicked or replaced by a newer session
    if (currentUser && roomManager.getParticipant(currentUser.id)?.ws !== ws) return;

    // If not yet authenticated, ignore subsequent commands
    if (!currentUser) {
      ws.send(JSON.stringify({
        type: MessageType.AUTH_ERROR,
        code: 'ERR_UNAUTHORIZED',
        message: 'Must authenticate first.'
      }));
      return;
    }

    // 2. Generate Invite Link
    if (msg.type === MessageType.INVITE_GENERATE) {
      // Permission check: only admin or users with can_invite
      if (currentUser.role !== Role.ADMIN && !currentUser.permissions.can_invite) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Permission denied: you do not have permission to invite users.'
        }));
        return;
      }

      // Only the admin may bring back someone the admin removed
      if (currentUser.role !== Role.ADMIN && authService.isUsernameRevoked(String(msg.targetUsername || ''))) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'This user was removed by the administrator. Only the admin can invite them again.'
        }));
        return;
      }

      try {
        const linkData = authService.generateInviteLink({
          baseUrl: publicBaseUrl,
          targetUsername: String(msg.targetUsername || ''),
          canInvite: false
        });

        ws.send(JSON.stringify({
          type: MessageType.INVITE_GENERATED,
          ...linkData
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'error',
          message: err.message
        }));
      }
      return;
    }

    // 3. Chat Messaging (Public, Direct, Group)
    if (msg.type === MessageType.CHAT_SEND) {
      if (!currentUser.permissions.can_chat) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Your chat privileges have been revoked by the admin.'
        }));
        return;
      }

      const { mode, text } = msg;
      if (typeof text !== 'string' || !text.trim()) return;
      if (text.length > MAX_CHAT_LENGTH) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Message is too long (maximum ${MAX_CHAT_LENGTH} characters).`
        }));
        return;
      }
      if (![ChatMode.PUBLIC, ChatMode.DIRECT, ChatMode.GROUP].includes(mode)) return;
      const recipients = Array.isArray(msg.recipients)
        ? msg.recipients.filter(id => typeof id === 'string' && roomManager.getParticipant(id))
        : [];

      const chatPayload = {
        type: MessageType.CHAT_DELIVER,
        message: {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          senderId: currentUser.id,
          senderUsername: currentUser.username,
          mode,
          recipients,
          text: text.trim(),
          timestamp: Date.now()
        }
      };

      if (mode === ChatMode.PUBLIC) {
        // Broadcast to everyone in the room
        roomManager.broadcast(chatPayload);
      } else if (mode === ChatMode.DIRECT) {
        // Direct to target recipient and echo back to sender
        const targetId = recipients[0];
        if (targetId) {
          roomManager.sendTo(targetId, chatPayload);
          ws.send(JSON.stringify(chatPayload));
        }
      } else if (mode === ChatMode.GROUP) {
        // Deliver to all selected recipients and echo back to sender
        const recipientList = new Set(recipients);
        recipientList.add(currentUser.id);
        roomManager.sendToMultiple(Array.from(recipientList), chatPayload);
      }
      return;
    }

    // 4. Synchronized Music Playback
    if (msg.type === MessageType.MUSIC_ACTION) {
      const { action, trackInfo, time } = msg;

      if (action === 'play') {
        const res = roomManager.startMusic(currentUser.id, trackInfo);
        if (!res.success) {
          ws.send(JSON.stringify({
            type: MessageType.MUSIC_ERROR,
            message: res.message
          }));
        }
      } else if (action === 'stop') {
        const res = roomManager.stopMusic(currentUser.id);
        if (!res.success) {
          ws.send(JSON.stringify({
            type: MessageType.MUSIC_ERROR,
            message: res.message
          }));
        }
      } else if (action === 'pause' || action === 'seek') {
        const res = action === 'pause'
          ? roomManager.pauseMusic(currentUser.id)
          : roomManager.seekMusic(currentUser.id, time);
        if (!res.success) {
          ws.send(JSON.stringify({
            type: MessageType.MUSIC_ERROR,
            message: res.message
          }));
        }
      }
      return;
    }

    // 5. Media State Change (Mute / Unmute camera & mic)
    if (msg.type === MessageType.MEDIA_STATE_CHANGE) {
      const mediaState = {};
      for (const key of ['audio', 'video', 'screen']) {
        if (msg.mediaState && typeof msg.mediaState[key] === 'boolean') {
          mediaState[key] = msg.mediaState[key];
        }
      }
      roomManager.updateMediaState(currentUser.id, mediaState);
      return;
    }

    // 6. WebRTC Signaling Relay (Offer, Answer, ICE Candidates)
    if (msg.type === MessageType.SIGNAL) {
      const { targetPeerId, signal } = msg;
      if (typeof targetPeerId === 'string' && signal && typeof signal === 'object') {
        roomManager.sendTo(targetPeerId, {
          type: MessageType.SIGNAL,
          senderPeerId: currentUser.id,
          signal
        });
      }
      return;
    }
  };

  ws.on('message', rawData => {
    try {
      handleMessage(rawData);
    } catch (err) {
      console.error(`Error handling message from ${currentUser?.username || connectionId}:`, err);
    }
  });

  ws.on('close', () => {
    // The participant may already have been removed (kicked or replaced by a newer session)
    if (currentUser && roomManager.getParticipant(currentUser.id)?.ws === ws) {
      roomManager.removeParticipant(currentUser.id);
    }
  });

  ws.on('error', err => {
    console.error(`Socket error for ${currentUser?.username || connectionId}:`, err.message);
  });
});

// Plain-HTTP port in HTTPS mode: answers Let's Encrypt's challenges, sends everything else to HTTPS
const redirectServer = TLS_ENABLED
  ? http.createServer((req, res) => {
    const answer = certManager.challengeResponse(req.url.split('?')[0]);
    if (answer) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(answer);
    }
    res.writeHead(301, { Location: `${publicBaseUrl}${req.url}` });
    res.end();
  })
  : null;

// Addresses for the installer (and admins) to read once the certificate is ready
function writeConnectionInfo() {
  const creds = authService.getAdminCredentials(publicBaseUrl);
  const info = {
    publicBaseUrl,
    panelUrl: creds.panelUrl,
    adminLink: creds.adminLink,
    certificate: certManager?.current
      ? { mode: certManager.mode, issuedBy: certManager.current.issuedBy, validUntil: new Date(certManager.current.notAfter).toISOString() }
      : null,
    network: portAccess.report()
  };
  try {
    const infoPath = path.join(DATA_DIR, 'connection-info.json');
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
    fs.chmodSync(infoPath, 0o600);
  } catch (err) {
    console.warn(`Could not write connection-info.json: ${err.message}`);
  }
  return creds;
}

async function start() {
  const network = await portAccess.start();

  if (TLS_ENABLED) {
    certManager = new CertManager({
      dir: path.join(DATA_DIR, 'tls'),
      domain: process.env.DOMAIN || null,
      publicIp: choosePublicIp(network),
      email: process.env.ACME_EMAIL || null,
      directoryUrl: process.env.ACME_DIRECTORY || undefined,
      // Let's Encrypt checks port 80; elsewhere only if a router forwards port 80 here (ACME=on)
      allowAcme: HTTP_PORT === 80 || process.env.ACME === 'on'
    });
    publicBaseUrl = publicBaseUrl || `https://${certManager.host}${HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`}`;

    // Port 80 must be up before asking Let's Encrypt, which checks it
    redirectServer.on('error', err => console.warn(`HTTP port ${HTTP_PORT} unavailable (${err.message}); Let's Encrypt cannot verify this server.`));
    redirectServer.listen(HTTP_PORT, HOST);
    await certManager.ensure();
    server.setSecureContext({ key: certManager.current.key, cert: certManager.current.cert });
    // Renewed certificates are swapped in live: calls in progress are not interrupted
    certManager.startAutoRenew(cert => {
      try {
        server.setSecureContext({ key: cert.key, cert: cert.cert });
      } catch (err) {
        console.error(`HTTPS: could not switch to the renewed certificate: ${err.message}`);
      }
      writeConnectionInfo();
    });
  }

  server.listen(LISTEN_PORT, HOST, () => {
    turnRelay.start();
    if (RELEASE_CHECK) releaseWatcher.start();
    const creds = writeConnectionInfo();
    const certificate = certManager?.current
      ? `${certManager.current.issuedBy === 'acme' ? "Let's Encrypt" : "server's own CA"} (${certManager.mode}), valid until ${new Date(certManager.current.notAfter).toISOString()}, auto-renewed`
      : LOCAL_ONLY ? 'off (plain HTTP, reachable from this computer only)' : 'off (plain HTTP: NOT ENCRYPTED, ALLOW_INSECURE_HTTP=1)';

    console.log('\n' + '='.repeat(70));
    console.log('       VIDEO CALL APPLICATION — LINUX SERVER EDITION STARTED       ');
    console.log('='.repeat(70));
    console.log(` Version:                   Talvora server ${CURRENT_VERSION}${RELEASE_CHECK ? ' (checks GitHub for new releases)' : ''}`);
    console.log(` Status:                    ACTIVE & LISTENING on port ${LISTEN_PORT}`);
    console.log(` Local Base URL:            ${localBaseUrl}`);
    console.log(` Public Base URL:           ${publicBaseUrl}`);
    console.log(` HTTPS certificate:         ${certificate}`);
    console.log(` Media Relay (TURN):        ${turnRelay.enabled ? `UDP ${turnRelay.port} (+ relay ports ${turnRelay.minPort}-${turnRelay.maxPort}/udp)` : 'disabled'}`);
    const net = portAccess.status;
    console.log(` Ports:                     ${!net.behindRouter ? 'server is directly on the internet (check its firewall)'
      : net.method === 'upnp' ? `forwarded by router ${net.router} (UPnP)`
        : net.method === 'disabled' ? 'automatic router forwarding off' : `forward manually to ${net.localIp}: ${portAccess.describeNeeded()}`}`);
    console.log('-'.repeat(70));
    console.log(` 1. User Management Panel:   ${creds.panelUrl}`);
    console.log(`    ${authService.hasAdminPassword() ? 'Protected by your panel password' : 'First visit: you will be asked to choose a panel password'}`);
    console.log(` 2. Admin Application Link:  ${creds.adminLink}`);
    console.log('='.repeat(70) + '\n');
  });
}

server.on('close', () => {
  turnRelay.stop();
  releaseWatcher.stop();
  certManager?.stopAutoRenew();
  redirectServer?.close();
});

// Stopping the service removes the router forwards it created
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    portAccess.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
start().catch(err => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

module.exports = { server, authService, roomManager, adminSessions };
