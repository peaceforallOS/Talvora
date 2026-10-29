/**
 * Server History — servers this user joined before, for one-click reconnects and reachability checks
 */

const SERVER_HISTORY_KEY = 'vc_server_history';
const MAX_SERVER_HISTORY = 12;
const PING_TIMEOUT_MS = 4000;

class ServerHistory {
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.storage = storage;
  }

  // Server origin (e.g. http://192.168.1.10:8080) of a join link, or null
  static serverOf(link) {
    try {
      const url = new URL(String(link).trim());
      return /^https?:$/.test(url.protocol) ? url.origin : null;
    } catch (e) {
      return null;
    }
  }

  // Newest first: [{ server, username, link, roomId, lastConnected }]
  list() {
    try {
      const entries = JSON.parse(this.storage?.getItem(SERVER_HISTORY_KEY) || '[]');
      return Array.isArray(entries)
        ? entries.filter(e => e && typeof e.server === 'string' && typeof e.username === 'string' && typeof e.link === 'string')
        : [];
    } catch (e) {
      return [];
    }
  }

  save(entries) {
    try {
      this.storage?.setItem(SERVER_HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_SERVER_HISTORY)));
    } catch (e) {
      // storage full or unavailable: history is a convenience only
    }
  }

  static sameEntry(a, b) {
    return a.server === b.server && a.username.toLowerCase() === b.username.toLowerCase();
  }

  // Remember a successful join (one entry per server and username, newest first)
  record({ username, link, roomId }) {
    const server = ServerHistory.serverOf(link);
    if (!server || !username) return null;
    const entry = { server, username: username.trim(), link: link.trim(), roomId: roomId || null, lastConnected: Date.now() };
    this.save([entry, ...this.list().filter(e => !ServerHistory.sameEntry(e, entry))]);
    return entry;
  }

  remove(entry) {
    this.save(this.list().filter(e => !ServerHistory.sameEntry(e, entry)));
  }

  /**
   * Check whether a server answers. Resolves { online: true, ms } or { online: false, reason }.
   */
  static async ping(server, fetchImpl = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const started = performance.now();
    try {
      const res = await fetchImpl(`${server}/api/health`, { cache: 'no-store', signal: controller.signal });
      const ms = Math.round(performance.now() - started);
      if (!res.ok) return { online: false, reason: `Server error (${res.status})` };
      return { online: true, ms };
    } catch (e) {
      return { online: false, reason: e.name === 'AbortError' ? 'No response' : 'Unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ServerHistory;
}
