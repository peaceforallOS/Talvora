/**
 * Video Call Application — UI Coordinator & Event Handler
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
  const modalMusic = document.getElementById('modal-music');
  const btnCloseMusicModal = document.getElementById('btn-close-music-modal');
  const btnModalPlayMusic = document.getElementById('btn-modal-play-music');
  const btnModalStopMusic = document.getElementById('btn-modal-stop-music');
  const musicCurrentDesc = document.getElementById('music-current-desc');
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
        // In the background: is the audio/video port reachable, and does the firewall allow VideoCall?
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
    },
    onChatMessage: msg => {
      chatController.receiveMessage(msg, clientCore.currentUser?.id);
    },
    onMusicState: state => {
      updateMusicUI(state);
    },
    onMusicError: msg => {
      showToast(`Music error: ${msg}`);
      if (musicErrorAlert) {
        musicErrorAlert.textContent = msg;
        musicErrorAlert.classList.remove('hidden');
      }
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
        result.firewall.blocking ? 'does not allow VideoCall yet' : 'allows VideoCall']);
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
        showToast('VideoCall is now allowed through the firewall.');
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
    updateTitle.textContent = `VideoCall ${update.version} is available`;
    updateStatus.textContent = `Install it now (${Math.max(1, Math.round(update.size / 1048576))} MB); VideoCall restarts by itself.`;
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
      updateStatus.textContent = 'Installing… VideoCall will close and start again.';
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

    roomNameDisplay.textContent = roomState.roomId || 'Video Call Room';
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
      <div class="tile-overlay">
        <span class="tile-username">${escapeHtml(username)}</span>
        <span class="status-icon">${iconSvg('mic')}</span>
      </div>
    `;
    setAvatarHue(tile.querySelector('.avatar-fallback'), username);
    videoGrid.appendChild(tile);
    updateGridLayout();
    return tile;
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

  // --- Synchronized Music UI & Actions ---
  btnMusicModal.addEventListener('click', () => {
    modalMusic.classList.remove('hidden');
    if (musicErrorAlert) musicErrorAlert.classList.add('hidden');
    updateMusicModalView();
  });

  btnCloseMusicModal.addEventListener('click', () => {
    modalMusic.classList.add('hidden');
  });

  const musicVolumeSlider = document.getElementById('music-volume-slider');

  if (musicVolumeSlider && sharedAudioElement) {
    musicVolumeSlider.addEventListener('input', () => {
      sharedAudioElement.volume = parseFloat(musicVolumeSlider.value);
    });
  }

  function updateMusicUI(state) {
    // A paused track still holds the room's music lock, so the bar stays visible
    if (state && state.playedBy) {
      roomMusicBar.classList.remove('hidden');
      musicTrackName.textContent = state.trackInfo?.title || 'Shared Music';
      musicDjName.textContent = `DJ: ${state.playedBy.username || 'User'}${state.isPlaying ? '' : ' (paused)'}`;
      btnStopMusicTop.classList.toggle('hidden', !(clientCore.currentUser?.role === 'admin' || clientCore.currentUser?.id === state.playedBy.id));

      // Synchronize audio playback element. `position` is computed by the server at send
      // time, which avoids depending on the client and server clocks agreeing.
      const url = state.trackInfo?.audioDataUrl;
      if (url) {
        if (sharedAudioElement.src !== url) {
          sharedAudioElement.src = url;
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
      if (sharedAudioElement) {
        sharedAudioElement.pause();
        sharedAudioElement.currentTime = 0;
        sharedAudioElement.removeAttribute('src');
      }
    }
    updateMusicModalView();
  }

  function updateMusicModalView() {
    const state = clientCore.roomState.musicState;
    if (state && state.playedBy) {
      musicCurrentDesc.innerHTML = `<strong>Playing:</strong> ${escapeHtml(state.trackInfo?.title)}<br><small>Started by ${escapeHtml(state.playedBy?.username)}</small>`;
      const canStop = clientCore.currentUser?.role === 'admin' || clientCore.currentUser?.id === state.playedBy?.id;
      btnModalStopMusic.classList.toggle('hidden', !canStop);
      btnModalPlayMusic.disabled = true;
    } else {
      musicCurrentDesc.textContent = 'No music is currently playing.';
      btnModalStopMusic.classList.add('hidden');
      btnModalPlayMusic.disabled = false;
    }
  }

  btnModalPlayMusic.addEventListener('click', () => {
    const title = musicTrackTitleInput.value.trim() || 'Room Music';
    const file = musicAudioFileInput.files && musicAudioFileInput.files[0];

    if (file) {
      if (file.size > MAX_MUSIC_FILE_BYTES) {
        musicErrorAlert.textContent = `This file is too large to share (maximum ${MAX_MUSIC_FILE_BYTES / 1024 / 1024} MB).`;
        musicErrorAlert.classList.remove('hidden');
        return;
      }
      musicErrorAlert.classList.add('hidden');
      const reader = new FileReader();
      reader.onload = e => {
        clientCore.sendMusicAction({
          action: 'play',
          trackInfo: {
            title: file.name.replace(/\.[^/.]+$/, ''),
            audioDataUrl: e.target.result
          }
        });
      };
      reader.readAsDataURL(file);
    } else {
      clientCore.sendMusicAction({
        action: 'play',
        trackInfo: { title }
      });
    }
  });

  btnModalStopMusic.addEventListener('click', () => {
    clientCore.sendMusicAction({ action: 'stop' });
  });

  btnStopMusicTop.addEventListener('click', () => {
    clientCore.sendMusicAction({ action: 'stop' });
  });

  // --- Device Settings Modal & Hardware Controls ---
  const btnDeviceSettings = document.getElementById('btn-device-settings');
  const modalSettings = document.getElementById('modal-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const selectAudioInput = document.getElementById('select-audio-input');
  const selectVideoInput = document.getElementById('select-video-input');
  const selectAudioOutput = document.getElementById('select-audio-output');
  const micTestFill = document.getElementById('mic-test-fill');

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

  async function populateDeviceList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      selectAudioInput.innerHTML = '';
      selectVideoInput.innerHTML = '';
      selectAudioOutput.innerHTML = '';

      devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 5)}...)`;

        if (d.kind === 'audioinput') {
          selectAudioInput.appendChild(opt);
        } else if (d.kind === 'videoinput') {
          selectVideoInput.appendChild(opt);
        } else if (d.kind === 'audiooutput') {
          selectAudioOutput.appendChild(opt);
        }
      });
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
