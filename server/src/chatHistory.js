/**
 * Chat History — saved in data/ so messages survive restarts and updates
 *
 * One message per line: sending appends a line instead of rewriting everything, and a line cut
 * short by a crash only loses that line. Direct messages are matched by username, because a
 * person's connection id changes every time they join.
 */

const fs = require('fs');

const MAX_MESSAGES = 5000; // the oldest go first, so the file and what a join downloads stay bounded
const COMPACT_MARGIN = 500; // rewrite the file only once in a while, not on every message
const QUOTE_LENGTH = 200; // of a replied-to message, kept in the reply so it survives the original being dropped

class ChatHistory {
  constructor({ file, maxMessages = MAX_MESSAGES } = {}) {
    this.file = file;
    this.maxMessages = maxMessages;
    this.messages = [];
    this.load();
  }

  load() {
    let lines;
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n');
    } catch (e) {
      return; // nothing saved yet
    }
    for (const line of lines) {
      if (!line) continue;
      try {
        this.messages.push(JSON.parse(line));
      } catch (e) {
        // a line cut short by a crash
      }
    }
    if (this.messages.length > this.maxMessages) this.compact();
  }

  add(message) {
    this.messages.push(message);
    if (this.messages.length >= this.maxMessages + COMPACT_MARGIN) {
      this.compact();
      return;
    }
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    } catch (err) {
      console.error(`Could not save a chat message: ${err.message}`);
    }
  }

  compact() {
    this.messages = this.messages.slice(-this.maxMessages);
    try {
      const body = this.messages.map(m => `${JSON.stringify(m)}\n`).join('');
      fs.writeFileSync(`${this.file}.tmp`, body, { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error(`Could not save the chat history: ${err.message}`);
    }
  }

  // Everything public, plus the direct messages this person sent or received
  visibleTo(username) {
    const canonical = String(username).toLowerCase();
    const isThem = name => String(name).toLowerCase() === canonical;
    return this.messages.slice(-this.maxMessages).filter(m =>
      m.mode !== 'direct' || isThem(m.senderUsername) || (m.recipientUsernames || []).some(isThem));
  }

  /**
   * The quote for a reply, built here so it always matches the saved message, or null. Only a message
   * from the same conversation can be quoted: a reply must not carry a direct message anywhere else.
   */
  quoteFor(id, { mode, username, peerUsername }) {
    if (typeof id !== 'string') return null;
    const original = this.messages.find(m => m.id === id);
    if (!original || original.mode !== mode) return null;
    if (mode === 'direct') {
      const pair = names => names.map(name => String(name).toLowerCase()).sort().join('\n');
      const between = pair([original.senderUsername, ...(original.recipientUsernames || [])]);
      if (between !== pair([username, peerUsername])) return null;
    }
    const flat = String(original.text).replace(/\s+/g, ' ').trim();
    return {
      id: original.id,
      senderUsername: original.senderUsername,
      text: flat.length > QUOTE_LENGTH ? `${flat.slice(0, QUOTE_LENGTH)}…` : flat
    };
  }

  get count() {
    return Math.min(this.messages.length, this.maxMessages);
  }

  // Throws if the file cannot be deleted: the admin must not be told it is gone when it is not
  clear() {
    fs.rmSync(this.file, { force: true });
    this.messages = [];
  }
}

module.exports = ChatHistory;
