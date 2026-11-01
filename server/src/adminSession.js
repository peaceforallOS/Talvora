/**
 * Management Panel Sessions — password login, browser-session cookies and login throttling
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

const COOKIE_NAME = 'vc_admin_session';
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // signed out 3 hours after logging in, active or not
// An open panel polls every few seconds; a quiet session means the browser or tab is gone.
// Browsers that restore their previous session also restore session cookies, so this is what
// reliably ends a session after the browser was closed.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const FREE_ATTEMPTS = 5; // wrong passwords allowed before lockouts start
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const FAILURE_MEMORY_MS = 24 * 60 * 60 * 1000; // wrong passwords are forgotten after a quiet day
const MAX_CONCURRENT_LOGINS = 4; // password hashing is deliberately slow; never queue up floods

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

// One lockout bucket per IPv4 address or per IPv6 /64 (one home or server gets a whole /64)
function clientKey(address) {
  const ip = String(address || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups = [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Sessions are kept by the SHA-256 of their cookie value, so the saved file holds no usable cookie
const sessionKey = id => crypto.createHash('sha256').update(String(id)).digest('hex');

class AdminSessions {
  /**
   * file: where sessions are kept across restarts (so updating the server from the panel does not
   * sign the admin out); without it they live in memory only
   */
  constructor({ ttlMs = SESSION_TTL_MS, idleMs = IDLE_TIMEOUT_MS, secureCookie = false, file = null } = {}) {
    this.ttlMs = ttlMs;
    this.idleMs = idleMs;
    this.secureCookie = secureCookie;
    this.file = file;
    this.sessions = new Map(); // SHA-256 of session id -> { expiresAt, lastSeen }
    this.failures = new Map(); // client key -> { count, lockedUntil, lastFailure }
    this.inFlight = new Set(); // client keys with a login being checked
    this.load();
  }

  // Saved sessions count as active from the restart on: the idle limit starts again
  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [key, expiresAt] of Object.entries(saved)) {
        if (/^[0-9a-f]{64}$/.test(key) && Number.isFinite(expiresAt) && expiresAt > now) this.sessions.set(key, { expiresAt, lastSeen: now });
      }
    } catch (e) {
      // none saved yet
    }
  }

  save() {
    if (!this.file) return;
    try {
      const saved = Object.fromEntries([...this.sessions].map(([key, s]) => [key, s.expiresAt]));
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      // not writable: sessions still work until the next restart
    }
  }

  static validateNewPassword(password, confirm) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
    }
    if (password !== confirm) return 'The two passwords do not match.';
    return null;
  }

  cookieAttributes() {
    return `HttpOnly; SameSite=Strict; Path=/${this.secureCookie ? '; Secure' : ''}`;
  }

  /**
   * Start a session; returns the Set-Cookie header value. The cookie has no Expires/Max-Age,
   * so the browser discards it when it is closed; the server enforces the time limits.
   */
  create() {
    this.prune();
    const id = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.sessions.set(sessionKey(id), { expiresAt, lastSeen: now });
    this.save();
    return { cookie: `${COOKIE_NAME}=${id}; ${this.cookieAttributes()}`, expiresAt };
  }

  // Expiry time of the request's session (and marks it as active), or null when there is none
  get(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const key = id ? sessionKey(id) : null;
    const session = key ? this.sessions.get(key) : undefined;
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt <= now || now - session.lastSeen > this.idleMs) {
      this.sessions.delete(key);
      this.save();
      return null;
    }
    session.lastSeen = now;
    return session.expiresAt;
  }

  // Ends the request's session; returns a Set-Cookie header value that clears the cookie
  destroy(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (id && this.sessions.delete(sessionKey(id))) this.save();
    return `${COOKIE_NAME}=; ${this.cookieAttributes()}; Max-Age=0`;
  }

  destroyAll() {
    this.sessions.clear();
    this.save();
  }

  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now || now - session.lastSeen > this.idleMs) this.sessions.delete(id);
    }
    for (const [key, entry] of this.failures) {
      if (now - entry.lastFailure > FAILURE_MEMORY_MS) this.failures.delete(key);
    }
  }

  // --- Brute-force protection ---

  /**
   * Reserve a password check for this client before reading the request body, so parallel
   * requests cannot slip past the lockout. Returns null when allowed, or a reason to refuse.
   * Every successful reservation must be followed by finishAttempt().
   */
  beginAttempt(address) {
    const key = clientKey(address);
    const entry = this.failures.get(key);
    const wait = entry ? entry.lockedUntil - Date.now() : 0;
    if (wait > 0) return `Too many wrong passwords. Try again in ${Math.ceil(wait / 1000)} seconds.`;
    if (this.inFlight.has(key) || this.inFlight.size >= MAX_CONCURRENT_LOGINS) {
      return 'Another sign-in attempt is in progress. Please try again in a moment.';
    }
    this.inFlight.add(key);
    return null;
  }

  finishAttempt(address, success) {
    const key = clientKey(address);
    this.inFlight.delete(key);
    if (success === undefined) return; // nothing was checked (bad request)
    if (success) {
      this.failures.delete(key);
      return;
    }
    const now = Date.now();
    let entry = this.failures.get(key);
    if (!entry || now - entry.lastFailure > FAILURE_MEMORY_MS) entry = { count: 0, lockedUntil: 0, lastFailure: now };
    entry.count++;
    entry.lastFailure = now;
    if (entry.count >= FREE_ATTEMPTS) {
      entry.lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (entry.count - FREE_ATTEMPTS));
    }
    this.failures.set(key, entry);
    if (this.failures.size > 10000) this.prune();
  }
}

AdminSessions.clientKey = clientKey;
module.exports = AdminSessions;
