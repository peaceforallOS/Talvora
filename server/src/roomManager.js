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

class RoomManager {
  constructor(roomId = 'main-room') {
    this.roomId = roomId;
    this.participants = new Map(); // userId -> { id, username, role, permissions, mediaState, ws, joinedAt }
    this.onParticipantRemoved = null; // (user) => void, called after every leave or kick
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

    return user;
  }

  removeParticipant(id, reason = 'disconnected') {
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
      joinedAt: user.joinedAt
    };
  }

  getAllPublicUsers() {
    return Array.from(this.participants.values()).map(u => this.getPublicUser(u));
  }

  updateMediaState(userId, mediaState) {
    const user = this.participants.get(userId);
    if (!user) return null;

    // Enforce permission restrictions on media state
    if (!user.permissions.can_audio) mediaState.audio = false;
    if (!user.permissions.can_video) {
      mediaState.video = false;
      mediaState.screen = false;
    }

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

    // If audio/video revoked, enforce mediaState update immediately
    if (!user.permissions.can_audio) user.mediaState.audio = false;
    if (!user.permissions.can_video) {
      user.mediaState.video = false;
      user.mediaState.screen = false;
    }

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

  kickParticipant(userId, reason = 'Kicked by admin') {
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

    this.removeParticipant(userId, reason);
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

  sendToMultiple(userIds, message) {
    const payload = JSON.stringify(message);
    for (const id of userIds) {
      const user = this.participants.get(id);
      if (user && user.ws && user.ws.readyState === 1) {
        user.ws.send(payload);
      }
    }
  }
}

module.exports = RoomManager;
