/**
 * Talvora — UI Coordinator & Event Handler
 */

(function () {
  // DOM Elements
  const screenJoin = document.getElementById('screen-join');
  const screenRoom = document.getElementById('screen-room');

  const inputUsername = document.getElementById('input-username');
  const inputLink = document.getElementById('input-link');
  const btnJoin = document.getElementById('btn-join');
  const joinErrorBox = document.getElementById('join-error-box');
  const joinErrorText = document.getElementById('join-error-text');
  const joinSpinner = document.getElementById('join-spinner');

  const roomNameDisplay = document.getElementById('room-name-display');
  const roleBadge = document.getElementById('role-badge');
  const headerUsername = document.getElementById('header-username');
  const headerUserAvatar = document.getElementById('header-user-avatar');

  const localVideo = document.getElementById('local-video');
  const localAvatarFallback = document.getElementById('local-avatar-fallback');
  const localFallbackLetter = document.getElementById('local-fallback-letter');
  const localUsernameTag = document.getElementById('local-username-tag');
  const localAudioIcon = document.getElementById('local-audio-icon');
  const localSpeakingRing = document.getElementById('local-speaking-ring');
  const localTile = document.getElementById('local-tile');
  const callTimer = document.getElementById('call-timer');
  const headerParticipantCount = document.getElementById('header-participant-count');
  const btnHeaderParticipants = document.getElementById('btn-header-participants');
  const videoGrid = document.getElementById('video-grid');

  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnShareScreen = document.getElementById('btn-share-screen');
  const btnToggleChatPanel = document.getElementById('btn-toggle-chat-panel');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnOpenInvite = document.getElementById('btn-open-invite');

  // Invite Modal
  const modalInvite = document.getElementById('modal-invite');
  const btnCancelInvite = document.getElementById('btn-cancel-invite');
  const btnSubmitInvite = document.getElementById('btn-submit-invite');
  const inviteTargetUsername = document.getElementById('invite-target-username');
  const modalInviteResult = document.getElementById('modal-invite-result');
  const inviteBoundName = document.getElementById('invite-bound-name');
  const inviteLinkOutput = document.getElementById('invite-link-output');
  const btnCopyInviteLink = document.getElementById('btn-copy-invite-link');
  const inviteError = document.getElementById('invite-error');

  // Leave confirmation (in-app: a native confirm() would leave text fields unable to take typing)
  const modalLeave = document.getElementById('modal-leave');
  const btnCancelLeave = document.getElementById('btn-cancel-leave');
  const btnConfirmLeave = document.getElementById('btn-confirm-leave');

  // Side Panel
  const sidePanel = document.getElementById('side-panel');
  const tabChat = document.getElementById('tab-chat');
  const tabUsers = document.getElementById('tab-users');
  const panelChat = document.getElementById('panel-chat');
  const panelUsers = document.getElementById('panel-users');
  const userCountBadge = document.getElementById('user-count-badge');
  const participantsList = document.getElementById('participants-list');
  const toastWrapper = document.getElementById('toast-wrapper');

  // State
  let mediaEngine = null;
  let clientCore = null;
  let chatController = null;
  // Everyone joins with the microphone muted and the camera off
  let isMicMuted = true;
  let isCamOff = true;
  let cameraStarting = false;
  let micStarting = false;
  let isScreenSharing = false;
  let callTimerInterval = null;

  // Saved settings this version uses; any other vc_ setting was left by an older version and is removed.
  // A new saved setting must be added here.
  const SAVED_SETTINGS = ['vc_network_dismissed', 'vc_peer_volume', 'vc_devices', 'vc_server_history', 'vc_share_sound'];
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('vc_') && !SAVED_SETTINGS.includes(key)) localStorage.removeItem(key);
    }
  } catch (e) {
    // storage unavailable: nothing to tidy
  }

  // Initialize Engines
  mediaEngine = new MediaEngine({
    onRemoteTrack: (peerId, stream, track) => {
      handleRemoteTrack(peerId, stream, track);
    },
    onAudioLevel: (level, speaking) => {
      localSpeakingRing.classList.toggle('hidden', !(speaking && !isMicMuted));
    },
    onPeerSpeaking: (peerId, speaking) => {
      const ring = document.querySelector(`#peer-tile-${CSS.escape(peerId)} .speaking-ring`);
      if (ring) ring.classList.toggle('hidden', !speaking);
      if (speaking) speakingPeers.add(peerId);
      else speakingPeers.delete(peerId);
    },
    onRemoteScreenAudio: (peerId, track) => {
      handleRemoteScreenAudio(peerId, track);
    },
    onSendSignal: (targetPeerId, signal) => {
      clientCore.send({
        type: 'signal',
        targetPeerId,
        signal
      });
    },
    onScreenShareEnded: () => {
      // The user stopped sharing from the browser/OS picker instead of our button
      setScreenShareUI(false);
      clientCore.sendMediaState({ screen: false });
    }
  });

  clientCore = new ClientCore({
    mediaEngine,
    onAuthSuccess: (user, roomState) => {
      rejoinUntil = 0;
      if (pendingJoin) {
        lastJoin = { ...pendingJoin, role: user.role };
        serverHistory.record({ ...pendingJoin, roomId: roomState.roomId });
        // In the background: is the audio/video port reachable, and does the firewall allow Talvora?
        const origin = ServerHistory.serverOf(pendingJoin.link);
        setTimeout(() => checkNetwork(origin), 1500);
        pendingJoin = null;
        renderServerHistory();
      }
      showRoomScreen(user, roomState);
    },
    onAuthError: err => {
      // Rejoining after a lost connection: the server may be back any moment
      if (rejoinUntil && ['ERR_CONNECTION_FAILED', 'ERR_SOCKET_INIT'].includes(err.code)) {
        joinSpinner.classList.remove('hidden');
        setTimeout(tryRejoin, 2000);
        return;
      }
      rejoinUntil = 0;
      showJoinError(err.message || 'Authentication error.');
      // Could not reach the server at all: find out which port is blocked, and where
      if (err.code === 'ERR_CONNECTION_FAILED' && pendingJoin) {
        checkNetwork(ServerHistory.serverOf(pendingJoin.link), { force: true });
      }
    },
    onUserJoined: user => {
      showToast(`${user.username} joined the room.`);
      updateParticipantsUI();
    },
    onUserLeft: (userId, reason) => {
      removePeerVideoTile(userId);
      updateParticipantsUI();
    },
    onRoomState: state => {
      updateParticipantsUI();
    },
    onPermissionsUpdated: perms => {
      applyPermissionsToUI(perms);
    },
    onChatMessage: msg => {
      chatController.receiveMessage(msg, clientCore.currentUser?.id);
    },
    onInviteGenerated: data => {
      inviteBoundName.textContent = data.username;
      inviteLinkOutput.value = data.joinLink;
      modalInviteResult.classList.remove('hidden');
      showToast(`Invite link generated for ${data.username}`);
    },
    onKicked: data => {
      rejoinUntil = 0;
      leaveRoom();
      showJoinError(`You have been disconnected from the room: ${data.reason}`);
    },
    onDisconnected: data => {
      leaveRoom();
      // The others are removed when the admin stays away: the admin's app rejoins by itself
      if (lastJoin?.role === 'admin') {
        rejoinUntil = Date.now() + ADMIN_REJOIN_MS;
        showToast('The connection to the server was lost. Reconnecting…', ADMIN_REJOIN_MS);
        tryRejoin();
        return;
      }
      showJoinError(data.reason);
    },
    onServerError: msg => {
      showToast(msg);
    },
    onNotice: msg => {
      showToast(msg, 9000);
    }
  });

  // Setup Chat Controller
  chatController = new ChatController({
    core: clientCore,
    container: document.getElementById('chat-messages'),
    input: document.getElementById('chat-input'),
    form: document.getElementById('chat-form'),
    modeSelect: document.getElementById('select-chat-mode'),
    recipientsBox: document.getElementById('chat-recipients-box'),
    recipientsList: document.getElementById('recipients-list'),
    unreadBadge: document.getElementById('chat-unread-badge'),
    revokedBanner: document.getElementById('chat-revoked-warning'),
    onNotice: msg => showToast(msg)
  });

  // Check URL parameters on load
  function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const u = params.get('user');
    const t = params.get('token');
    // The desktop app passes a join link given on its command line as ?link=...
    const link = params.get('link');
    if (u) inputUsername.value = u;
    if (t) inputLink.value = window.location.href;
    if (link) {
      inputLink.value = link;
      try {
        const linkUser = new URL(link).searchParams.get('user');
        if (linkUser && !u) inputUsername.value = linkUser;
      } catch (e) {
        // Not a URL: a bare token was passed
      }
    }
  }
  checkUrlParams();

  // --- Recent Servers ---
  const serverHistory = new ServerHistory();
  const historyCard = document.getElementById('server-history');
  const historyList = document.getElementById('server-history-list');
  const btnPingAll = document.getElementById('btn-ping-all');
  const pingResults = new Map(); // server -> { status: 'checking' | 'online' | 'offline', ms, reason }
  let pendingJoin = null; // { username, link } until the server accepts it
  // The admin's app rejoins by itself after a lost connection, within the time the server keeps the
  // others in the room (see RoomManager's ADMIN_GRACE_MS)
  const ADMIN_REJOIN_MS = 10 * 1000;
  let lastJoin = null; // { username, link, role } of the room we are in
  let rejoinUntil = 0; // while rejoining: when to give up

  function tryRejoin() {
    if (!lastJoin || !rejoinUntil || Date.now() > rejoinUntil) {
      rejoinUntil = 0;
      showJoinError('The connection to the server was lost.');
      return;
    }
    inputUsername.value = lastJoin.username;
    inputLink.value = lastJoin.link;
    btnJoin.disabled = false;
    btnJoin.click();
  }

  function timeAgo(timestamp) {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }

  function pingLabel(result) {
    if (!result) return { text: 'Not checked', title: 'Press Ping to check' };
    if (result.status === 'checking') return { text: 'Checking…', title: '' };
    if (result.status === 'online') return { text: `${result.ms} ms`, title: 'Online' };
    return { text: 'Offline', title: result.reason || 'Unreachable' };
  }

  function renderServerHistory() {
    const entries = serverHistory.list();
    historyCard.classList.toggle('hidden', entries.length === 0);
    historyList.innerHTML = '';
    for (const entry of entries) {
      const result = pingResults.get(entry.server);
      const label = pingLabel(result);
      const item = document.createElement('li');
      item.className = 'history-item';
      item.dataset.status = result ? result.status : 'unknown';
      item.innerHTML = `
        <span class="history-icon">${iconSvg('server')}<span class="history-dot"></span></span>
        <div class="history-main">
          <div class="history-title">
            <span class="history-server"></span>
            <span class="history-latency" title="${escapeHtml(label.title)}">${escapeHtml(label.text)}</span>
          </div>
          <span class="history-meta"></span>
        </div>
        <div class="history-actions">
          <button type="button" class="icon-btn history-ping" title="Ping this server" aria-label="Ping server">${iconSvg('activity')}</button>
          <button type="button" class="icon-btn icon-btn-danger history-remove" title="Remove from list" aria-label="Remove server">${iconSvg('x')}</button>
          <button type="button" class="btn btn-primary btn-sm history-connect">${iconSvg('log-in')}Connect</button>
        </div>
      `;
      item.querySelector('.history-server').textContent = entry.server.replace(/^https?:\/\//, '');
      item.querySelector('.history-meta').textContent =
        `as ${entry.username}${entry.roomId ? ` · ${entry.roomId}` : ''} · ${timeAgo(entry.lastConnected)}`;
      item.querySelector('.history-ping').addEventListener('click', () => pingServers([entry]));
      item.querySelector('.history-remove').addEventListener('click', () => {
        serverHistory.remove(entry);
        renderServerHistory();
      });
      item.querySelector('.history-connect').addEventListener('click', () => {
        inputUsername.value = entry.username;
        inputLink.value = entry.link;
        btnJoin.click();
      });
      historyList.appendChild(item);
    }
  }

  // Servers without a public certificate use their own CA, named by the "ca" fingerprint in their
  // invite links; the desktop app trusts such a server only after it is told the fingerprint
  // Returns 'conflict' when this session already trusts a different CA for that server
  async function trustLinkCertificate(link) {
    try {
      const url = new URL(link);
      const fingerprint = url.searchParams.get('ca');
      if (fingerprint && window.videocallNative) {
        return await window.videocallNative.trustServerCertificate(url.origin, fingerprint);
      }
    } catch (e) {
      // a bare token, or running in a browser
    }
    return null;
  }

  async function pingServers(entries) {
    // Newest entries first: for a server whose CA changed, the most recent link is the one trusted
    for (const entry of entries) await trustLinkCertificate(entry.link);
    const servers = entries.map(entry => entry.server);
    const unique = [...new Set(servers)].filter(server => pingResults.get(server)?.status !== 'checking');
    unique.forEach(server => pingResults.set(server, { status: 'checking' }));
    renderServerHistory();
    await Promise.all(unique.map(async server => {
      const result = await ServerHistory.ping(server);
      pingResults.set(server, result.online ? { status: 'online', ms: result.ms } : { status: 'offline', reason: result.reason });
      renderServerHistory();
    }));
  }

  btnPingAll.addEventListener('click', () => pingServers(serverHistory.list()));

  renderServerHistory();
  pingServers(serverHistory.list());

  // --- Network access: can this computer reach the server's ports? ---
  const modalNetwork = document.getElementById('modal-network');
  const networkAdvice = document.getElementById('network-advice');
  const networkChecks = document.getElementById('network-checks');
  const btnNetworkAllow = document.getElementById('btn-network-allow');
  const btnNetworkLater = document.getElementById('btn-network-later');
  const NETWORK_DISMISSED_KEY = 'vc_network_dismissed'; // servers whose firewall suggestion was declined
  let networkPrompt = null; // { origin, fixable } shown in the dialog

  function dismissedServers() {
    try {
      return JSON.parse(localStorage.getItem(NETWORK_DISMISSED_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function renderNetworkChecks(origin, result) {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const rows = [
      ['App & sign-in', `${port}/tcp`, result.web.ok ? 'ok' : 'bad', result.web.ok ? 'reachable' : result.web.reason],
      ['Audio & video relay', '3478/udp',
        result.media.ok === true ? 'ok' : result.media.ok === false ? 'bad' : 'warn',
        result.media.ok === true ? 'reachable' : result.media.reason]
    ];
    if (result.firewall?.firewall) {
      rows.push(["This computer's firewall", result.firewall.firewall, result.firewall.blocking ? 'warn' : 'ok',
        result.firewall.blocking ? 'does not allow Talvora yet' : 'allows Talvora']);
    }
    networkChecks.innerHTML = rows.map(([label, detail, state, status]) => `
      <li class="network-check" data-state="${state}">
        <span class="network-check-dot"></span>
        <span class="network-check-label">${escapeHtml(label)} <span class="network-check-detail">(${escapeHtml(detail)})</span></span>
        <span class="network-check-detail">${escapeHtml(status)}</span>
      </li>`).join('');
  }

  // Checks the server's ports; shows the dialog when something is blocked. `force` also shows a
  // firewall suggestion the user declined before (used after a failed connection).
  async function checkNetwork(origin, { force = false } = {}) {
    if (!origin) return true;
    const result = await ConnectionCheck.run(origin);
    const explanation = ConnectionCheck.explain(origin, result);
    if (explanation.ok) return true;
    if (!force && !explanation.problems.length && dismissedServers().includes(origin)) return false;
    networkPrompt = { origin, fixable: explanation.fixable };
    networkAdvice.textContent = explanation.advice;
    renderNetworkChecks(origin, result);
    const canAllow = explanation.fixable && !!window.videocallNative?.firewallAllow;
    btnNetworkAllow.classList.toggle('hidden', !canAllow);
    btnNetworkLater.textContent = canAllow ? 'Not now' : 'Close';
    modalNetwork.classList.remove('hidden');
    return false;
  }

  btnNetworkLater.addEventListener('click', () => {
    modalNetwork.classList.add('hidden');
    if (networkPrompt?.fixable) {
      try {
        localStorage.setItem(NETWORK_DISMISSED_KEY, JSON.stringify([...new Set([...dismissedServers(), networkPrompt.origin])]));
      } catch (e) {
        // only means the suggestion may come back
      }
    }
  });

  btnNetworkAllow.addEventListener('click', async () => {
    if (!networkPrompt) return;
    btnNetworkAllow.disabled = true;
    try {
      const allowed = await window.videocallNative.firewallAllow(networkPrompt.origin);
      if (allowed) {
        modalNetwork.classList.add('hidden');
        showToast('Talvora is now allowed through the firewall.');
        checkNetwork(networkPrompt.origin, { force: true });
      } else {
        showToast('Permission was not given, so nothing was changed.');
      }
    } finally {
      btnNetworkAllow.disabled = false;
    }
  });

  // --- Updates from the project's GitHub releases (desktop app only). updater.js in the main process
  // checks the release signature and the version and downloads and verifies the file; this shows it.
  const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const updateCard = document.getElementById('update-card');
  const updateTitle = document.getElementById('update-title');
  const updateStatus = document.getElementById('update-status');
  const updateProgress = document.getElementById('update-progress');
  const updateProgressFill = document.getElementById('update-progress-fill');
  const btnUpdateInstall = document.getElementById('btn-update-install');
  const btnUpdateLater = document.getElementById('btn-update-later');
  let offeredVersion = null;
  let installingUpdate = false;

  async function checkForUpdate() {
    if (!window.videocallNative?.updateCheck || installingUpdate) return;
    const update = await window.videocallNative.updateCheck().catch(() => null);
    // Offer each version once per run; "Later" hides it until a newer one appears
    if (!update || update.version === offeredVersion) return;
    offeredVersion = update.version;
    updateTitle.textContent = `Talvora ${update.version} is available`;
    updateStatus.textContent = `Install it now (${Math.max(1, Math.round(update.size / 1048576))} MB); Talvora restarts by itself.`;
    btnUpdateInstall.textContent = 'Install';
    updateCard.classList.remove('hidden');
  }

  if (window.videocallNative?.updateCheck) {
    window.videocallNative.onUpdateProgress(fraction => {
      updateProgressFill.style.width = `${Math.round(fraction * 100)}%`;
      updateStatus.textContent = `Downloading… ${Math.round(fraction * 100)}%`;
    });
    setTimeout(checkForUpdate, 5000);
    setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  }

  btnUpdateInstall.addEventListener('click', async () => {
    installingUpdate = true;
    btnUpdateInstall.disabled = true;
    btnUpdateLater.disabled = true;
    updateProgress.classList.remove('hidden');
    updateStatus.textContent = 'Downloading…';
    try {
      const result = await window.videocallNative.updateInstall();
      if (!result.ok) throw new Error(result.error);
      updateStatus.textContent = 'Installing… Talvora will close and start again.';
    } catch (e) {
      installingUpdate = false;
      updateStatus.textContent = `The update could not be installed: ${e.message}`;
      updateProgress.classList.add('hidden');
      btnUpdateInstall.textContent = 'Try again';
      btnUpdateInstall.disabled = false;
      btnUpdateLater.disabled = false;
    }
  });

  btnUpdateLater.addEventListener('click', () => {
    updateCard.classList.add('hidden');
  });

  // --- Join Flow ---
  btnJoin.addEventListener('click', async () => {
    const username = inputUsername.value.trim();
    const link = inputLink.value.trim();

    if (!username) {
      showJoinError('Please enter your username.');
      return;
    }
    if (!link) {
      showJoinError('Please enter your join link or invitation token.');
      return;
    }

    joinErrorBox.classList.add('hidden');
    joinSpinner.classList.remove('hidden');
    btnJoin.disabled = true;
    pendingJoin = { username, link };
    if (await trustLinkCertificate(link) === 'conflict') {
      pendingJoin = null;
      showJoinError("This link names a different security certificate for this server than the one already in use. " +
        'Only use links from your admin. If the server was reinstalled, restart the app and use the new link.');
      return;
    }

    clientCore.connect({
      username,
      linkOrToken: link,
      serverUrl: window.location.origin
    });
  });

  function showJoinError(msg) {
    joinErrorText.textContent = msg;
    joinErrorBox.classList.remove('hidden');
    joinSpinner.classList.add('hidden');
    btnJoin.disabled = false;
  }

  async function showRoomScreen(user, roomState) {
    screenJoin.classList.add('hidden');
    screenRoom.classList.remove('hidden');

    roomNameDisplay.textContent = roomState.roomId || 'Talvora Room';
    roleBadge.textContent = String(user.role).toUpperCase();
    headerUsername.textContent = user.username;
    headerUserAvatar.textContent = user.username.charAt(0).toUpperCase();
    setAvatarHue(headerUserAvatar, user.username);

    localUsernameTag.textContent = user.username;
    localFallbackLetter.textContent = user.username.charAt(0).toUpperCase();
    setAvatarHue(localAvatarFallback, user.username);
    startCallTimer();
    // On narrow screens the panel overlays the video, so start with it closed
    setSidePanelOpen(!window.matchMedia('(max-width: 860px)').matches);

    // Join muted, with the camera off: the user turns them on
    setMicMutedUI(true);
    setCamOffUI(true);
    applyPermissionsToUI(user.permissions);
    updateParticipantsUI();

    // Open the microphone (muted, so unmuting is instant) only with voice permission; otherwise it
    // opens on the first unmute once the admin allows it. The camera opens only when turned on.
    try {
      const stream = await mediaEngine.initLocalMedia({ audio: user.permissions?.can_audio !== false });
      if (!stream || !clientCore.currentUser) return; // left or got disconnected while waiting for devices
      localVideo.srcObject = stream;

      // Respect a mute toggled while the microphone was being opened
      mediaEngine.setAudioEnabled(!isMicMuted);
      const hasAudio = stream.getAudioTracks().length > 0;
      clientCore.sendMediaState({ audio: hasAudio && !isMicMuted, video: mediaEngine.cameraOn && !isCamOff });
    } catch (e) {
      console.warn('Media capture warning:', e);
      localAvatarFallback.classList.remove('hidden');
    }
  }

  function applyPermissionsToUI(perms) {
    if (!perms) return;

    // Audio permission
    if (perms.can_audio === false) {
      btnToggleMic.classList.add('disabled');
      btnToggleMic.disabled = true;
      btnToggleMic.title = 'Audio disabled by room administrator';
      setMicMutedUI(true);
    } else {
      btnToggleMic.classList.remove('disabled');
      btnToggleMic.disabled = false;
      btnToggleMic.title = 'Toggle Microphone';
    }

    // Video permission
    if (perms.can_video === false) {
      btnToggleCam.classList.add('disabled');
      btnToggleCam.disabled = true;
      btnToggleCam.title = 'Video disabled by room administrator';
      setCamOffUI(true);
    } else {
      btnToggleCam.classList.remove('disabled');
      btnToggleCam.disabled = false;
      btnToggleCam.title = 'Toggle Camera';
    }

    // Screen sharing: its own permission (servers before 1.10.0 tie it to video)
    if ((perms.can_screen ?? perms.can_video) === false) {
      if (isScreenSharing) {
        mediaEngine.stopScreenShare();
        setScreenShareUI(false);
        clientCore.sendMediaState({ screen: false });
      }
      btnShareScreen.classList.add('disabled');
      btnShareScreen.disabled = true;
      btnShareScreen.title = 'Screen sharing disabled by room administrator';
    } else {
      btnShareScreen.classList.remove('disabled');
      btnShareScreen.disabled = false;
      btnShareScreen.title = 'Share screen';
    }

    // Invite permission: visible if admin or granted
    if (clientCore.currentUser?.role === 'admin' || perms.can_invite) {
      btnOpenInvite.classList.remove('hidden');
    } else {
      btnOpenInvite.classList.add('hidden');
    }

    // Chat permission
    chatController.setChatPermission(perms.can_chat !== false);
  }

  // --- Remote Video Feeds ---
  // Every participant gets a tile; it shows their avatar until video arrives
  function ensurePeerTile(peerId) {
    let tile = document.getElementById(`peer-tile-${peerId}`);
    if (tile) return tile;

    const peer = clientCore.roomState.participants.find(u => u.id === peerId);
    const username = peer ? peer.username : 'Participant';

    tile = document.createElement('div');
    tile.id = `peer-tile-${peerId}`;
    tile.className = 'video-tile peer-tile';
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="avatar-fallback">
        <span>${escapeHtml(username.charAt(0).toUpperCase())}</span>
      </div>
      <div class="speaking-ring hidden"></div>
      <button type="button" class="tile-fullscreen" title="Full screen (double-click)" aria-label="Show ${escapeHtml(username)} full screen">${iconSvg('maximize')}</button>
      <div class="tile-volume" title="How loud ${escapeHtml(username)} is for you (only you)">
        <button type="button" class="tile-volume-btn" aria-label="Mute ${escapeHtml(username)} for me">${iconSvg('volume')}</button>
        <input type="range" class="tile-volume-slider" min="0" max="100" step="5" aria-label="Volume of ${escapeHtml(username)}">
        <span class="tile-volume-value"></span>
      </div>
      <div class="tile-overlay">
        <span class="tile-username">${escapeHtml(username)}</span>
        <span class="status-icon">${iconSvg('mic')}</span>
      </div>
    `;
    setAvatarHue(tile.querySelector('.avatar-fallback'), username);
    setupTileVolume(tile, username);
    tile.querySelector('.tile-fullscreen').addEventListener('click', () => toggleTileFullscreen(tile));
    tile.addEventListener('dblclick', e => {
      if (!e.target.closest('.tile-volume')) toggleTileFullscreen(tile);
    });
    applySpeaker(tile.querySelector('video'));
    videoGrid.appendChild(tile);
    updateGridLayout();
    return tile;
  }

  // --- Full screen: a participant's tile (their camera or shared screen) fills the screen; Esc exits
  function toggleTileFullscreen(tile) {
    if (document.fullscreenElement === tile) {
      document.exitFullscreen().catch(() => {});
    } else {
      tile.requestFullscreen().catch(e => showToast(`Full screen is not available: ${e.message}`));
    }
  }

  document.addEventListener('fullscreenchange', () => {
    videoGrid.querySelectorAll('.peer-tile').forEach(tile => {
      const full = document.fullscreenElement === tile;
      const button = tile.querySelector('.tile-fullscreen');
      button.innerHTML = iconSvg(full ? 'minimize' : 'maximize');
      button.title = full ? 'Exit full screen (Esc)' : 'Full screen (double-click)';
    });
  });

  // --- Per-person volume: each voice plays from that person's tile, so its volume is theirs alone.
  // (Kept at 0-100% on the media element: routing voices through Web Audio to go louder would
  // bypass the browser's echo cancellation and make everyone hear themselves.)
  const PEER_VOLUME_KEY = 'vc_peer_volume';
  function savedPeerVolumes() {
    try {
      return JSON.parse(localStorage.getItem(PEER_VOLUME_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function setupTileVolume(tile, username) {
    const video = tile.querySelector('video');
    const slider = tile.querySelector('.tile-volume-slider');
    const button = tile.querySelector('.tile-volume-btn');
    const value = tile.querySelector('.tile-volume-value');
    const key = username.toLowerCase();
    let beforeMute = 100;

    const show = (percent, save) => {
      video.volume = percent / 100;
      applyScreenAudioVolume(tile);
      slider.value = String(percent);
      value.textContent = `${percent}%`;
      button.innerHTML = iconSvg(percent === 0 ? 'volume-off' : 'volume');
      tile.classList.toggle('is-muted-for-me', percent === 0);
      if (save) {
        try {
          localStorage.setItem(PEER_VOLUME_KEY, JSON.stringify({ ...savedPeerVolumes(), [key]: percent }));
        } catch (e) {
          // only means the volume is not remembered next time
        }
      }
    };
    const stored = Number(savedPeerVolumes()[key]);
    show(Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 100, false);

    slider.addEventListener('input', () => show(Number(slider.value), true));
    button.addEventListener('click', () => {
      const current = Number(slider.value);
      if (current > 0) beforeMute = current;
      show(current > 0 ? 0 : beforeMute || 100, true);
    });
  }

  // --- Shared sound: each person's screen-share sound plays apart from their voice, at their
  // volume, and is lowered while anyone speaks (ducking), then rises back when they stop.
  const DUCKED_VOLUME = 0.35; // about -9 dB: clearly lower, still easy to hear
  const DUCK_DOWN_PER_SECOND = 4; // fades down within about a sixth of a second when someone speaks
  const DUCK_UP_PER_SECOND = 1.2; // and back up over about half a second after they stop
  const speakingPeers = new Set();
  let duckLevel = 1;
  let lastDuckTick = performance.now();

  function handleRemoteScreenAudio(peerId, track) {
    const tile = track ? ensurePeerTile(peerId) : document.getElementById(`peer-tile-${peerId}`);
    if (!tile) return;
    let audio = tile.querySelector('audio.screen-audio');
    if (!track) {
      if (audio) audio.srcObject = null;
      return;
    }
    if (!audio) {
      audio = document.createElement('audio');
      audio.className = 'screen-audio';
      audio.autoplay = true;
      tile.appendChild(audio);
      applySpeaker(audio);
    }
    audio.srcObject = new MediaStream([track]);
    applyScreenAudioVolume(tile);
    audio.play().catch(() => {}); // autoplay is allowed in the app; a browser may need a click first
  }

  function applyScreenAudioVolume(tile) {
    const audio = tile.querySelector('audio.screen-audio');
    if (!audio) return;
    const personal = Number(tile.querySelector('.tile-volume-slider')?.value ?? 100) / 100;
    audio.volume = Math.min(1, Math.max(0, personal * duckLevel));
  }

  setInterval(() => {
    const now = performance.now();
    const seconds = Math.min(0.2, (now - lastDuckTick) / 1000);
    lastDuckTick = now;
    const target = speakingPeers.size ? DUCKED_VOLUME : 1;
    if (duckLevel === target) return;
    duckLevel = target < duckLevel
      ? Math.max(target, duckLevel - DUCK_DOWN_PER_SECOND * seconds)
      : Math.min(target, duckLevel + DUCK_UP_PER_SECOND * seconds);
    videoGrid.querySelectorAll('.peer-tile').forEach(applyScreenAudioVolume);
  }, 40);

  function handleRemoteTrack(peerId, stream, track) {
    const tile = ensurePeerTile(peerId);
    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
    updatePeerTile(clientCore.roomState.participants.find(u => u.id === peerId));
  }

  // Reflect a peer's mic/camera state on their video tile
  function updatePeerTile(peer) {
    if (!peer) return;
    const tile = document.getElementById(`peer-tile-${peer.id}`);
    if (!tile) return;
    const media = peer.mediaState || {};
    setStatusIcon(tile.querySelector('.status-icon'), !media.audio);
    tile.querySelector('.avatar-fallback').classList.toggle('hidden', !!(media.video || media.screen));
    tile.classList.toggle('is-screen', !!media.screen);
  }

  function removePeerVideoTile(peerId) {
    const tile = document.getElementById(`peer-tile-${peerId}`);
    if (tile) tile.remove();
    speakingPeers.delete(peerId);
    updateGridLayout();
  }

  // The grid picks its column count from data-count (see style.css)
  function updateGridLayout() {
    const count = videoGrid.querySelectorAll('.video-tile').length;
    videoGrid.dataset.count = count > 9 ? 'many' : String(count);
  }

  // --- Call Control Buttons ---
  function setMicMutedUI(muted) {
    isMicMuted = muted;
    mediaEngine.setAudioEnabled(!muted);
    btnToggleMic.classList.toggle('active', muted);
    btnToggleMic.querySelector('.ctrl-label').textContent = muted ? 'Unmute' : 'Mute';
    setStatusIcon(localAudioIcon, muted);
  }

  // Off closes the camera (see MediaEngine.startCamera); turning it on goes through turnCameraOn()
  function setCamOffUI(off) {
    isCamOff = off;
    if (off) mediaEngine.stopCamera();
    btnToggleCam.classList.toggle('active', off);
    btnToggleCam.querySelector('.ctrl-label').textContent = off ? 'Start Video' : 'Stop Video';
    const hasVideo = !!mediaEngine.localStream?.getVideoTracks().length;
    localAvatarFallback.classList.toggle('hidden', isScreenSharing || (hasVideo && !off));
  }

  function setScreenShareUI(sharing) {
    isScreenSharing = sharing;
    btnShareScreen.classList.toggle('active', sharing);
    btnShareScreen.querySelector('.ctrl-label').textContent = sharing ? 'Stop Sharing' : 'Share Screen';
    localVideo.srcObject = sharing ? mediaEngine.screenStream : mediaEngine.localStream;
    localTile.classList.toggle('is-screen', sharing);
    setCamOffUI(isCamOff);
  }

  btnToggleMic.addEventListener('click', () => {
    if (btnToggleMic.disabled || micStarting) return;
    // Joined without voice permission: the microphone opens on the first unmute
    if (isMicMuted && !mediaEngine.localStream?.getAudioTracks().length) {
      turnMicOn();
      return;
    }
    setMicMutedUI(!isMicMuted);
    clientCore.sendMediaState({ audio: !isMicMuted });
  });

  async function turnMicOn() {
    micStarting = true;
    btnToggleMic.classList.add('is-busy');
    try {
      const track = await mediaEngine.startMicrophone();
      // Left the room, or voice was taken away, while the microphone was opening
      if (!track || !clientCore.currentUser || btnToggleMic.disabled) return;
      setMicMutedUI(false);
      clientCore.sendMediaState({ audio: true });
    } catch (e) {
      console.warn('Microphone unavailable:', e);
      showToast(`The microphone could not be started: ${e.message || e.name}`);
    } finally {
      micStarting = false;
      btnToggleMic.classList.remove('is-busy');
    }
  }

  async function turnCameraOn() {
    cameraStarting = true;
    btnToggleCam.classList.add('is-busy');
    try {
      const track = await mediaEngine.startCamera();
      // Left the room, or video was taken away, while the camera was opening
      if (!track || !clientCore.currentUser || btnToggleCam.disabled) {
        mediaEngine.stopCamera();
        return;
      }
      if (!isScreenSharing) localVideo.srcObject = mediaEngine.localStream;
      setCamOffUI(false);
      clientCore.sendMediaState({ video: true });
    } catch (e) {
      console.warn('Camera unavailable:', e);
      showToast(`The camera could not be started: ${e.message || e.name}`);
    } finally {
      cameraStarting = false;
      btnToggleCam.classList.remove('is-busy');
    }
  }

  btnToggleCam.addEventListener('click', () => {
    if (btnToggleCam.disabled || cameraStarting) return;
    if (isCamOff) {
      turnCameraOn();
    } else {
      setCamOffUI(true);
      clientCore.sendMediaState({ video: false });
    }
  });

  btnShareScreen.addEventListener('click', async () => {
    if (!isScreenSharing) {
      if (btnShareScreen.disabled) return;
      const stream = await mediaEngine.startScreenShare({ audio: shareSoundSetting() });
      // Video was taken away while the picker was open
      if (stream && btnShareScreen.disabled) {
        mediaEngine.stopScreenShare();
      } else if (stream) {
        setScreenShareUI(true);
        clientCore.sendMediaState({ screen: true });
      }
    } else {
      mediaEngine.stopScreenShare();
      setScreenShareUI(false);
      clientCore.sendMediaState({ screen: false });
    }
  });

  function setSidePanelOpen(open) {
    sidePanel.classList.toggle('collapsed', !open);
    btnToggleChatPanel.classList.toggle('active', open);
    chatController.isPanelOpen = open;
    if (open && tabChat.classList.contains('active')) {
      chatController.markRead();
    }
  }

  btnToggleChatPanel.addEventListener('click', () => {
    setSidePanelOpen(sidePanel.classList.contains('collapsed'));
  });

  btnHeaderParticipants.addEventListener('click', () => {
    setSidePanelOpen(true);
    tabUsers.click();
  });

  // Segmented control drives the (hidden) select that ChatController listens to
  const modeSelect = document.getElementById('select-chat-mode');
  const modeButtons = document.querySelectorAll('.mode-seg-btn');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.toggle('active', b === btn));
      modeSelect.value = btn.dataset.mode;
      modeSelect.dispatchEvent(new Event('change'));
    });
  });

  tabChat.addEventListener('click', () => {
    tabChat.classList.add('active');
    tabUsers.classList.remove('active');
    panelChat.classList.add('active-panel');
    panelUsers.classList.remove('active-panel');
    chatController.markRead();
  });

  tabUsers.addEventListener('click', () => {
    tabUsers.classList.add('active');
    tabChat.classList.remove('active');
    panelUsers.classList.add('active-panel');
    panelChat.classList.remove('active-panel');
  });

  btnLeaveRoom.addEventListener('click', () => {
    modalLeave.classList.remove('hidden');
    btnCancelLeave.focus();
  });

  btnCancelLeave.addEventListener('click', () => {
    modalLeave.classList.add('hidden');
  });

  btnConfirmLeave.addEventListener('click', () => {
    lastJoin = null; // left on purpose: never rejoin by itself
    leaveRoom();
  });

  function leaveRoom() {
    modalLeave.classList.add('hidden');
    clientCore.disconnect();
    screenRoom.classList.add('hidden');
    screenJoin.classList.remove('hidden');
    btnJoin.disabled = false;
    joinSpinner.classList.add('hidden');
    renderServerHistory();
    // Clear video grid except local
    videoGrid.querySelectorAll('.peer-tile').forEach(t => t.remove());
    updateGridLayout();
    localVideo.srcObject = null;
    localTile.classList.remove('is-screen');
    stopCallTimer();

    // Reset per-session state so the next join starts clean
    isScreenSharing = false;
    btnShareScreen.classList.remove('active');
    btnShareScreen.querySelector('.ctrl-label').textContent = 'Share Screen';
    setMicMutedUI(true);
    setCamOffUI(true);
    chatController.reset();
    speakingPeers.clear();
    [modalInvite, modalSettings].forEach(m => m?.classList.add('hidden'));
  }

  // --- Participants List UI ---
  function updateParticipantsUI() {
    const participants = clientCore.roomState.participants || [];
    userCountBadge.textContent = participants.length;
    headerParticipantCount.textContent = participants.length;
    chatController.updateParticipants(participants, clientCore.currentUser?.id);

    // Keep one tile per remote participant
    const remoteIds = new Set();
    participants.forEach(u => {
      if (clientCore.currentUser && u.id !== clientCore.currentUser.id) {
        remoteIds.add(u.id);
        ensurePeerTile(u.id);
      }
    });
    videoGrid.querySelectorAll('.peer-tile').forEach(t => {
      if (!remoteIds.has(t.id.replace('peer-tile-', ''))) t.remove();
    });
    updateGridLayout();

    participantsList.innerHTML = '';
    participants.forEach(u => {
      const isMe = clientCore.currentUser && u.id === clientCore.currentUser.id;
      const item = document.createElement('div');
      item.className = 'participant-item';
      const perms = u.permissions || {};
      const media = u.mediaState || {};
      const mic = perms.can_audio === false
        ? { cls: 'is-blocked', icon: 'mic-off', title: 'Audio disabled by admin' }
        : media.audio ? { cls: 'is-on', icon: 'mic', title: 'Mic on' } : { cls: 'is-off', icon: 'mic-off', title: 'Muted' };
      const cam = perms.can_video === false
        ? { cls: 'is-blocked', icon: 'video-off', title: 'Video disabled by admin' }
        : media.video ? { cls: 'is-on', icon: 'video', title: 'Camera on' } : { cls: 'is-off', icon: 'video-off', title: 'Camera off' };
      item.innerHTML = `
        <div class="participant-left">
          <div class="user-avatar-sm">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
          <div class="participant-name">
            <strong>${escapeHtml(u.username)}${isMe ? ' <span class="you-tag">(You)</span>' : ''}</strong>
            <span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${escapeHtml(u.role)}</span>
          </div>
        </div>
        <div class="participant-status-icons">
          <span class="${mic.cls}" title="${mic.title}">${iconSvg(mic.icon)}</span>
          <span class="${cam.cls}" title="${cam.title}">${iconSvg(cam.icon)}</span>
        </div>
      `;
      setAvatarHue(item.querySelector('.user-avatar-sm'), u.username);
      participantsList.appendChild(item);
      if (!isMe) updatePeerTile(u);
    });
  }

  // --- Invite Modal ---
  btnOpenInvite.addEventListener('click', () => {
    modalInvite.classList.remove('hidden');
    inviteTargetUsername.value = '';
    modalInviteResult.classList.add('hidden');
    inviteError.classList.add('hidden');
    inviteTargetUsername.focus();
  });

  inviteTargetUsername.addEventListener('input', () => {
    inviteError.classList.add('hidden');
  });

  btnCancelInvite.addEventListener('click', () => {
    modalInvite.classList.add('hidden');
  });

  btnSubmitInvite.addEventListener('click', () => {
    const target = inviteTargetUsername.value.trim();
    if (!target) {
      inviteError.classList.remove('hidden');
      inviteTargetUsername.focus();
      return;
    }
    clientCore.requestInviteLink(target);
  });

  btnCopyInviteLink.addEventListener('click', () => {
    inviteLinkOutput.select();
    navigator.clipboard.writeText(inviteLinkOutput.value).then(() => {
      showToast('Invite link copied to clipboard!');
    }).catch(() => {
      document.execCommand('copy');
      showToast('Invite link copied!');
    });
  });

  // --- Device Settings Modal & Hardware Controls ---
  const btnDeviceSettings = document.getElementById('btn-device-settings');
  const modalSettings = document.getElementById('modal-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const selectAudioInput = document.getElementById('select-audio-input');
  const selectVideoInput = document.getElementById('select-video-input');
  const selectAudioOutput = document.getElementById('select-audio-output');
  const micTestFill = document.getElementById('mic-test-fill');

  // Chosen devices are remembered between calls and used when the camera and microphone open
  const DEVICES_KEY = 'vc_devices';
  function savedDevices() {
    try {
      return JSON.parse(localStorage.getItem(DEVICES_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveDevice(kind, deviceId) {
    try {
      localStorage.setItem(DEVICES_KEY, JSON.stringify({ ...savedDevices(), [kind]: deviceId }));
    } catch (e) {
      // only means the choice is not remembered next time
    }
  }
  const startupDevices = savedDevices();
  mediaEngine.setPreferredDevices({ audioinput: startupDevices.audioinput, videoinput: startupDevices.videoinput });
  let speakerId = startupDevices.audiooutput || '';

  // Everyone's voice plays from their video tile
  function applySpeaker(element) {
    if (typeof element.setSinkId !== 'function') return Promise.resolve();
    return element.setSinkId(speakerId === 'default' ? '' : speakerId).catch(e => console.warn('Cannot use this speaker:', e));
  }
  function applySpeakerEverywhere() {
    return Promise.all([...videoGrid.querySelectorAll('.peer-tile video, .peer-tile audio.screen-audio')].map(applySpeaker));
  }

  async function switchDevice(select, kind) {
    const deviceId = select.value;
    const previous = select.dataset.current || '';
    try {
      if (kind === 'audiooutput') {
        speakerId = deviceId;
        await applySpeakerEverywhere();
      } else if (clientCore.currentUser && (mediaEngine.localStream || mediaEngine.rawAudioTrack)) {
        if (kind === 'audioinput') {
          await mediaEngine.switchMicrophone(deviceId);
        } else {
          await mediaEngine.switchCamera(deviceId);
          if (!isScreenSharing) localVideo.srcObject = mediaEngine.localStream;
        }
      } else {
        mediaEngine.setPreferredDevices({ [kind]: deviceId });
      }
      saveDevice(kind, deviceId);
      select.dataset.current = deviceId;
    } catch (e) {
      console.warn(`Could not switch ${kind}:`, e);
      showToast('That device could not be opened; the previous one is still in use.');
      select.value = previous;
      deviceMenus.forEach(menu => menu.render());
    }
  }

  if (btnDeviceSettings) {
    btnDeviceSettings.addEventListener('click', () => {
      modalSettings.classList.remove('hidden');
      populateDeviceList();
      showGraphicsSetting();
    });
  }

  // Sharing the computer's sound with the screen: on unless turned off (remembered on this computer)
  const SHARE_SOUND_KEY = 'vc_share_sound';
  const toggleShareSound = document.getElementById('toggle-share-sound');
  function shareSoundSetting() {
    try {
      return localStorage.getItem(SHARE_SOUND_KEY) !== 'off';
    } catch (e) {
      return true;
    }
  }
  toggleShareSound.checked = shareSoundSetting();
  toggleShareSound.addEventListener('change', () => {
    try {
      localStorage.setItem(SHARE_SOUND_KEY, toggleShareSound.checked ? 'on' : 'off');
    } catch (e) {
      // only means the choice is not remembered next time
    }
    if (isScreenSharing) showToast('Applies the next time you share your screen.');
  });

  // Graphics card (desktop app only): off by default to save memory; a change applies at the next start
  const graphicsSetting = document.getElementById('graphics-setting');
  const toggleGraphicsCard = document.getElementById('toggle-graphics-card');
  const graphicsRestartNote = document.getElementById('graphics-restart-note');
  async function showGraphicsSetting() {
    const setting = await window.videocallNative?.graphicsSetting?.().catch(() => null);
    graphicsSetting.classList.toggle('hidden', !setting);
    if (!setting) return;
    toggleGraphicsCard.checked = setting.saved;
    graphicsRestartNote.classList.toggle('hidden', setting.saved === setting.active);
  }
  toggleGraphicsCard.addEventListener('change', async () => {
    const saved = await window.videocallNative.setGraphicsSetting(toggleGraphicsCard.checked).catch(() => false);
    if (!saved) {
      toggleGraphicsCard.checked = !toggleGraphicsCard.checked;
      showToast('The setting could not be saved.');
      return;
    }
    showGraphicsSetting();
  });
  document.getElementById('btn-restart-app').addEventListener('click', () => window.videocallNative.restartApp());

  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      modalSettings.classList.add('hidden');
    });
  }

  // --- Themed dropdowns ---
  // The OS draws native <select> popups in its own (light) style, so each device select gets a
  // custom menu. The hidden <select> stays the source of truth for value and change events.
  function enhanceSelect(select) {
    const wrapper = document.createElement('div');
    wrapper.className = 'select-menu';
    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const listId = `${select.id}-list`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);
    const label = document.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.removeAttribute('for');
      label.id = label.id || `${select.id}-label`;
      label.addEventListener('click', () => trigger.focus());
      trigger.setAttribute('aria-labelledby', label.id);
    }
    trigger.innerHTML = `
      ${select.dataset.icon ? `<span class="select-icon">${iconSvg(select.dataset.icon)}</span>` : ''}
      <span class="select-value"></span>
      <span class="select-chevron">${iconSvg('chevron-down')}</span>
    `;

    const list = document.createElement('ul');
    list.className = 'select-options';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    wrapper.append(trigger, list);

    let activeIndex = -1;

    function render() {
      const options = Array.from(select.options);
      const current = select.options[select.selectedIndex];
      trigger.querySelector('.select-value').textContent = current ? current.textContent : 'No devices found';
      trigger.disabled = options.length === 0;
      list.innerHTML = '';
      options.forEach((opt, i) => {
        const item = document.createElement('li');
        item.className = 'select-option';
        item.setAttribute('role', 'option');
        item.id = `${listId}-${i}`;
        item.setAttribute('aria-selected', String(i === select.selectedIndex));
        item.innerHTML = `<span class="select-option-label"></span><span class="select-check">${iconSvg('check')}</span>`;
        item.querySelector('.select-option-label').textContent = opt.textContent;
        item.addEventListener('mousemove', () => setActive(i));
        item.addEventListener('click', () => choose(i));
        list.appendChild(item);
      });
    }

    function setActive(i) {
      const items = list.children;
      if (!items.length) return;
      activeIndex = (i + items.length) % items.length;
      Array.from(items).forEach((el, n) => el.classList.toggle('is-active', n === activeIndex));
      trigger.setAttribute('aria-activedescendant', items[activeIndex].id);
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function open() {
      if (trigger.disabled || wrapper.classList.contains('is-open')) return;
      document.querySelectorAll('.select-menu.is-open').forEach(other => other.close?.());
      wrapper.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      setActive(Math.max(0, select.selectedIndex));
    }

    function close() {
      wrapper.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
    }
    wrapper.close = close;

    function choose(i) {
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      render();
      close();
      trigger.focus();
    }

    trigger.addEventListener('click', () => (wrapper.classList.contains('is-open') ? close() : open()));
    trigger.addEventListener('keydown', e => {
      const isOpen = wrapper.classList.contains('is-open');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) open();
        else setActive(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        if (!isOpen) return;
        e.preventDefault();
        setActive(e.key === 'Home' ? 0 : list.children.length - 1);
      } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) {
        e.preventDefault();
        choose(activeIndex);
      } else if (e.key === 'Escape' && isOpen) {
        e.stopPropagation(); // close the menu, not the whole dialog
        close();
      } else if (e.key === 'Tab') {
        close();
      }
    });
    document.addEventListener('mousedown', e => {
      if (!wrapper.contains(e.target)) close();
    });
    select.addEventListener('change', render);

    render();
    return { render };
  }

  const deviceMenus = [selectAudioInput, selectVideoInput, selectAudioOutput]
    .filter(Boolean)
    .map(enhanceSelect);
  selectAudioInput.addEventListener('change', () => switchDevice(selectAudioInput, 'audioinput'));
  selectVideoInput.addEventListener('change', () => switchDevice(selectVideoInput, 'videoinput'));
  selectAudioOutput.addEventListener('change', () => switchDevice(selectAudioOutput, 'audiooutput'));
  // A headset plugged in or out while the settings are open. Listened for only then: a device-change
  // listener keeps Chromium's video capture service (about 20 MB) running for as long as it exists.
  new MutationObserver(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.ondevicechange = modalSettings.classList.contains('hidden') ? null : () => populateDeviceList();
  }).observe(modalSettings, { attributes: true, attributeFilter: ['class'] });

  // --- Server calculator: what server to rent for a number of people (model in serverSizing.js) ---
  const modalCalculator = document.getElementById('modal-calculator');
  const calcForm = document.getElementById('calc-form');
  const calcPeople = document.getElementById('calc-participants');
  const calcPeopleRange = document.getElementById('calc-participants-range');

  function formatSpeed(mbps) {
    return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`;
  }

  function formatTrafficPerHour(gb) {
    return gb < 1 ? `${Math.max(1, Math.round(gb * 1000))} MB / hour` : `${gb} GB / hour`;
  }

  // The number box and the slider stay in step; the box also takes numbers beyond the slider
  calcPeopleRange.addEventListener('input', () => { calcPeople.value = calcPeopleRange.value; });
  calcPeople.addEventListener('input', () => { calcPeopleRange.value = calcPeople.value; });

  function renderCalculator() {
    const result = ServerSizing.estimateForUsers(Number(calcPeople.value));
    const { recommendation: rec, load, perParticipant } = result;

    const verdict = document.getElementById('calc-verdict');
    verdict.dataset.state = result.fits ? 'ok' : 'bad';
    verdict.textContent = result.fits ? 'Recommended server' : 'Not workable as one call (see below)';

    const specs = document.getElementById('calc-specs');
    specs.dataset.state = result.fits ? 'ok' : 'bad';
    specs.innerHTML = [
      ['Processor', `${rec.vcpu} vCPU`, rec.cpuNote],
      ['Memory', `${rec.ramGb} GB RAM`, 'any Linux VPS plan'],
      ['Network', formatSpeed(rec.linkMbps), 'port speed'],
      ['Traffic', formatTrafficPerHour(rec.trafficGbPerHour), 'outgoing, per hour of calls'],
      ['Storage', `${rec.diskGb} GB SSD`, 'system, app and logs'],
      ['System', 'Ubuntu / Debian', 'any 64-bit Linux works']
    ].map(([label, value, note]) => `
      <div class="calc-spec">
        <span class="calc-spec-label">${escapeHtml(label)}</span>
        <span class="calc-spec-value">${escapeHtml(value)}</span>
        <span class="calc-spec-note">${escapeHtml(note)}</span>
      </div>`).join('');

    const fill = document.getElementById('calc-load-fill');
    fill.style.width = `${Math.min(100, load.corePct)}%`;
    fill.dataset.level = load.corePct > 85 ? 'bad' : load.corePct > 60 ? 'warn' : 'ok';
    document.getElementById('calc-load-value').textContent = `${load.corePct > 999 ? '>999' : load.corePct}%`;

    document.getElementById('calc-details').innerHTML = [
      ['Relayed through the server', `${load.relayMbps} Mbit/s each way (${load.relayedShare}% of connections)`],
      ['Server upload, typical', `${load.uploadMbps} Mbit/s`],
      ['Each camera user needs', `${perParticipant.cameraUploadMbps} Mbit/s upload`],
      ['Each participant needs', `${perParticipant.downloadMbps} Mbit/s download`]
    ].map(([label, value]) => `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></li>`).join('');

    document.getElementById('calc-warnings').innerHTML = result.warnings
      .map(w => `<li data-level="${w.level}">${escapeHtml(w.text)}</li>`).join('');
  }

  calcForm.addEventListener('input', renderCalculator);
  calcForm.addEventListener('change', renderCalculator);
  calcForm.addEventListener('submit', e => e.preventDefault());

  document.getElementById('btn-open-calculator').addEventListener('click', () => {
    renderCalculator();
    modalCalculator.classList.remove('hidden');
    calcPeople.focus();
  });

  document.getElementById('btn-close-calculator').addEventListener('click', () => {
    modalCalculator.classList.add('hidden');
  });

  async function populateDeviceList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const selects = { audioinput: selectAudioInput, videoinput: selectVideoInput, audiooutput: selectAudioOutput };
      Object.values(selects).forEach(select => { select.innerHTML = ''; });

      devices.forEach(d => {
        const select = selects[d.kind];
        if (!select) return;
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 5)}...)`;
        select.appendChild(opt);
      });

      // Show the device in use: the one chosen (if still connected), else what the call actually uses
      const inUse = mediaEngine.currentDevices();
      const saved = savedDevices();
      const choose = (kind, ...candidates) => {
        const select = selects[kind];
        const ids = Array.from(select.options, o => o.value);
        const pick = candidates.find(id => id && ids.includes(id));
        if (pick) select.value = pick;
        select.dataset.current = select.value;
      };
      choose('audioinput', saved.audioinput, inUse.audioinput);
      choose('videoinput', saved.videoinput, inUse.videoinput);
      choose('audiooutput', speakerId, 'default');
      deviceMenus.forEach(menu => menu.render());
    } catch (e) {
      console.warn('Could not enumerate media devices:', e);
    }
  }

  // Live input level meter listener in settings
  if (mediaEngine) {
    const origAudioLevel = mediaEngine.onAudioLevel;
    mediaEngine.onAudioLevel = (level, speaking) => {
      origAudioLevel(level, speaking);
      if (micTestFill) {
        micTestFill.style.width = `${level}%`;
      }
    };
  }

  // --- Keyboard Shortcuts ---
  window.addEventListener('keydown', e => {
    // Leave browser shortcuts (Ctrl+C, Cmd+V, ...) alone; call shortcuts only apply inside a room
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Electron, unlike a browser, does not leave full screen on Esc by itself
    if (e.key === 'Escape' && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (e.key === 'Escape') modalCalculator.classList.add('hidden'); // opened from the join screen
    if (screenRoom.classList.contains('hidden')) return;

    // Ignore shortcuts when user is typing in chat or input
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      if (e.key === 'Escape') {
        modalSettings?.classList.add('hidden');
        modalInvite?.classList.add('hidden');
        modalLeave?.classList.add('hidden');
      }
      return;
    }

    if (e.key.toLowerCase() === 'm') {
      btnToggleMic?.click();
    } else if (e.key.toLowerCase() === 'v') {
      btnToggleCam?.click();
    } else if (e.key.toLowerCase() === 'c') {
      btnToggleChatPanel?.click();
    } else if (e.key === 'Escape') {
      modalSettings?.classList.add('hidden');
      modalInvite?.classList.add('hidden');
      modalLeave?.classList.add('hidden');
    }
  });

  function showToast(msg, duration = 3000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastWrapper.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, duration);
  }

  // --- Small UI helpers ---
  function iconSvg(name) {
    return `<svg class="icon"><use href="#i-${name}"></use></svg>`;
  }

  function setStatusIcon(el, muted) {
    el.innerHTML = iconSvg(muted ? 'mic-off' : 'mic');
    el.classList.toggle('is-muted', muted);
  }

  // Stable per-user avatar colour derived from the username
  function setAvatarHue(el, name) {
    let hash = 0;
    for (const ch of String(name).toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) % 360;
    el.style.setProperty('--avatar-hue', hash);
  }

  function startCallTimer() {
    stopCallTimer();
    const started = Date.now();
    const tick = () => {
      const total = Math.floor((Date.now() - started) / 1000);
      const h = Math.floor(total / 3600);
      const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      callTimer.textContent = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    tick();
    callTimerInterval = setInterval(tick, 1000);
  }

  function stopCallTimer() {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
