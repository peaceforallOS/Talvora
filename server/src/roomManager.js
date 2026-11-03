/**
 * Room State & Participant Management
 */

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
const { MessageType, Role } = protocol;

// How long the others stay in the room after the admin leaves; the admin coming back in time keeps them
const ADMIN_GRACE_MS = 10 * 1000;

class RoomManager {
  constructor(roomId = 'main-room', { adminGraceMs = ADMIN_GRACE_MS } = {}) {
    this.roomId = roomId;
    this.participants = new Map(); // userId -> { id, username, role, permissions, mediaState, ws, joinedAt }
    this.onParticipantRemoved = null; // (user) => void, called after every leave or kick
    this.adminGraceMs = adminGraceMs;
    this.adminGraceTimer = null; // running while the admin is away and the others wait for them
  }

  // Invited users can only join (and stay) while the admin is in the room
  hasAdmin() {
    for (const user of this.participants.values()) {
      if (user.role === Role.ADMIN) return true;
    }
    return false;
  }

  notice(message, excludeId = null) {
    this.broadcast({ type: MessageType.ROOM_NOTICE, message }, excludeId);
  }

  startAdminGrace() {
    if (this.adminGraceTimer || this.participants.size === 0) return;
    const seconds = Math.round(this.adminGraceMs / 1000);
    this.notice(`The admin left the room. Everyone will be removed in ${seconds} seconds unless the admin comes back.`);
    this.adminGraceTimer = setTimeout(() => {
      this.adminGraceTimer = null;
      if (this.hasAdmin()) return;
      for (const id of [...this.participants.keys()]) {
        this.kickParticipant(id, 'The admin left the room.');
      }
    }, this.adminGraceMs);
    if (this.adminGraceTimer.unref) this.adminGraceTimer.unref();
  }

  cancelAdminGrace(adminId) {
    if (!this.adminGraceTimer) return;
    clearTimeout(this.adminGraceTimer);
    this.adminGraceTimer = null;
    this.notice('The admin is back.', adminId);
  }

  addParticipant({ id, username, role, permissions, ws }) {
    const user = {
      id,
      username,
      role: role || Role.USER,
      permissions: { ...permissions },
      mediaState: {
        audio: false,
        video: false,
        screen: false
      },
      // The stage: the admin is always on it; invited people join the audience, which sees and hears
      // the stage, and the admin brings them up (People list, or accepting a raised hand)
      onStage: (role || Role.USER) === Role.ADMIN,
      handRaised: false,
      ws,
      joinedAt: Date.now()
    };

    this.participants.set(id, user);

    // Notify others
    this.broadcast(
      {
        type: MessageType.USER_JOINED,
        user: this.getPublicUser(user)
      },
      id
    );
    if (user.role === Role.ADMIN) this.cancelAdminGrace(id);

    return user;
  }

  // replaced: the same person is joining again right away (another window), so the admin is not away
  removeParticipant(id, reason = 'disconnected', { replaced = false } = {}) {
    const user = this.participants.get(id);
    if (!user) return null;

    this.participants.delete(id);
    if (this.onParticipantRemoved) this.onParticipantRemoved(user);

    // Notify remaining participants
    this.broadcast({
      type: MessageType.USER_LEFT,
      userId: id,
      username: user.username,
      reason
    });

    if (user.role === Role.ADMIN && !replaced && !this.hasAdmin()) this.startAdminGrace();

    return user;
  }

  getParticipant(id) {
    return this.participants.get(id);
  }

  getParticipantByUsername(username) {
    const canonical = String(username).trim().toLowerCase();
    for (const user of this.participants.values()) {
      if (user.username.toLowerCase() === canonical) {
        return user;
      }
    }
    return null;
  }

  getPublicUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
      mediaState: user.mediaState,
      onStage: user.onStage,
      handRaised: user.handRaised,
      joinedAt: user.joinedAt
    };
  }

  getAllPublicUsers() {
    return Array.from(this.participants.values()).map(u => this.getPublicUser(u));
  }

  updateMediaState(userId, mediaState) {
    const user = this.participants.get(userId);
    if (!user) return null;

    // Enforce permission restrictions on media state; the audience sends nothing
    if (!user.onStage) mediaState.audio = mediaState.video = mediaState.screen = false;
    if (!user.permissions.can_audio) mediaState.audio = false;
    if (!user.permissions.can_video) mediaState.video = false;
    if (!user.permissions.can_screen) mediaState.screen = false;

    user.mediaState = { ...user.mediaState, ...mediaState };

    this.broadcast({
      type: MessageType.ROOM_STATE,
      action: 'media_state_change',
      userId,
      mediaState: user.mediaState
    });

    return user.mediaState;
  }

  updatePermissions(userId, newPermissions) {
    const user = this.participants.get(userId);
    if (!user) return null;

    user.permissions = { ...user.permissions, ...newPermissions };

    // If audio, video or screen sharing is revoked, enforce mediaState update immediately
    if (!user.permissions.can_audio) user.mediaState.audio = false;
    if (!user.permissions.can_video) user.mediaState.video = false;
    if (!user.permissions.can_screen) user.mediaState.screen = false;

    // Inform the user directly
    this.sendTo(userId, {
      type: MessageType.PERMISSIONS_UPDATED,
      userId,
      permissions: user.permissions
    });

    // Broadcast permission update to all room members
    this.broadcast({
      type: MessageType.ROOM_STATE,
      action: 'permissions_updated',
      userId,
      permissions: user.permissions,
      mediaState: user.mediaState
    });

    return user.permissions;
  }

  /**
   * Bring someone on stage or back to the audience (the admin stays on stage). Leaving the stage
   * turns their microphone, camera and screen sharing off; coming up lowers their hand.
   * Returns the participant's public state, or null.
   */
  setStage(userId, onStage) {
    const user = this.participants.get(userId);
    if (!user || user.role === Role.ADMIN) return null;
    user.onStage = !!onStage;
    user.handRaised = false;
    if (!user.onStage) user.mediaState = { audio: false, video: false, screen: false };
    this.broadcast({
      type: MessageType.ROOM_STATE,
      action: 'stage_changed',
      userId,
      onStage: user.onStage,
      handRaised: user.handRaised,
      mediaState: user.mediaState
    });
    return this.getPublicUser(user);
  }

  // Raise or lower a hand; only the audience raises hands (someone on stage has nothing to ask)
  setHand(userId, raised) {
    const user = this.participants.get(userId);
    if (!user || (raised && user.onStage) || user.handRaised === !!raised) return null;
    user.handRaised = !!raised;
    this.broadcast({
      type: MessageType.ROOM_STATE,
      action: 'hand_changed',
      userId,
      handRaised: user.handRaised
    });
    return this.getPublicUser(user);
  }

  kickParticipant(userId, reason = 'Kicked by admin', { replaced = false } = {}) {
    const user = this.participants.get(userId);
    if (!user) return false;

    // Send kick notification
    this.sendTo(userId, {
      type: MessageType.KICKED,
      reason
    });

    if (user.ws && user.ws.readyState === 1 /* OPEN */) {
      // WebSocket close reasons are limited to 123 bytes; the full reason went in the KICKED message
      user.ws.close(4001, Buffer.from(String(reason)).subarray(0, 123).toString().replace(/\uFFFD+$/, ''));
    }

    this.removeParticipant(userId, reason, { replaced });
    return true;
  }

  // --- Real-Time Messaging & Broadcast Helpers ---

  broadcast(message, excludeId = null) {
    const payload = JSON.stringify(message);
    for (const [id, user] of this.participants.entries()) {
      if (id !== excludeId && user.ws && user.ws.readyState === 1 /* OPEN */) {
        user.ws.send(payload);
      }
    }
  }

  sendTo(userId, message) {
    const user = this.participants.get(userId);
    if (user && user.ws && user.ws.readyState === 1) {
      user.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
}

module.exports = RoomManager;
