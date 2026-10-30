/**
 * Client Core Engine — Authentication, State Synchronization & Permission Enforcement
 */

class ClientCore {
  constructor(options = {}) {
    this.onAuthSuccess = options.onAuthSuccess || (() => {});
    this.onAuthError = options.onAuthError || (() => {});
    this.onUserJoined = options.onUserJoined || (() => {});
    this.onUserLeft = options.onUserLeft || (() => {});
    this.onRoomState = options.onRoomState || (() => {});
    this.onPermissionsUpdated = options.onPermissionsUpdated || (() => {});
    this.onChatMessage = options.onChatMessage || (() => {});
    this.onMusicState = options.onMusicState || (() => {});
    this.onMusicError = options.onMusicError || (() => {});
    this.onInviteGenerated = options.onInviteGenerated || (() => {});
    this.onKicked = options.onKicked || (() => {});
    this.onConnectionStatus = options.onConnectionStatus || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.onServerError = options.onServerError || (() => {});

    this.ws = null;
    this.currentUser = null;
    this.roomState = {
      roomId: null,
      participants: [],
      musicState: null
    };

    this.mediaEngine = options.mediaEngine || null;
  }

  /**
   * Parse user credentials and connect
   * Handles raw token or full join URL (e.g., http://host:port/join?room=...&user=...&token=...)
   */
  connect({ username, linkOrToken, serverUrl }) {
    if (!username || !username.trim()) {
      this.onAuthError({
        code: 'ERR_EMPTY_USERNAME',
        message: 'Please enter your username.'
      });
      return;
    }

    if (!linkOrToken || !linkOrToken.trim()) {
      this.onAuthError({
        code: 'ERR_EMPTY_LINK',
        message: 'Please enter your join link or invitation token.'
      });
      return;
    }

    const rawLink = linkOrToken.trim();
    let parsedToken = rawLink;
    let detectedServer = serverUrl;
    let detectedRoom = null;

    // Check if full join link was provided
    if (rawLink.includes('token=')) {
      try {
        const urlObj = new URL(rawLink);
        detectedServer = `${urlObj.protocol}//${urlObj.host}`;
        parsedToken = urlObj.searchParams.get('token') || rawLink;
        detectedRoom = urlObj.searchParams.get('room') || null;
      } catch (e) {
        // Match regex if URL parser fails
        const tokenMatch = rawLink.match(/token=([^&]+)/);
        if (tokenMatch) {
          try {
            parsedToken = decodeURIComponent(tokenMatch[1]);
          } catch (decodeErr) {
            parsedToken = tokenMatch[1];
          }
        }
        const hostMatch = rawLink.match(/https?:\/\/[^\/?#]+/);
        if (hostMatch) detectedServer = hostMatch[0];
      }
    }

    const host = detectedServer || window.location.origin;
    if (!/^https?:\/\//.test(host)) {
      // e.g. the desktop app loads from file:// and has no server of its own
      this.onAuthError({
        code: 'ERR_NO_SERVER',
        message: 'Please paste the full join link (it contains the server address), not just the token.'
      });
      return;
    }
    // Invite tokens, chat and the keys that encrypt calls only travel over HTTPS
    if (!ClientCore.isSecureServer(host)) {
      this.onAuthError({
        code: 'ERR_INSECURE_SERVER',
        message: 'This server does not use an encrypted (https://) connection, so Talvora will not connect to it. Ask the administrator for an https:// join link.'
      });
      return;
    }
    const wsProto = host.startsWith('https') ? 'wss:' : 'ws:';
    const wsHost = host.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}//${wsHost}`;

    this.onConnectionStatus('connecting');

    try {
      this.closeSocket();
      this.kicked = false;

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.onConnectionStatus('connected');
        // Authenticate with server
        this.send({
          type: 'auth',
          username: username.trim(),
          token: parsedToken,
          roomId: detectedRoom,
          // This client keeps a track's audio: pause/resume/seek updates may leave it out
          capabilities: ['music-light']
        });
      };

      ws.onmessage = event => {
        this.handleMessage(event.data);
      };

      ws.onclose = event => {
        const wasInRoom = !!this.currentUser;
        this.ws = null;
        this.currentUser = null;
        this.onConnectionStatus('disconnected');
        if (event.code === 4001) {
          this.notifyKicked(event.reason || 'Disconnected by administrator');
        } else if (wasInRoom) {
          this.onDisconnected({ reason: 'The connection to the server was lost.' });
        }
      };

      ws.onerror = () => {
        this.onConnectionStatus('error');
        if (!this.currentUser) {
          this.onAuthError({
            code: 'ERR_CONNECTION_FAILED',
            message: 'Unable to connect to relay server. Please check the server address.'
          });
        }
      };
    } catch (err) {
      this.onAuthError({
        code: 'ERR_SOCKET_INIT',
        message: err.message
      });
    }
  }

  // Control updates for the same track (pause, resume, seek) arrive without the song: keep the one we have
  static withKnownAudio(next, previous) {
    const audio = previous?.trackInfo?.audioDataUrl;
    if (!next?.trackInfo || next.trackInfo.audioDataUrl || !audio || !next.trackId || next.trackId !== previous.trackId) return next;
    return { ...next, trackInfo: { ...next.trackInfo, audioDataUrl: audio } };
  }

  supportsFeature(name) {
    return (this.roomState.features || []).includes(name);
  }

  // https:// servers, or plain http:// only to a server on this computer (development)
  static isSecureServer(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch (e) {
      return false;
    }
  }

  // Close the current socket without firing its handlers (used for intentional disconnects)
  closeSocket() {
    if (!this.ws) return;
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    this.ws.close();
    this.ws = null;
  }

  // The server sends a 'kicked' message and then closes with code 4001; report it once
  notifyKicked(reason) {
    if (this.kicked) return;
    this.kicked = true;
    this.onKicked({ reason });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      // 1. Auth Success
      case 'auth_success':
        this.currentUser = msg.user;
        this.roomState = {
          roomId: msg.roomState.roomId,
          participants: msg.roomState.participants || [],
          musicState: msg.roomState.musicState || null,
          features: Array.isArray(msg.roomState.features) ? msg.roomState.features : [] // empty on older servers
        };
        this.onAuthSuccess(this.currentUser, this.roomState);

        // Initiate WebRTC peer connections with existing participants
        if (this.mediaEngine) {
          // Includes the server's TURN relay for peers that cannot connect directly
          if (Array.isArray(msg.iceServers) && msg.iceServers.length) {
            this.mediaEngine.setIceServers(msg.iceServers);
          }
          for (const peer of this.roomState.participants) {
            if (peer.id !== this.currentUser.id) {
              this.mediaEngine.createPeerConnection(peer.id, true);
            }
          }
        }
        break;

      // 2. Auth Error (Credential Mismatch or Invalid Token)
      case 'auth_error':
        this.onAuthError({
          code: msg.code,
          message: msg.message || 'Authentication failed.'
        });
        this.closeSocket();
        break;

      // 3. User Joined
      case 'user_joined':
        if (msg.user && (!this.currentUser || msg.user.id !== this.currentUser.id)) {
          this.roomState.participants.push(msg.user);
          this.onUserJoined(msg.user);

          if (this.mediaEngine) {
            // New peer joined: await offer or create connection
            this.mediaEngine.createPeerConnection(msg.user.id, false);
          }
        }
        break;

      // 4. User Left
      case 'user_left':
        this.roomState.participants = this.roomState.participants.filter(u => u.id !== msg.userId);
        this.onUserLeft(msg.userId, msg.reason);
        if (this.mediaEngine) {
          this.mediaEngine.removePeer(msg.userId);
        }
        break;

      // 5. Room State / Permissions / Media Updates
      case 'room_state':
        if (msg.action === 'permissions_updated') {
          const target = this.roomState.participants.find(u => u.id === msg.userId);
          if (target) {
            target.permissions = msg.permissions;
            if (msg.mediaState) target.mediaState = msg.mediaState;
          }
        } else if (msg.action === 'media_state_change') {
          const target = this.roomState.participants.find(u => u.id === msg.userId);
          if (target) {
            target.mediaState = msg.mediaState;
          }
        }
        this.onRoomState(msg);
        break;

      // 6. Direct User Permissions Revoked / Granted
      case 'permissions_updated':
        if (this.currentUser && msg.userId === this.currentUser.id) {
          this.currentUser.permissions = msg.permissions;
          this.enforceClientPermissions(msg.permissions);
          this.onPermissionsUpdated(msg.permissions);
        }
        break;

      // 7. Chat Delivered
      case 'chat_deliver':
        this.onChatMessage(msg.message);
        break;

      // 8. Music State Sync
      case 'music_state':
        this.roomState.musicState = ClientCore.withKnownAudio(msg.musicState, this.roomState.musicState);
        this.onMusicState(this.roomState.musicState);
        break;

      case 'music_error':
        this.onMusicError(msg.message);
        break;

      // 9. Invite Generated
      case 'invite_generated':
        this.onInviteGenerated(msg);
        break;

      // 10. Kicked
      case 'kicked':
        this.notifyKicked(msg.reason || 'Removed by room administrator');
        break;

      case 'error':
        this.onServerError(msg.message || 'The server rejected the request.');
        break;

      // 11. WebRTC Signaling Relay
      case 'signal':
        if (this.mediaEngine && msg.senderPeerId && msg.signal) {
          this.mediaEngine.handleSignal(msg.senderPeerId, msg.signal);
        }
        break;

      default:
        break;
    }
  }

  /**
   * Enforce client-side behavior immediately when admin revokes permissions
   */
  enforceClientPermissions(permissions) {
    if (!this.mediaEngine) return;

    // Audio revoked -> forcefully mute microphone
    if (permissions.can_audio === false) {
      this.mediaEngine.setAudioEnabled(false);
      this.sendMediaState({ audio: false });
    }

    // Video revoked -> forcefully turn off camera
    if (permissions.can_video === false) {
      this.mediaEngine.setVideoEnabled(false);
      this.sendMediaState({ video: false });
    }
  }

  sendMediaState(state) {
    this.send({
      type: 'media_state_change',
      mediaState: state
    });
  }

  sendChatMessage({ mode, recipients, text }) {
    return this.send({
      type: 'chat_send',
      mode,
      recipients,
      text
    });
  }

  sendMusicAction({ action, trackInfo, time }) {
    return this.send({
      type: 'music_action',
      action,
      trackInfo,
      time
    });
  }

  requestInviteLink(targetUsername) {
    return this.send({
      type: 'invite_generate',
      targetUsername
    });
  }

  disconnect() {
    if (this.mediaEngine) {
      this.mediaEngine.destroy();
    }
    this.closeSocket();
    this.currentUser = null;
    this.roomState = { roomId: null, participants: [], musicState: null };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ClientCore;
}
