/**
 * Chat Box Controller — Public & Direct Messaging
 *
 * Everyone shows public messages only; Direct shows one conversation at a time, with the person chosen.
 * Conversations go by username: connection ids change every time someone joins.
 */

const EMPTY_PUBLIC = 'No messages yet.\nSay hello to the room 👋';
const EMPTY_NO_PERSON = 'Choose someone above\nto see your conversation.';
const READ_KEY = 'talvora.directRead';

class ChatController {
  constructor(options = {}) {
    this.core = options.core;
    this.container = options.container;
    this.input = options.input;
    this.form = options.form;
    this.modeSelect = options.modeSelect;
    this.recipientsBox = options.recipientsBox;
    this.recipientsList = options.recipientsList;
    this.unreadBadge = options.unreadBadge;
    this.revokedBanner = options.revokedBanner;
    this.publicBadge = options.publicBadge; // unread counts on the Everyone and Direct buttons
    this.directBadge = options.directBadge;
    this.onNotice = options.onNotice || (() => {}); // shown in the app, never as a native alert()

    this.currentMode = 'public'; // 'public' | 'direct'
    this.selectedPeer = null; // username of the Direct conversation shown
    this.username = null; // who is signed in
    this.allParticipants = [];
    this.messages = [];
    this.isPanelOpen = true;
    this.isChatTabActive = true; // the side panel's other tab is People
    this.publicUnread = 0;
    this.directUnread = new Map(); // lower-case username -> unread messages from that person
    this.directNames = new Map(); // lower-case username -> name, for everyone with a conversation
    this.lastRead = {}; // lower-case username -> time of the last message read, kept between calls
    this.rowMessages = new WeakMap(); // message row -> its message
    this.menu = null;
    this.scrollPending = false;

    this.init();
  }

  init() {
    this.modeSelect.addEventListener('change', () => {
      this.currentMode = this.modeSelect.value;
      this.markRead();
      this.renderView();
      this.updateRecipientsUI();
    });
    this.renderView();

    this.form.addEventListener('submit', e => {
      e.preventDefault();
      this.sendMessage();
    });

    this.container.addEventListener('contextmenu', e => this.openMessageMenu(e));
    this.input.addEventListener('contextmenu', e => this.openInputMenu(e));
    document.addEventListener('mousedown', e => {
      if (this.menu && !this.menu.contains(e.target)) this.closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeMenu();
    });
    this.container.addEventListener('scroll', () => this.closeMenu());
    window.addEventListener('blur', () => this.closeMenu());
    window.addEventListener('resize', () => this.closeMenu());
  }

  updateParticipants(participants, currentUserId) {
    this.allParticipants = participants.filter(u => u.id !== currentUserId);
    this.updateRecipientsUI();
  }

  // Who the other person in a direct message is; null for a public message
  static peerOf(msg, username, participants = []) {
    if (msg.mode !== 'direct') return null;
    const own = String(msg.senderUsername).toLowerCase() === String(username).toLowerCase();
    if (!own) return msg.senderUsername;
    return msg.recipientUsernames?.[0] || participants.find(u => u.id === msg.recipients?.[0])?.username || null;
  }

  // Unread messages per person in saved history: what arrived after the last one read
  static countUnread(messages, username, lastRead) {
    const unread = new Map();
    const me = String(username).toLowerCase();
    for (const msg of messages) {
      if (msg.mode !== 'direct' || String(msg.senderUsername).toLowerCase() === me) continue;
      const key = msg.senderUsername.toLowerCase();
      if (msg.timestamp > (lastRead[key] || 0)) unread.set(key, (unread.get(key) || 0) + 1);
    }
    return unread;
  }

  peerKeyOf(msg) {
    return ChatController.peerOf(msg, this.username, this.allParticipants)?.toLowerCase() || null;
  }

  belongsToView(msg) {
    if (this.currentMode === 'public') return msg.mode !== 'direct';
    return !!this.selectedPeer && msg.mode === 'direct' && this.peerKeyOf(msg) === this.selectedPeer.toLowerCase();
  }

  get isChatVisible() {
    return this.isPanelOpen && this.isChatTabActive;
  }

  // Shows only the conversation that is open
  renderView() {
    this.closeMenu();
    const rows = document.createDocumentFragment();
    for (const msg of this.messages) {
      if (!this.belongsToView(msg)) continue;
      const row = this.createMessageRow(msg, this.isOwnMessage(msg, this.username));
      row.classList.add('from-history');
      rows.appendChild(row);
    }
    this.container.replaceChildren(rows);
    this.container.dataset.empty = this.currentMode === 'public'
      ? EMPTY_PUBLIC
      : this.selectedPeer ? `No messages with ${this.selectedPeer} yet.` : EMPTY_NO_PERSON;
    this.scrollToBottom();
    this.updatePlaceholder();
  }

  updatePlaceholder() {
    if (this.currentMode === 'public') this.input.placeholder = 'Send a message…';
    else if (!this.selectedPeer) this.input.placeholder = 'Choose someone above…';
    else if (this.findParticipant(this.selectedPeer)) this.input.placeholder = `Message ${this.selectedPeer}…`;
    else this.input.placeholder = `${this.selectedPeer} is not in the room`;
  }

  findParticipant(name) {
    const key = String(name).toLowerCase();
    return this.allParticipants.find(u => u.username.toLowerCase() === key) || null;
  }

  selectPeer(name) {
    this.selectedPeer = name;
    this.markRead();
    this.renderView();
    this.updateRecipientsUI();
    if (!this.input.disabled) this.input.focus();
  }

  updateRecipientsUI() {
    this.updateBadges();
    if (this.currentMode === 'public') {
      this.recipientsBox.classList.add('hidden');
      return;
    }

    this.recipientsBox.classList.remove('hidden');
    this.recipientsList.innerHTML = '';

    // People in the room first, then anyone else with a conversation, so it can still be read
    const inRoom = this.allParticipants.map(u => u.username);
    const away = [...this.directNames.values()].filter(name => !this.findParticipant(name));
    if (inRoom.length === 0 && away.length === 0) {
      this.recipientsList.innerHTML = '<span class="field-hint">No one else is in the room yet</span>';
      return;
    }

    [...inRoom, ...away].forEach(name => {
      const key = name.toLowerCase();
      const present = !!this.findParticipant(name);
      const chip = document.createElement('div');
      chip.className = `chip ${this.selectedPeer?.toLowerCase() === key ? 'selected' : ''} ${present ? '' : 'away'}`;
      if (!present) chip.title = 'Not in the room: you can read your conversation';
      chip.textContent = name;
      const unread = this.directUnread.get(key);
      if (unread) {
        const badge = document.createElement('span');
        badge.className = 'unread-count';
        badge.textContent = ChatController.formatCount(unread);
        badge.title = `${unread} unread`;
        chip.appendChild(badge);
      }
      chip.addEventListener('click', () => this.selectPeer(name));
      this.recipientsList.appendChild(chip);
    });
  }

  static formatCount(count) {
    return count > 99 ? '99+' : String(count);
  }

  updateBadges() {
    let direct = 0;
    for (const count of this.directUnread.values()) direct += count;
    const show = (badge, count) => {
      if (!badge) return;
      badge.classList.toggle('hidden', count === 0);
      badge.textContent = ChatController.formatCount(count);
    };
    show(this.publicBadge, this.publicUnread);
    show(this.directBadge, direct);
    if (this.unreadBadge) this.unreadBadge.classList.toggle('hidden', this.publicUnread + direct === 0);
  }

  sendMessage() {
    const text = this.input.value.trim();
    if (!text) return;

    let recipients = [];
    if (this.currentMode !== 'public') {
      if (!this.selectedPeer) {
        this.onNotice('Choose who should receive this message first.');
        return;
      }
      const person = this.findParticipant(this.selectedPeer);
      if (!person) {
        this.onNotice(`${this.selectedPeer} is not in the room right now.`);
        return;
      }
      recipients = [person.id];
    }

    this.core.sendChatMessage({
      mode: this.currentMode,
      recipients,
      text
    });

    this.input.value = '';
    this.input.focus();
  }

  // By name, not connection id: saved messages keep the id of the session that sent them
  isOwnMessage(msg, username) {
    return String(msg.senderUsername).toLowerCase() === String(username).toLowerCase();
  }

  // Saved messages may be from another day
  formatTime(timestamp) {
    const sent = new Date(timestamp);
    const time = sent.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sent.toDateString() === new Date().toDateString()) return time;
    return `${sent.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }

  createMessageRow(msg, isOutgoing) {
    const row = document.createElement('div');
    row.className = `chat-row ${isOutgoing ? 'outgoing' : 'incoming'}`;

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;

    const modeLabels = {
      public: 'Public',
      direct: 'Direct'
    };

    bubble.innerHTML = `
      <div class="bubble-meta">
        <strong>${isOutgoing ? 'You' : this.escape(msg.senderUsername)}</strong>
        <div>
          <span class="chat-mode-badge">${modeLabels[msg.mode] || 'Msg'}</span>
          <span>${this.formatTime(msg.timestamp)}</span>
        </div>
      </div>
      <div class="bubble-text">${this.escape(msg.text)}</div>
    `;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chat-copy-btn';
    copyBtn.title = 'Copy message';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '<svg class="icon"><use href="#i-copy"></use></svg>';
    copyBtn.addEventListener('click', async () => {
      if (!(await this.copyText(msg.text))) return;
      copyBtn.classList.add('copied');
      copyBtn.querySelector('use').setAttribute('href', '#i-check');
      clearTimeout(copyBtn.copiedTimer);
      copyBtn.copiedTimer = setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.querySelector('use').setAttribute('href', '#i-copy');
      }, 1500);
    });

    row.append(bubble, copyBtn);
    this.rowMessages.set(row, msg);
    return row;
  }

  receiveMessage(msg, username) {
    this.username = username;
    this.messages.push(msg);
    const isOutgoing = this.isOwnMessage(msg, username);
    const peer = ChatController.peerOf(msg, username, this.allParticipants);
    if (peer) this.directNames.set(peer.toLowerCase(), peer);

    const inView = this.belongsToView(msg);
    if (inView) {
      // Someone reading older messages stays where they are
      const c = this.container;
      const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
      c.appendChild(this.createMessageRow(msg, isOutgoing));
      if (atBottom || isOutgoing) this.scrollToBottom();
    }

    if (inView && this.isChatVisible) {
      this.markRead();
    } else if (!isOutgoing) {
      if (peer) this.directUnread.set(peer.toLowerCase(), (this.directUnread.get(peer.toLowerCase()) || 0) + 1);
      else this.publicUnread++;
    }
    this.updateRecipientsUI();
  }

  // Sent by the server on every join, so it replaces what is shown instead of adding to it
  loadHistory(messages, username) {
    this.username = username;
    this.messages = messages.slice();
    this.lastRead = this.loadLastRead();
    this.directNames = new Map();
    for (const msg of messages) {
      const peer = ChatController.peerOf(msg, username, this.allParticipants);
      if (peer) this.directNames.set(peer.toLowerCase(), peer);
    }
    this.directUnread = ChatController.countUnread(messages, username, this.lastRead);
    this.publicUnread = 0;
    this.markRead();
    this.renderView();
    this.updateRecipientsUI();
  }

  // Kept per server and person, on this computer: the server does not know what has been read
  readStorageKey() {
    return `${READ_KEY}.${this.core?.ws?.url || ''}.${String(this.username).toLowerCase()}`;
  }

  loadLastRead() {
    try {
      return JSON.parse(localStorage.getItem(this.readStorageKey())) || {};
    } catch (e) {
      return {};
    }
  }

  saveLastRead() {
    try {
      localStorage.setItem(this.readStorageKey(), JSON.stringify(this.lastRead));
    } catch (e) {
      // not stored: the counts start over on the next join
    }
  }

  // A hidden chat has no height to scroll: it catches up when shown
  scrollToBottom() {
    this.scrollPending = this.container.clientHeight === 0;
    this.container.scrollTop = this.container.scrollHeight;
  }

  onChatShown() {
    if (this.scrollPending) this.scrollToBottom();
  }

  // The admin cleared the history in the management panel
  clearMessages() {
    this.closeMenu();
    this.messages = [];
    this.publicUnread = 0;
    this.directUnread = new Map();
    this.directNames = new Map();
    this.lastRead = {};
    this.saveLastRead();
    this.renderView();
    this.updateRecipientsUI();
  }

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      this.onNotice('Could not copy to the clipboard.');
      return false;
    }
  }

  // --- Right-click menu (the app has no built-in one) ---

  selectedChatText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return '';
    if (!this.container.contains(selection.anchorNode) || !this.container.contains(selection.focusNode)) return '';
    return selection.toString();
  }

  openMessageMenu(e) {
    const row = e.target.closest('.chat-row');
    const msg = row && this.rowMessages.get(row);
    const selected = this.selectedChatText(); // read now: it must still be what was highlighted when an item is chosen
    if (!msg && !selected) return;
    e.preventDefault();

    // Highlighted text: only copying that part. Otherwise the message itself.
    const items = [];
    if (selected) {
      items.push({ label: 'Copy', action: () => this.copyText(selected) });
    } else {
      if (!this.input.disabled) items.push({ label: 'Reply', action: () => this.reply(msg.text) });
      items.push({ label: 'Copy', action: () => this.copyText(msg.text) });
    }
    this.showMenu(items, e.clientX, e.clientY);
  }

  openInputMenu(e) {
    e.preventDefault();
    const input = this.input;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end);
    const replaceSelection = text => {
      input.setRangeText(text, start, end, 'end');
      input.focus();
    };

    this.showMenu([
      { label: 'Cut', disabled: !selected, action: async () => { if (await this.copyText(selected)) replaceSelection(''); } },
      { label: 'Copy', disabled: !selected, action: () => this.copyText(selected) },
      {
        label: 'Paste',
        action: async () => {
          try {
            replaceSelection(await navigator.clipboard.readText());
          } catch (err) {
            this.onNotice('Could not read the clipboard.');
          }
        }
      },
      { label: 'Select all', disabled: !input.value, action: () => { input.focus(); input.select(); } }
    ], e.clientX, e.clientY);
  }

  reply(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const quote = flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
    this.input.value = `"${quote}" ${this.input.value}`;
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  showMenu(items, x, y) {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'chat-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.disabled = !!item.disabled;
      button.addEventListener('mousedown', e => e.preventDefault()); // keeps the selection and the input's focus
      button.addEventListener('click', () => {
        this.closeMenu();
        item.action();
      });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    this.menu = menu;
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
  }

  setChatPermission(canChat) {
    if (canChat) {
      this.input.disabled = false;
      this.form.querySelector('button').disabled = false;
      this.revokedBanner.classList.add('hidden');
    } else {
      this.input.disabled = true;
      this.form.querySelector('button').disabled = true;
      this.revokedBanner.classList.remove('hidden');
    }
  }

  reset() {
    this.closeMenu();
    this.messages = [];
    this.selectedPeer = null;
    this.username = null;
    this.allParticipants = [];
    this.publicUnread = 0;
    this.directUnread = new Map();
    this.directNames = new Map();
    this.lastRead = {};
    this.renderView();
    this.updateRecipientsUI();
  }

  // The conversation on screen has been read
  markRead() {
    if (!this.isChatVisible) return;
    if (this.currentMode === 'public') {
      this.publicUnread = 0;
    } else if (this.selectedPeer) {
      const key = this.selectedPeer.toLowerCase();
      this.directUnread.delete(key);
      const latest = this.messages.reduce((time, m) => (m.mode === 'direct' && this.peerKeyOf(m) === key ? Math.max(time, m.timestamp) : time), 0);
      if (latest > (this.lastRead[key] || 0)) {
        this.lastRead[key] = latest;
        this.saveLastRead();
      }
    }
    this.updateRecipientsUI();
  }

  escape(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatController;
}
