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
  const btnMusicModal = document.getElementById('btn-music-modal');
  const btnToggleChatPanel = document.getElementById('btn-toggle-chat-panel');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnOpenInvite = document.getElementById('btn-open-invite');

  // Music UI
  const roomMusicBar = document.getElementById('room-music-bar');
  const musicTrackName = document.getElementById('music-track-name');
  const musicDjName = document.getElementById('music-dj-name');
  const btnStopMusicTop = document.getElementById('btn-stop-music-top');
  const btnToggleMusicTop = document.getElementById('btn-toggle-music-top');
  const modalMusic = document.getElementById('modal-music');
  const btnCloseMusicModal = document.getElementById('btn-close-music-modal');
  const btnModalPlayMusic = document.getElementById('btn-modal-play-music');
  const musicTrackTitleInput = document.getElementById('music-track-title');
  const musicAudioFileInput = document.getElementById('music-audio-file');
  const musicErrorAlert = document.getElementById('music-error-alert');
  const sharedAudioElement = document.getElementById('shared-audio-element');

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
  let isMicMuted = false;
  let isCamOff = false;
  let isScreenSharing = false;
  let callTimerInterval = null;

  // Base64 inflates files by 4/3; stay under the server's 25 MB message limit
  const MAX_MUSIC_FILE_BYTES = 18 * 1024 * 1024;

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
      if (pendingJoin) {
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
      updateMusicModalView(); // music may have been allowed or taken away
    },
    onChatMessage: msg => {
      chatController.receiveMessage(msg, clientCore.currentUser?.id);
    },
    onMusicState: state => {
      updateMusicUI(state);
    },
    onMusicError: msg => {
      showToast(`Music: ${msg}`);
      sendingTrack = false;
      showMusicError(msg);
      updateMusicModalView();
    },
    onInviteGenerated: data => {
      inviteBoundName.textContent = data.username;
      inviteLinkOutput.value = data.joinLink;
      modalInviteResult.classList.remove('hidden');
      showToast(`Invite link generated for ${data.username}`);
    },
    onKicked: data => {
      leaveRoom();
      showJoinError(`You have been disconnected from the room: ${data.reason}`);
    },
    onDisconnected: data => {
      leaveRoom();
      showJoinError(data.reason);
    },
    onServerError: msg => {
      showToast(msg);
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

    applyPermissionsToUI(user.permissions);
    updateParticipantsUI();
    updateMusicUI(roomState.musicState);

    // Start local media
    try {
      const stream = await mediaEngine.initLocalMedia({ audio: true, video: true });
      if (!stream || !clientCore.currentUser) return; // left or got disconnected while waiting for devices
      localVideo.srcObject = stream;

      // Respect permissions/toggles that changed while devices were being opened
      mediaEngine.setAudioEnabled(!isMicMuted);
      mediaEngine.setVideoEnabled(!isCamOff);
      const hasAudio = stream.getAudioTracks().length > 0;
      const hasVideo = stream.getVideoTracks().length > 0;
      localAvatarFallback.classList.toggle('hidden', hasVideo && !isCamOff);
      clientCore.sendMediaState({ audio: hasAudio && !isMicMuted, video: hasVideo && !isCamOff });
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

  function setCamOffUI(off) {
    isCamOff = off;
    mediaEngine.setVideoEnabled(!off);
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
    if (btnToggleMic.disabled) return;
    setMicMutedUI(!isMicMuted);
    clientCore.sendMediaState({ audio: !isMicMuted });
  });

  btnToggleCam.addEventListener('click', () => {
    if (btnToggleCam.disabled) return;
    setCamOffUI(!isCamOff);
    clientCore.sendMediaState({ video: !isCamOff });
  });

  btnShareScreen.addEventListener('click', async () => {
    if (!isScreenSharing) {
      const stream = await mediaEngine.startScreenShare();
      if (stream) {
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
    sendingTrack = false;
    updateMusicUI(null);
    isScreenSharing = false;
    btnShareScreen.classList.remove('active');
    btnShareScreen.querySelector('.ctrl-label').textContent = 'Share Screen';
    setMicMutedUI(false);
    setCamOffUI(false);
    chatController.reset();
    [modalInvite, modalMusic, modalSettings].forEach(m => m?.classList.add('hidden'));
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

  // --- Synchronized Music ---
  // The server keeps the room's music state; every client plays the track itself, in sync. The DJ
  // (whoever started the track) and the admin control it: pause, resume, seek, stop.
  const musicNow = document.getElementById('music-now');
  const musicNowTitle = document.getElementById('music-now-title');
  const musicNowDj = document.getElementById('music-now-dj');
  const musicNowState = document.getElementById('music-now-state');
  const musicSeek = document.getElementById('music-seek');
  const musicTimeCurrent = document.getElementById('music-time-current');
  const musicTimeTotal = document.getElementById('music-time-total');
  const musicControls = document.getElementById('music-controls');
  const btnMusicToggle = document.getElementById('btn-music-toggle');
  const btnMusicBack = document.getElementById('btn-music-back');
  const btnMusicForward = document.getElementById('btn-music-forward');
  const btnMusicStop = document.getElementById('btn-music-stop');
  const musicControlNote = document.getElementById('music-control-note');
  const musicIdle = document.getElementById('music-idle');
  const musicStart = document.getElementById('music-start');
  const musicLockedNote = document.getElementById('music-locked-note');
  const musicDrop = document.querySelector('.music-drop');
  const musicFileName = document.getElementById('music-file-name');
  const musicFileHint = document.getElementById('music-file-hint');
  const musicVolumeSlider = document.getElementById('music-volume-slider');
  const musicModalVolume = document.getElementById('music-modal-volume');
  const MUSIC_VOLUME_KEY = 'vc_music_volume';
  const btnMusicChange = document.getElementById('btn-music-change');
  let loadedTrackId = null; // the track the audio element holds
  let seeking = false; // the DJ is dragging the position slider
  let sendingTrack = false;
  let changingTrack = false; // the DJ opened the picker to play a different song

  const formatTime = seconds => {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const musicState = () => clientCore.roomState.musicState;
  const isMusicController = state => !!state?.playedBy &&
    (clientCore.currentUser?.role === 'admin' || clientCore.currentUser?.id === state.playedBy.id);

  // Your own music volume, the same in the top bar and the music window, remembered
  function setMusicVolume(value, save) {
    const volume = Math.min(1, Math.max(0, Number(value)));
    sharedAudioElement.volume = volume;
    musicVolumeSlider.value = String(volume);
    musicModalVolume.value = String(volume);
    if (save) {
      try {
        localStorage.setItem(MUSIC_VOLUME_KEY, String(volume));
      } catch (e) {
        // only means it is not remembered next time
      }
    }
  }
  setMusicVolume((() => {
    try {
      return localStorage.getItem(MUSIC_VOLUME_KEY) ?? 0.8;
    } catch (e) {
      return 0.8;
    }
  })(), false);
  musicVolumeSlider.addEventListener('input', () => setMusicVolume(musicVolumeSlider.value, true));
  musicModalVolume.addEventListener('input', () => setMusicVolume(musicModalVolume.value, true));

  function updateMusicUI(state) {
    // A paused track still holds the room's music lock, so the bar stays visible
    if (state && state.playedBy) {
      const controller = isMusicController(state);
      roomMusicBar.classList.remove('hidden');
      musicTrackName.textContent = state.trackInfo?.title || 'Shared Music';
      musicDjName.textContent = `DJ: ${state.playedBy.username || 'User'}${state.isPlaying ? '' : ' (paused)'}`;
      btnStopMusicTop.classList.toggle('hidden', !controller);
      btnToggleMusicTop.classList.toggle('hidden', !controller || (!state.isPlaying && !clientCore.supportsFeature('music-resume')));
      btnToggleMusicTop.innerHTML = iconSvg(state.isPlaying ? 'pause' : 'play');
      btnToggleMusicTop.title = state.isPlaying ? 'Pause music for everyone' : 'Resume music for everyone';
      roomMusicBar.classList.toggle('is-paused', !state.isPlaying);

      // Synchronize the audio element. `position` is computed by the server at send time, which
      // avoids depending on the client and server clocks agreeing.
      const url = state.trackInfo?.audioDataUrl;
      if (url) {
        const trackKey = state.trackId || url.length; // older servers send no track id
        if (loadedTrackId !== trackKey) {
          sharedAudioElement.src = url;
          loadedTrackId = trackKey;
        }
        const position = Math.max(0, Number(state.position ?? state.currentTime) || 0);
        if (Math.abs(sharedAudioElement.currentTime - position) > 1) {
          sharedAudioElement.currentTime = position;
        }
        if (state.isPlaying) {
          sharedAudioElement.play().catch(e => console.warn('Audio auto-play policy:', e));
        } else {
          sharedAudioElement.pause();
        }
      }
    } else {
      roomMusicBar.classList.add('hidden');
      sharedAudioElement.pause();
      sharedAudioElement.removeAttribute('src');
      sharedAudioElement.load();
      loadedTrackId = null;
    }
    if (sendingTrack && state?.playedBy?.id === clientCore.currentUser?.id) {
      sendingTrack = false;
      changingTrack = false;
      resetMusicPicker();
    }
    updateMusicModalView();
  }

  function renderMusicProgress() {
    const duration = Number.isFinite(sharedAudioElement.duration) ? sharedAudioElement.duration : 0;
    musicSeek.max = String(duration);
    musicTimeTotal.textContent = duration ? formatTime(duration) : '–:––';
    if (!seeking) {
      musicSeek.value = String(sharedAudioElement.currentTime || 0);
      musicTimeCurrent.textContent = formatTime(sharedAudioElement.currentTime);
    }
  }
  sharedAudioElement.addEventListener('timeupdate', renderMusicProgress);
  sharedAudioElement.addEventListener('loadedmetadata', renderMusicProgress);

  // The server does not know a track's length, so the DJ's client reports the end: the track stays
  // loaded, paused at the start, and the play button can start it again
  sharedAudioElement.addEventListener('ended', () => {
    const state = musicState();
    if (!state?.isPlaying || !isMusicController(state)) return;
    clientCore.sendMusicAction({ action: 'pause' });
    clientCore.sendMusicAction({ action: 'seek', time: 0 });
  });

  function updateMusicModalView() {
    const state = musicState();
    const me = clientCore.currentUser;
    const active = !!state?.playedBy;
    const controller = isMusicController(state);
    const isDj = active && state.playedBy.id === me?.id;
    const canPlay = me?.permissions?.can_play_music !== false;

    musicNow.classList.toggle('hidden', !active);
    musicIdle.classList.toggle('hidden', active || !canPlay);
    if (active) {
      musicNow.classList.toggle('is-paused', !state.isPlaying);
      musicNowTitle.textContent = state.trackInfo?.title || 'Shared Music';
      musicNowDj.textContent = isDj ? 'Played by you' : `Played by ${state.playedBy.username}`;
      musicNowState.textContent = state.isPlaying ? 'Playing' : 'Paused';
      musicControls.classList.toggle('hidden', !controller);
      musicSeek.disabled = !controller;
      const canResume = clientCore.supportsFeature('music-resume');
      btnMusicToggle.innerHTML = iconSvg(state.isPlaying ? 'pause' : 'play');
      btnMusicToggle.title = state.isPlaying ? 'Pause for everyone' : 'Resume for everyone';
      btnMusicToggle.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Resume');
      btnMusicToggle.disabled = !state.isPlaying && !canResume;
      const dj = (clientCore.roomState.participants || []).find(u => u.id === state.playedBy.id);
      musicControlNote.textContent = !controller
        ? `Only ${state.playedBy.username} (the DJ)${dj?.role === 'admin' ? '' : ' and the admin'} can pause or skip.`
        : !state.isPlaying && !canResume ? 'This server is too old to resume a paused track; update it, or stop and play again.' : '';
      renderMusicProgress();
    }

    // Start a track: when nothing plays, or the DJ choosing to replace their own track
    if (!active || !isDj) changingTrack = false;
    btnMusicChange.classList.toggle('hidden', !(canPlay && active && isDj && !changingTrack));
    musicStart.classList.toggle('hidden', !canPlay || (active && !(isDj && changingTrack)));
    btnModalPlayMusic.querySelector('span').textContent = sendingTrack ? 'Sending to the room…' : isDj ? 'Play this instead' : 'Play for everyone';
    btnModalPlayMusic.disabled = sendingTrack || !(musicAudioFileInput.files && musicAudioFileInput.files[0]) || musicDrop.classList.contains('has-error');

    const locked = !canPlay
      ? 'The admin has turned off music for you.'
      : active && !isDj ? `${state.playedBy.username} is the DJ right now. You can play your own track when they stop.` : '';
    musicLockedNote.textContent = locked;
    musicLockedNote.classList.toggle('hidden', !locked);
  }

  function showMusicError(message) {
    musicErrorAlert.textContent = message;
    musicErrorAlert.classList.toggle('hidden', !message);
  }

  function resetMusicPicker() {
    musicAudioFileInput.value = '';
    musicTrackTitleInput.value = '';
    musicFileName.textContent = 'Choose an audio file';
    musicFileHint.textContent = `MP3, WAV, OGG or M4A, up to ${MAX_MUSIC_FILE_BYTES / 1024 / 1024} MB`;
    musicDrop.classList.remove('has-file', 'has-error');
    updateMusicModalView();
  }

  function chooseMusicFile(file) {
    showMusicError('');
    if (!file) {
      resetMusicPicker();
      return;
    }
    const tooLarge = file.size > MAX_MUSIC_FILE_BYTES;
    const notAudio = file.type && !file.type.startsWith('audio/');
    musicDrop.classList.add('has-file');
    musicDrop.classList.toggle('has-error', tooLarge || notAudio);
    musicFileName.textContent = file.name;
    musicFileHint.textContent = notAudio
      ? 'This is not an audio file.'
      : tooLarge ? `${(file.size / 1048576).toFixed(1)} MB is too large (maximum ${MAX_MUSIC_FILE_BYTES / 1024 / 1024} MB).`
        : `${(file.size / 1048576).toFixed(1)} MB · click to choose another`;
    if (!musicTrackTitleInput.value.trim()) musicTrackTitleInput.value = file.name.replace(/\.[^/.]+$/, '');
    updateMusicModalView();
  }

  musicAudioFileInput.addEventListener('change', () => chooseMusicFile(musicAudioFileInput.files[0]));
  // Drag a song onto the picker
  musicDrop.addEventListener('dragover', e => {
    e.preventDefault();
    musicDrop.classList.add('is-dragover');
  });
  musicDrop.addEventListener('dragleave', () => musicDrop.classList.remove('is-dragover'));
  musicDrop.addEventListener('drop', e => {
    e.preventDefault();
    musicDrop.classList.remove('is-dragover');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const files = new DataTransfer();
    files.items.add(file);
    musicAudioFileInput.files = files.files;
    chooseMusicFile(file);
  });

  btnMusicModal.addEventListener('click', () => {
    modalMusic.classList.remove('hidden');
    showMusicError('');
    changingTrack = false;
    updateMusicModalView();
  });

  btnMusicChange.addEventListener('click', () => {
    changingTrack = true;
    updateMusicModalView();
  });

  btnCloseMusicModal.addEventListener('click', () => {
    modalMusic.classList.add('hidden');
  });

  btnModalPlayMusic.addEventListener('click', () => {
    const file = musicAudioFileInput.files && musicAudioFileInput.files[0];
    if (!file || musicDrop.classList.contains('has-error')) return;
    const title = musicTrackTitleInput.value.trim() || file.name.replace(/\.[^/.]+$/, '');
    sendingTrack = true;
    updateMusicModalView();
    const reader = new FileReader();
    reader.onload = e => {
      if (!clientCore.sendMusicAction({ action: 'play', trackInfo: { title, audioDataUrl: e.target.result } })) {
        sendingTrack = false;
        showMusicError('Not connected to the room.');
        updateMusicModalView();
      }
    };
    reader.onerror = () => {
      sendingTrack = false;
      showMusicError('This file could not be read.');
      updateMusicModalView();
    };
    reader.readAsDataURL(file);
  });

  // DJ controls
  function toggleMusic() {
    const state = musicState();
    if (!isMusicController(state)) return;
    // A track paused at (or past) its end starts over instead of ending again at once
    const duration = sharedAudioElement.duration;
    if (!state.isPlaying && Number.isFinite(duration) && Number(state.position ?? state.currentTime) >= duration - 0.5) {
      clientCore.sendMusicAction({ action: 'seek', time: 0 });
    }
    clientCore.sendMusicAction({ action: state.isPlaying ? 'pause' : 'resume' });
  }

  function seekMusicTo(seconds) {
    const duration = Number.isFinite(sharedAudioElement.duration) ? sharedAudioElement.duration : Infinity;
    clientCore.sendMusicAction({ action: 'seek', time: Math.min(Math.max(0, seconds), Math.max(0, duration - 0.5)) });
  }

  btnMusicToggle.addEventListener('click', toggleMusic);
  btnToggleMusicTop.addEventListener('click', toggleMusic);
  btnMusicBack.addEventListener('click', () => seekMusicTo(sharedAudioElement.currentTime - 10));
  btnMusicForward.addEventListener('click', () => seekMusicTo(sharedAudioElement.currentTime + 10));
  musicSeek.addEventListener('input', () => {
    seeking = true;
    musicTimeCurrent.textContent = formatTime(musicSeek.value);
  });
  musicSeek.addEventListener('change', () => {
    seeking = false;
    seekMusicTo(Number(musicSeek.value));
  });

  const stopMusic = () => clientCore.sendMusicAction({ action: 'stop' });
  btnMusicStop.addEventListener('click', stopMusic);
  btnStopMusicTop.addEventListener('click', stopMusic);

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

  // Everyone's voice plays from their video tile; music from the shared audio element
  function applySpeaker(element) {
    if (typeof element.setSinkId !== 'function') return Promise.resolve();
    return element.setSinkId(speakerId === 'default' ? '' : speakerId).catch(e => console.warn('Cannot use this speaker:', e));
  }
  function applySpeakerEverywhere() {
    return Promise.all([sharedAudioElement, ...videoGrid.querySelectorAll('.peer-tile video')].map(applySpeaker));
  }
  applySpeaker(sharedAudioElement);

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
    });
  }

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
  // A headset plugged in or out while the settings are open
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!modalSettings.classList.contains('hidden')) populateDeviceList();
  });

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
        modalMusic?.classList.add('hidden');
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
      modalMusic?.classList.add('hidden');
      modalLeave?.classList.add('hidden');
    }
  });

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastWrapper.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3000);
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
