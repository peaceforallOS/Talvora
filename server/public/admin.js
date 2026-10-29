/**
 * Admin Management Panel Controller
 */

(function () {
  let setupToken = null; // one-time token from the first-visit panel link
  let sessionTimer = null;
  let participants = [];
  let musicState = null;
  let refreshTimer = null;
  let lastSnapshot = null;

  // DOM Elements
  const authOverlay = document.getElementById('auth-overlay');
  const tokenInput = document.getElementById('admin-token-input');
  const btnLogin = document.getElementById('btn-login');
  const authErrorMsg = document.getElementById('auth-error-msg');
  const authForm = document.getElementById('auth-form');
  const authTitle = document.getElementById('auth-title');
  const authSub = document.getElementById('auth-sub');
  const passwordInput = document.getElementById('admin-password');
  const confirmInput = document.getElementById('admin-password-confirm');
  const labelPassword = document.getElementById('label-password');
  const groupConfirm = document.getElementById('group-confirm');
  const groupSetupToken = document.getElementById('group-setup-token');

  const statRoomId = document.getElementById('stat-room-id');
  const statUsersCount = document.getElementById('stat-users-count');
  const statMicsOn = document.getElementById('stat-mics-on');
  const statCamsOn = document.getElementById('stat-cams-on');
  const statUptime = document.getElementById('stat-uptime');
  const btnLogout = document.getElementById('btn-logout');

  const musicBanner = document.getElementById('music-banner');
  const musicDetails = document.getElementById('music-playing-details');
  const btnStopMusic = document.getElementById('btn-admin-stop-music');

  const usersTbody = document.getElementById('users-tbody');
  const userSearch = document.getElementById('user-search');

  const btnOpenInvite = document.getElementById('btn-open-invite');
  const inviteModal = document.getElementById('invite-modal');
  const btnCloseInvite = document.getElementById('btn-close-invite');
  const btnGenerateInvite = document.getElementById('btn-generate-invite');
  const inviteUsernameInput = document.getElementById('invite-username');
  const inviteAllowPerm = document.getElementById('invite-allow-perm');
  const inviteResult = document.getElementById('invite-result');
  const generatedLinkInput = document.getElementById('generated-link-input');
  const resTargetUser = document.getElementById('res-target-user');
  const btnCopyLink = document.getElementById('btn-copy-link');

  const toastContainer = document.getElementById('toast-container');

  function extractToken(raw) {
    const value = String(raw || '').trim();
    const match = value.match(/setup=([^&\s]+)/);
    return match ? decodeURIComponent(match[1]) : value;
  }

  // Decide between first-time setup, the login form and the dashboard
  async function initSession() {
    // Earlier versions kept the admin token in the browser forever; drop it
    localStorage.removeItem('vc_admin_token');

    const params = new URLSearchParams(window.location.search);
    if (params.get('setup')) {
      setupToken = extractToken(params.get('setup'));
      // Keep the secret out of the address bar and browser history
      history.replaceState(null, '', window.location.pathname);
    }

    try {
      const res = await fetch('/api/admin/session');
      const state = await res.json();
      if (state.authenticated) {
        enterDashboard(state.expiresAt);
      } else {
        showAuthForm(state.passwordSet ? 'login' : 'setup');
      }
    } catch (err) {
      showAuthForm('login', 'Cannot reach the server. Please reload the page.');
    }
  }

  function showAuthForm(mode, error) {
    // Stop polling: the session is gone
    clearInterval(refreshTimer);
    refreshTimer = null;
    clearTimeout(sessionTimer);
    lastSnapshot = null;

    authForm.dataset.mode = mode;
    const setup = mode === 'setup';
    authTitle.textContent = setup ? 'Set your admin password' : 'Admin console';
    authSub.textContent = setup
      ? 'Welcome! Choose a password to protect this management panel. You will use it every time you sign in.'
      : 'Enter your admin password to manage the room.';
    labelPassword.textContent = setup ? 'New password' : 'Password';
    passwordInput.autocomplete = setup ? 'new-password' : 'current-password';
    groupConfirm.classList.toggle('hidden', !setup);
    groupSetupToken.classList.toggle('hidden', !setup || !!setupToken);
    btnLogin.textContent = setup ? 'Save password & continue' : 'Sign in';
    passwordInput.value = '';
    confirmInput.value = '';

    authForm.classList.remove('hidden');
    authOverlay.classList.remove('hidden');
    if (error) {
      authErrorMsg.textContent = error;
      authErrorMsg.classList.remove('hidden');
    } else {
      authErrorMsg.classList.add('hidden');
    }
    (setup && !setupToken ? tokenInput : passwordInput).focus();
  }

  // Signed in: show the panel until the server-side session expires
  function enterDashboard(expiresAt) {
    authOverlay.classList.add('hidden');
    authErrorMsg.classList.add('hidden');
    clearTimeout(sessionTimer);
    if (expiresAt) {
      sessionTimer = setTimeout(
        () => showAuthForm('login', 'Your session expired after 3 hours. Please sign in again.'),
        Math.max(0, expiresAt - Date.now())
      );
    }
    fetchRoomInfo();
  }

  function sessionEnded() {
    showAuthForm('login', 'Your session has ended. Please sign in again.');
  }

  // Admin actions authenticate with the session cookie; a 401 means it expired
  async function adminPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) sessionEnded();
    return res;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  btnLogout.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch (err) {
      // The cookie dies with the browser anyway
    }
    showAuthForm('login');
  });

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const setup = authForm.dataset.mode === 'setup';
    const password = passwordInput.value;
    const showError = message => {
      authErrorMsg.textContent = message;
      authErrorMsg.classList.remove('hidden');
    };

    if (!password) return showError('Please enter your password.');
    if (setup) {
      if (!setupToken) setupToken = extractToken(tokenInput.value);
      if (!setupToken) return showError('Paste the management panel link printed when the server was installed.');
      if (password.length < 8) return showError('The password must be at least 8 characters long.');
      if (password !== confirmInput.value) return showError('The two passwords do not match.');
    }

    btnLogin.disabled = true;
    try {
      const res = await fetch(setup ? '/api/admin/setup' : '/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup ? { setupToken, password, confirm: confirmInput.value } : { password })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setupToken = null;
        passwordInput.value = '';
        confirmInput.value = '';
        if (setup) showToast('Password saved. Welcome to your admin console!');
        enterDashboard(data.expiresAt);
      } else if (res.status === 409) {
        // Someone set (or cleared) the password meanwhile
        showAuthForm(setup ? 'login' : 'setup', data.error);
      } else {
        if (setup && res.status === 401) {
          setupToken = null;
          groupSetupToken.classList.remove('hidden');
        }
        showError(data.error || 'Sign in failed.');
        passwordInput.select();
      }
    } catch (err) {
      showError('Cannot reach the server. Please try again.');
    } finally {
      btnLogin.disabled = false;
    }
  });

  async function fetchRoomInfo() {
    try {
      const res = await fetch('/api/admin/info');
      if (res.status === 401) {
        sessionEnded();
        return;
      }
      if (!res.ok) throw new Error('Failed to load server state');

      const data = await res.json();
      authOverlay.classList.add('hidden');
      statUptime.textContent = formatUptime(data.serverStats?.uptime || 0);
      renderNetwork(data.network);
      renderRelease(data.release);

      // Skip re-rendering when nothing changed, so polling doesn't reset the table mid-interaction
      const snapshot = JSON.stringify([data.roomId, data.participants, data.musicState?.playedBy, data.musicState?.isPlaying, data.musicState?.trackInfo, Math.floor(Date.now() / 60000)]);
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        statRoomId.textContent = data.roomId;
        statUsersCount.textContent = data.participants.length;
        statMicsOn.textContent = data.participants.filter(u => u.mediaState?.audio).length;
        statCamsOn.textContent = data.participants.filter(u => u.mediaState?.video || u.mediaState?.screen).length;

        participants = data.participants;
        musicState = data.musicState;

        renderMusicBanner();
        renderUsersTable();
      }

      // Poll every 1.5 seconds for live real-time sync
      if (!refreshTimer) {
        refreshTimer = setInterval(fetchRoomInfo, 1500);
      }
    } catch (err) {
      console.warn('Network or server error while polling:', err);
    }
  }

  // A newer server release on GitHub: the admin installs it with one command on the server
  const releaseBanner = document.getElementById('release-banner');
  function renderRelease(release) {
    if (!release || !release.available) {
      releaseBanner.classList.add('hidden');
      return;
    }
    document.getElementById('release-title').textContent = `Talvora ${release.latest} is available (this server runs ${release.current})`;
    document.getElementById('release-command').textContent = release.command;
    document.getElementById('release-notes').href = release.releaseUrl || '#';
    releaseBanner.classList.remove('hidden');
  }

  document.getElementById('btn-copy-release-command').addEventListener('click', () => {
    const command = document.getElementById('release-command').textContent;
    navigator.clipboard.writeText(command).then(() => showToast('Command copied. Run it on the server.'),
      () => showToast(`Run on the server: ${command}`));
  });

  function renderMusicBanner() {
    if (musicState && musicState.playedBy) {
      musicBanner.classList.remove('hidden');
      const who = musicState.playedBy?.username || 'Unknown User';
      const title = musicState.trackInfo?.title || 'Shared Audio Stream';
      musicDetails.textContent = `${title} · played by ${who}${musicState.isPlaying ? '' : ' (paused)'}`;
    } else {
      musicBanner.classList.add('hidden');
    }
  }

  btnStopMusic.addEventListener('click', async () => {
    try {
      const res = await adminPost('/api/admin/stop-music', {});
      if (res.ok) {
        showToast('Music playback successfully stopped via Admin Authority.');
        fetchRoomInfo();
      }
    } catch (err) {
      showToast('Error stopping music.');
    }
  });

  // --- Network & ports ---
  const networkCard = document.getElementById('network-card');
  const networkSummary = document.getElementById('network-summary');
  const networkAddress = document.getElementById('network-address');
  const networkPorts = document.getElementById('network-ports');
  const btnNetworkRetry = document.getElementById('btn-network-retry');
  let lastNetwork = null;

  const PORT_STATES = {
    forwarded: ['Open', 'is-open'],
    partial: ['Partly open', 'is-warn'],
    failed: ['Not open', 'is-bad'],
    manual: ['Forward on router', 'is-warn'],
    direct: ['Allow in firewall', ''],
    disabled: ['This network only', '']
  };

  function renderNetwork(network) {
    if (!network || !network.ports) return;
    const snapshot = JSON.stringify(network);
    if (snapshot === lastNetwork) return;
    lastNetwork = snapshot;
    networkCard.classList.remove('hidden');

    const summaries = {
      direct: 'This server is directly on the internet. If it is a cloud server, also allow these ports in your provider\'s firewall.',
      upnp: `Your router (${network.router}) forwards these ports to this server automatically.`,
      manual: `Your router does not support automatic forwarding. Forward these ports on your router to ${network.localIp}.`,
      disabled: 'Only people on this network can join. Re-run the installer to allow joining over the internet.',
      none: ''
    };
    networkSummary.textContent = summaries[network.method] || '';
    btnNetworkRetry.classList.toggle('hidden', network.method !== 'upnp' || network.ports.every(p => p.state === 'forwarded'));

    networkAddress.classList.toggle('hidden', !network.publicBaseUrl);
    networkAddress.innerHTML = `${iconSvg('globe')}<span>People join at <code>${escapeHtml(network.publicBaseUrl || '')}</code></span>`;

    networkPorts.innerHTML = network.ports.map(port => {
      const [label, cls] = PORT_STATES[port.state] || [port.state, ''];
      return `<li class="port-row">
        <span class="port-label">${escapeHtml(port.label)}</span>
        <span class="port-purpose">${escapeHtml(port.purpose)}${port.error ? ` <span class="port-error">· ${escapeHtml(port.error)}</span>` : ''}</span>
        <span class="port-state ${cls}">${escapeHtml(label)}</span>
      </li>`;
    }).join('');
  }

  btnNetworkRetry.addEventListener('click', async () => {
    btnNetworkRetry.disabled = true;
    try {
      const res = await adminPost('/api/admin/network/retry', {});
      if (res.ok) {
        renderNetwork((await res.json()).network);
        showToast('Asked the router to open the ports again.');
      }
    } catch (err) {
      showToast('Could not reach the server.');
    } finally {
      btnNetworkRetry.disabled = false;
    }
  });

  function renderUsersTable() {
    const filter = userSearch.value.trim().toLowerCase();
    const filtered = participants.filter(u => u.username.toLowerCase().includes(filter));

    if (filtered.length === 0) {
      usersTbody.innerHTML = `<tr><td colspan="8" class="empty-state">${
        participants.length === 0
          ? `${iconSvg('users')}No one is in the room right now.`
          : `${iconSvg('search')}No users match your search.`
      }</td></tr>`;
      return;
    }

    usersTbody.innerHTML = '';
    filtered.forEach(user => {
      const tr = document.createElement('tr');
      const isAdmin = user.role === 'admin';

      const media = user.mediaState || {};
      tr.innerHTML = `
        <td>
          <div class="user-cell">
            <div class="avatar">${escapeHtml(user.username.charAt(0).toUpperCase())}</div>
            <div class="user-meta">
              <span class="user-name">${escapeHtml(user.username)}</span>
              <span class="user-sub">
                <span class="media-chips">
                  <span class="media-chip ${media.audio ? 'is-on' : ''}" title="${media.audio ? 'Mic on' : 'Mic off'}">${iconSvg(media.audio ? 'mic' : 'mic-off')}</span>
                  <span class="media-chip ${media.video ? 'is-on' : ''}" title="${media.video ? 'Camera on' : 'Camera off'}">${iconSvg(media.video ? 'video' : 'video-off')}</span>
                  ${media.screen ? `<span class="media-chip is-on" title="Sharing screen">${iconSvg('screen')}</span>` : ''}
                </span>
                <span>Joined ${escapeHtml(formatJoined(user.joinedAt))}</span>
              </span>
            </div>
          </div>
        </td>
        <td>
          <span class="badge ${isAdmin ? 'badge-admin' : 'badge-user'}">${escapeHtml(user.role)}</span>
        </td>
        <td class="td-perm">${createSwitch(user.id, 'can_audio', user.permissions.can_audio, isAdmin)}</td>
        <td class="td-perm">${createSwitch(user.id, 'can_video', user.permissions.can_video, isAdmin)}</td>
        <td class="td-perm">${createSwitch(user.id, 'can_chat', user.permissions.can_chat, isAdmin)}</td>
        <td class="td-perm">${createSwitch(user.id, 'can_play_music', user.permissions.can_play_music, isAdmin)}</td>
        <td class="td-perm">${createSwitch(user.id, 'can_invite', user.permissions.can_invite, isAdmin)}</td>
        <td class="td-actions">
          ${
            isAdmin
              ? `<span class="protected-tag">${iconSvg('lock')}Protected</span>`
              : `<div class="action-buttons">
                  <button class="btn btn-sm btn-ghost-danger btn-kick" data-id="${escapeHtml(user.id)}" data-name="${escapeHtml(user.username)}" title="Disconnect now; their invite link keeps working">${iconSvg('log-out')}Kick</button>
                  <button class="btn btn-sm btn-danger btn-remove-user" data-id="${escapeHtml(user.id)}" data-name="${escapeHtml(user.username)}" title="Disconnect and permanently disable their invite link">${iconSvg('user-x')}Remove User</button>
                </div>`
          }
        </td>
      `;
      setAvatarHue(tr.querySelector('.avatar'), user.username);

      usersTbody.appendChild(tr);
    });

    // Attach switch listeners
    usersTbody.querySelectorAll('.perm-toggle').forEach(input => {
      input.addEventListener('change', async e => {
        const userId = e.target.getAttribute('data-userid');
        const permKey = e.target.getAttribute('data-perm');
        const value = e.target.checked;

        const user = participants.find(u => u.id === userId);
        if (!user) return;

        const newPermissions = { ...user.permissions, [permKey]: value };

        try {
          const res = await adminPost('/api/admin/permissions', { userId, permissions: newPermissions });

          if (res.ok) {
            const permLabels = { can_audio: 'Audio', can_video: 'Video', can_chat: 'Chat', can_play_music: 'Music', can_invite: 'Inviting' };
            showToast(`${permLabels[permKey] || permKey} turned ${value ? 'on' : 'off'} for ${user.username}`);
            user.permissions[permKey] = value;
            lastSnapshot = null;
          } else {
            showToast('Failed to update permission');
            e.target.checked = !value; // revert
          }
        } catch (err) {
          showToast('Network error updating permission');
          e.target.checked = !value;
        }
      });
    });

    // Attach kick listeners
    usersTbody.querySelectorAll('.btn-kick').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-name');

        if (!confirm(`Kick ${username} out of the room? Their invite link will keep working.`)) return;

        try {
          const res = await adminPost('/api/admin/kick', { userId, reason: 'Removed by Room Administrator' });

          if (res.ok) {
            showToast(`${username} was kicked from the room.`);
            fetchRoomInfo();
          }
        } catch (err) {
          showToast('Could not kick the user.');
        }
      });
    });

    // Remove User: kick and revoke their invite link
    usersTbody.querySelectorAll('.btn-remove-user').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-name');

        if (!confirm(`Remove ${username}? They will be kicked out and their invite link will stop working. You can invite them again later with a new link.`)) return;

        try {
          const res = await adminPost('/api/admin/remove', { userId, username });

          if (res.ok) {
            showToast(`${username} was removed and their invite link was disabled.`);
            fetchRoomInfo();
          } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Could not remove the user.');
          }
        } catch (err) {
          showToast('Could not remove the user.');
        }
      });
    });
  }

  function createSwitch(userId, permKey, checked, disabled) {
    return `
      <label class="switch" title="${disabled ? 'Admins always have every permission' : ''}">
        <input type="checkbox" class="perm-toggle" data-userid="${escapeHtml(userId)}" data-perm="${permKey}" 
          ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="slider"></span>
      </label>
    `;
  }

  userSearch.addEventListener('input', () => {
    renderUsersTable();
  });

  // Invite Modal
  btnOpenInvite.addEventListener('click', () => {
    inviteModal.classList.remove('hidden');
    inviteUsernameInput.value = '';
    inviteAllowPerm.checked = false;
    inviteResult.classList.add('hidden');
    inviteUsernameInput.focus();
  });

  inviteUsernameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnGenerateInvite.click();
  });

  btnCloseInvite.addEventListener('click', () => {
    inviteModal.classList.add('hidden');
  });

  btnGenerateInvite.addEventListener('click', async () => {
    const targetUsername = inviteUsernameInput.value.trim();
    if (!targetUsername) {
      alert('Please enter a target username.');
      return;
    }

    try {
      const res = await adminPost('/api/admin/invite', { targetUsername, canInvite: inviteAllowPerm.checked });

      const data = await res.json();
      if (res.ok && data.success) {
        resTargetUser.textContent = targetUsername;
        generatedLinkInput.value = data.joinLink;
        inviteResult.classList.remove('hidden');
        showToast(`Invite link generated for ${targetUsername}!`);
      } else {
        alert(data.error || 'Failed to generate invite link');
      }
    } catch (err) {
      alert('Network error while generating link.');
    }
  });

  btnCopyLink.addEventListener('click', () => {
    generatedLinkInput.select();
    navigator.clipboard.writeText(generatedLinkInput.value).then(() => {
      showToast('Link copied to clipboard!');
    }).catch(() => {
      document.execCommand('copy');
      showToast('Link copied!');
    });
  });

  function iconSvg(name) {
    return `<svg class="icon"><use href="#i-${name}"></use></svg>`;
  }

  // Same per-user avatar colour as the client app
  function setAvatarHue(el, name) {
    let hash = 0;
    for (const ch of String(name).toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) % 360;
    el.style.setProperty('--avatar-hue', hash);
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m ${Math.floor(seconds % 60)}s`;
  }

  function formatJoined(joinedAt) {
    if (!joinedAt) return '';
    const mins = Math.floor((Date.now() - joinedAt) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return new Date(joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') inviteModal.classList.add('hidden');
  });

  // Start initialization
  initSession();
})();
