/**
 * Server Authentication & Token Management Service
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt); // runs on the thread pool, never blocking calls in progress
let protocol;
try {
  protocol = require('../../shared/protocol');
} catch (e) {
  try {
    protocol = require('../shared/protocol');
  } catch (e2) {
    protocol = require('./shared/protocol');
  }
}
const {
  Role,
  generateToken,
  verifyToken,
  createDefaultPermissions
} = protocol;

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../data/server-config.json');

class AuthService {
  constructor(options = {}) {
    this.configPath = options.configPath || process.env.VIDEOCALL_CONFIG || DEFAULT_CONFIG_PATH;
    this.roomId = options.roomId || 'main-room';
    this.adminUsername = options.adminUsername || 'Admin';
    this.secret = null;
    this.adminToken = null;
    this.createdAt = null;
    this.revokedUsers = Object.create(null); // canonical username -> time (ms) before which their links are void
    this.permissionOverrides = Object.create(null); // canonical username -> permissions the admin changed, kept across rejoins
    this.adminPassword = null; // { salt, hash } (scrypt) protecting the management panel
    this.setupToken = null; // one-time secret in the first-visit panel link; gone once a password is set
    this.configMtime = 0; // to notice changes made by `videocall-server reset-password`
    this.authChangePending = false; // this process changed the password: disk must not override it
    this.linkSuffix = () => ''; // extra join-link parameters (the HTTPS CA fingerprint, see index.js)
    this.init();
  }

  init() {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (dir === path.dirname(DEFAULT_CONFIG_PATH)) {
      fs.chmodSync(dir, 0o700); // the server secret, panel password hash and TLS keys live here
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.secret = data.serverSecret;
        this.roomId = data.roomId || this.roomId;
        this.adminUsername = data.adminUsername || this.adminUsername;
        this.createdAt = data.createdAt || null;
        this.applyDiskState(data);
        this.configMtime = fs.statSync(this.configPath).mtimeMs;
      } catch (e) {
        console.warn('Could not read existing config, generating new configuration.');
      }
    }

    if (!this.secret || (!this.adminPassword && !this.setupToken)) {
      this.secret = this.secret || crypto.randomBytes(32).toString('hex');
      if (!this.adminPassword) this.setupToken = crypto.randomBytes(24).toString('hex');
      this.saveConfig();
    }

    // Provision admin token
    this.adminToken = generateToken({
      roomId: this.roomId,
      username: this.adminUsername,
      role: Role.ADMIN,
      canInvite: true,
      secret: this.secret
    });
  }

  // Panel password, setup token and revocations as stored on disk
  applyDiskState(data) {
    const pw = data.adminPassword;
    this.adminPassword = pw && typeof pw.salt === 'string' && typeof pw.hash === 'string'
      ? { salt: pw.salt, hash: pw.hash }
      : null;
    this.setupToken = typeof data.setupToken === 'string' ? data.setupToken : null;
    if (data.revokedUsers && typeof data.revokedUsers === 'object') {
      for (const [name, revokedAt] of Object.entries(data.revokedUsers)) {
        if (typeof revokedAt === 'number') this.revokedUsers[name] = Math.max(revokedAt, this.revokedUsers[name] || 0);
      }
    }
    if (data.permissionOverrides && typeof data.permissionOverrides === 'object') {
      for (const [name, perms] of Object.entries(data.permissionOverrides)) {
        // Only this process changes permissions: what it holds is never older than the disk
        if (perms && typeof perms === 'object' && !(name in this.permissionOverrides)) {
          this.permissionOverrides[name] = { ...perms };
        }
      }
    }
  }

  readConfigFile() {
    try {
      return { data: JSON.parse(fs.readFileSync(this.configPath, 'utf8')), mtime: fs.statSync(this.configPath).mtimeMs };
    } catch (e) {
      return null;
    }
  }

  /**
   * Pick up changes another process made to the config (a password reset while the server runs).
   * Returns true when the panel password changed, so existing panel sessions must end.
   */
  syncFromDisk() {
    let mtime;
    try {
      mtime = fs.statSync(this.configPath).mtimeMs;
    } catch (e) {
      return false;
    }
    if (mtime === this.configMtime) return false;
    const disk = this.readConfigFile();
    if (!disk) return false;
    const before = this.adminPassword?.hash;
    this.applyDiskState(disk.data);
    this.configMtime = disk.mtime;
    return this.adminPassword?.hash !== before;
  }

  saveConfig() {
    // Merge with what is on disk so concurrent writers (server and reset tool) never undo each other
    const disk = this.readConfigFile();
    if (disk && disk.mtime !== this.configMtime) {
      const { adminPassword, setupToken } = this;
      this.applyDiskState(disk.data);
      if (this.authChangePending) Object.assign(this, { adminPassword, setupToken });
    }
    const data = {
      serverSecret: this.secret,
      roomId: this.roomId,
      adminUsername: this.adminUsername,
      createdAt: this.createdAt || (this.createdAt = new Date().toISOString()),
      revokedUsers: this.revokedUsers,
      permissionOverrides: this.permissionOverrides,
      adminPassword: this.adminPassword,
      setupToken: this.setupToken
    };
    // Holds the server secret and the panel password hash: readable by the owner only.
    // Written to a temporary file and renamed, so readers never see a half-written file.
    const tmpPath = `${this.configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, this.configPath);
    this.configMtime = fs.statSync(this.configPath).mtimeMs;
    this.authChangePending = false;
  }

  // --- Management panel password ---

  hasAdminPassword() {
    return !!this.adminPassword;
  }

  validateSetupToken(token) {
    if (!this.setupToken || typeof token !== 'string') return false;
    const expected = Buffer.from(this.setupToken);
    const actual = Buffer.from(token);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async setAdminPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(String(password), salt, 64)).toString('hex');
    const previous = { adminPassword: this.adminPassword, setupToken: this.setupToken };
    this.adminPassword = { salt, hash };
    this.setupToken = null; // the first-visit link stops working
    this.authChangePending = true;
    try {
      this.saveConfig();
    } catch (err) {
      Object.assign(this, previous, { authChangePending: false });
      throw err;
    }
  }

  async verifyAdminPassword(password) {
    const stored = this.adminPassword;
    if (!stored || typeof password !== 'string') return false;
    const expected = Buffer.from(stored.hash, 'hex');
    const actual = await scrypt(password, stored.salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  // Forgotten password: back to first-visit setup with a fresh one-time link
  clearAdminPassword() {
    this.adminPassword = null;
    this.setupToken = crypto.randomBytes(24).toString('hex');
    this.authChangePending = true;
    this.saveConfig();
  }

  getAdminToken() {
    return this.adminToken;
  }

  /**
   * Generate an invite link strictly locked to a target username
   */
  generateInviteLink({ baseUrl, targetUsername, role = Role.USER, canInvite = false }) {
    if (!targetUsername || !targetUsername.trim()) {
      throw new Error('Target username is required');
    }

    const token = generateToken({
      roomId: this.roomId,
      username: targetUsername.trim(),
      role,
      canInvite: !!canInvite,
      secret: this.secret
    });

    const cleanBase = baseUrl.replace(/\/+$/, '');
    const joinLink = `${cleanBase}/join?room=${encodeURIComponent(this.roomId)}&user=${encodeURIComponent(targetUsername.trim())}&token=${encodeURIComponent(token)}${this.linkSuffix()}`;

    return {
      username: targetUsername.trim(),
      token,
      roomId: this.roomId,
      joinLink
    };
  }

  getAdminCredentials(baseUrl) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const adminLink = `${cleanBase}/join?room=${encodeURIComponent(this.roomId)}&user=${encodeURIComponent(this.adminUsername)}&token=${encodeURIComponent(this.adminToken)}${this.linkSuffix()}`;
    // Until a panel password is chosen, the panel link carries the one-time setup token
    const panelUrl = this.setupToken
      ? `${cleanBase}/admin?setup=${encodeURIComponent(this.setupToken)}`
      : `${cleanBase}/admin`;

    return {
      adminUsername: this.adminUsername,
      roomId: this.roomId,
      adminToken: this.adminToken,
      adminLink,
      panelUrl
    };
  }

  /**
   * Invalidate every link issued to a user so far. Links generated afterwards work again.
   */
  revokeUser(username) {
    const canonical = String(username || '').trim().toLowerCase();
    if (!canonical) throw new Error('Username is required');
    if (canonical === this.adminUsername.toLowerCase()) {
      throw new Error('The room administrator cannot be removed.');
    }
    const previous = this.revokedUsers[canonical];
    this.revokedUsers[canonical] = Date.now();
    try {
      this.saveConfig();
    } catch (err) {
      // Not persisted: do not leave a revocation that would vanish on restart
      if (previous === undefined) delete this.revokedUsers[canonical];
      else this.revokedUsers[canonical] = previous;
      throw err;
    }
  }

  /**
   * Remember permissions the admin set for a user, so rejoining with the same link keeps them
   */
  setPermissionOverrides(username, permissions) {
    const canonical = String(username || '').trim().toLowerCase();
    if (!canonical) throw new Error('Username is required');
    const previous = this.permissionOverrides[canonical];
    this.permissionOverrides[canonical] = { ...previous, ...permissions };
    try {
      this.saveConfig();
    } catch (err) {
      if (previous === undefined) delete this.permissionOverrides[canonical];
      else this.permissionOverrides[canonical] = previous;
      throw err;
    }
  }

  isUsernameRevoked(username) {
    return String(username || '').trim().toLowerCase() in this.revokedUsers;
  }

  isRevoked(payload) {
    const revokedAt = this.revokedUsers[String(payload.username || '').trim().toLowerCase()];
    return revokedAt !== undefined && !(Number(payload.issuedAt) > revokedAt);
  }

  /**
   * Validate join credentials. Returns result with user details or mismatch error.
   */
  validateJoin({ inputUsername, token }) {
    const res = verifyToken({
      inputUsername,
      token,
      secret: this.secret
    });

    if (!res.valid) {
      return {
        success: false,
        code: res.code,
        message: res.message
      };
    }

    const payload = res.payload;
    if (payload.roomId !== this.roomId) {
      return {
        success: false,
        code: 'ERR_ROOM_MISMATCH',
        message: 'This link was issued for a different room.'
      };
    }

    if (this.isRevoked(payload)) {
      return {
        success: false,
        code: 'ERR_LINK_REVOKED',
        message: 'You have been removed from this room. This invite link no longer works.'
      };
    }

    const isAdmin = payload.role === Role.ADMIN;
    const permissions = createDefaultPermissions(isAdmin);
    if (payload.canInvite) {
      permissions.can_invite = true;
    }
    // Changes the admin made win over the defaults and the link's own invite flag
    Object.assign(permissions, this.permissionOverrides[String(payload.username).trim().toLowerCase()]);

    return {
      success: true,
      user: {
        username: payload.username,
        role: payload.role,
        roomId: payload.roomId,
        permissions
      }
    };
  }
}

module.exports = AuthService;
