/**
 * Chat Box Controller — Public & Direct Messaging
 */

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
    this.onNotice = options.onNotice || (() => {}); // shown in the app, never as a native alert()

    this.currentMode = 'public'; // 'public' | 'direct'
    this.selectedRecipients = new Set();
    this.messages = [];
    this.isPanelOpen = true;
    this.unreadCount = 0;
    this.rowMessages = new WeakMap(); // message row -> its message
    this.menu = null;
    this.scrollPending = false;

    this.init();
  }

  init() {
    this.modeSelect.addEventListener('change', () => {
      this.currentMode = this.modeSelect.value;
      this.updateRecipientsUI();
    });

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
    for (const id of this.selectedRecipients) {
      if (!this.allParticipants.some(u => u.id === id)) this.selectedRecipients.delete(id);
    }
    this.updateRecipientsUI();
  }

  updateRecipientsUI() {
    if (this.currentMode === 'public') {
      this.recipientsBox.classList.add('hidden');
      this.selectedRecipients.clear();
      return;
    }

    this.recipientsBox.classList.remove('hidden');
    this.recipientsList.innerHTML = '';

    if (!this.allParticipants || this.allParticipants.length === 0) {
      this.recipientsList.innerHTML = '<span class="field-hint">No one else is in the room yet</span>';
      return;
    }

    this.allParticipants.forEach(p => {
      const chip = document.createElement('div');
      chip.className = `chip ${this.selectedRecipients.has(p.id) ? 'selected' : ''}`;
      chip.textContent = p.username;
      chip.addEventListener('click', () => {
        // A direct message goes to one person
        this.selectedRecipients.clear();
        this.selectedRecipients.add(p.id);
        this.updateRecipientsUI();
      });
      this.recipientsList.appendChild(chip);
    });
  }

  sendMessage() {
    const text = this.input.value.trim();
    if (!text) return;

    if (this.currentMode !== 'public' && this.selectedRecipients.size === 0) {
      this.onNotice('Choose who should receive this message first.');
      return;
    }

    const recipients = Array.from(this.selectedRecipients);
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
    this.messages.push(msg);
    const isOutgoing = this.isOwnMessage(msg, username);

    // Someone reading older messages stays where they are
    const c = this.container;
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
    c.appendChild(this.createMessageRow(msg, isOutgoing));
    if (atBottom || isOutgoing) this.scrollToBottom();

    if (!this.isPanelOpen && !isOutgoing) {
      this.unreadCount++;
      if (this.unreadBadge) {
        this.unreadBadge.classList.remove('hidden');
      }
    }
  }

  // Sent by the server on every join, so it replaces what is shown instead of adding to it
  loadHistory(messages, username) {
    this.closeMenu();
    this.messages = messages.slice();
    const rows = document.createDocumentFragment();
    for (const msg of messages) {
      const row = this.createMessageRow(msg, this.isOwnMessage(msg, username));
      row.classList.add('from-history');
      rows.appendChild(row);
    }
    this.container.replaceChildren(rows);
    this.scrollToBottom();
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
    this.container.innerHTML = '';
    this.markRead();
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

    const items = [{ label: 'Copy', disabled: !selected, action: () => this.copyText(selected) }];
    if (msg) {
      items.push({ label: 'Copy message', action: () => this.copyText(msg.text) });
      items.push({ label: 'Select message', action: () => this.selectMessage(row) });
      if (!this.input.disabled) {
        items.push({ label: 'Quote in reply', action: () => this.quoteInReply(selected || msg.text) });
      }
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

  selectMessage(row) {
    const range = document.createRange();
    range.selectNodeContents(row.querySelector('.bubble-text'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  quoteInReply(text) {
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
    this.container.innerHTML = '';
    this.selectedRecipients.clear();
    this.allParticipants = [];
    this.markRead();
    this.updateRecipientsUI();
  }

  markRead() {
    this.unreadCount = 0;
    if (this.unreadBadge) {
      this.unreadBadge.classList.add('hidden');
    }
  }

  escape(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatController;
}
