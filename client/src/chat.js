/**
 * Chat Box Controller — Public, Direct & Group Messaging
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

    this.currentMode = 'public'; // 'public' | 'direct' | 'group'
    this.selectedRecipients = new Set();
    this.messages = [];
    this.isPanelOpen = true;
    this.unreadCount = 0;

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
        if (this.currentMode === 'direct') {
          // Direct is single selection
          this.selectedRecipients.clear();
          this.selectedRecipients.add(p.id);
        } else {
          // Group is multi-selection
          if (this.selectedRecipients.has(p.id)) {
            this.selectedRecipients.delete(p.id);
          } else {
            this.selectedRecipients.add(p.id);
          }
        }
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

  receiveMessage(msg, currentUserId) {
    this.messages.push(msg);
    const isOutgoing = msg.senderId === currentUserId;

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;

    const modeLabels = {
      public: 'Public',
      direct: 'Direct',
      group: 'Group'
    };

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div class="bubble-meta">
        <strong>${isOutgoing ? 'You' : this.escape(msg.senderUsername)}</strong>
        <div>
          <span class="chat-mode-badge">${modeLabels[msg.mode] || 'Msg'}</span>
          <span>${timeStr}</span>
        </div>
      </div>
      <div class="bubble-text">${this.escape(msg.text)}</div>
    `;

    this.container.appendChild(bubble);
    this.container.scrollTop = this.container.scrollHeight;

    if (!this.isPanelOpen && !isOutgoing) {
      this.unreadCount++;
      if (this.unreadBadge) {
        this.unreadBadge.classList.remove('hidden');
      }
    }
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
