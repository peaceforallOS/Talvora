/**
 * Room State, Participant Management & Music Lock Manager
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

function createIdleMusicState() {
  return {
    isPlaying: false,
    playedBy: null, // { id, username }
    trackInfo: null,
    currentTime: 0,
    startedAt: null
  };
}

// Keep only the fields clients render; audio must be an inline audio data URL
function sanitizeTrackInfo(trackInfo, fallbackArtist) {
  const info = trackInfo && typeof trackInfo === 'object' ? trackInfo : {};
  const clean = {
    title: typeof info.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 200) : 'Audio Stream',
    artist: typeof info.artist === 'string' && info.artist.trim() ? info.artist.trim().slice(0, 200) : fallbackArtist
  };
  if (typeof info.audioDataUrl === 'string' && info.audioDataUrl.startsWith('data:audio/')) {
    clean.audioDataUrl = info.audioDataUrl;
  }
  return clean;
}

class RoomManager {
  constructor(roomId = 'main-room') {
    this.roomId = roomId;
    this.participants = new Map(); // userId -> { id, username, role, permissions, mediaState, ws, joinedAt }
    this.musicState = createIdleMusicState();
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

    // If this user holds the music lock (playing or paused), release it
    if (this.musicState.playedBy?.id === id) {
      this.resetMusic();
    }

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
    if (!user.permissions.can_video) mediaState.video = false;

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
    if (!user.permissions.can_video) user.mediaState.video = false;

    // If music revoked and user holds the music lock, stop it
    if (!user.permissions.can_play_music && this.musicState.playedBy?.id === userId) {
      this.resetMusic();
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

  // --- Synchronized Music Playback Control ---

  resetMusic() {
    this.musicState = createIdleMusicState();
    this.broadcastMusicState();
  }

  broadcastMusicState() {
    this.broadcast({
      type: MessageType.MUSIC_STATE,
      musicState: this.getMusicStateForClient()
    });
  }

  // Includes the playback position at send time so clients need not trust their own clocks
  getMusicStateForClient() {
    return { ...this.musicState, position: this.getMusicPosition() };
  }

  // Current playback position in seconds
  getMusicPosition() {
    const { currentTime, startedAt, isPlaying } = this.musicState;
    const elapsed = isPlaying && startedAt ? (Date.now() - startedAt) / 1000 : 0;
    return (currentTime || 0) + elapsed;
  }

  // Music state without the (potentially huge) embedded audio payload, for polling clients
  getMusicSummary() {
    const { trackInfo } = this.musicState;
    return {
      ...this.musicState,
      trackInfo: trackInfo ? { title: trackInfo.title, artist: trackInfo.artist } : null
    };
  }

  startMusic(userId, trackInfo) {
    const user = this.participants.get(userId);
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    if (!user.permissions.can_play_music) {
      return { success: false, message: 'You do not have permission to play music.' };
    }

    // Check if another user holds the playback lock (a paused track still holds it)
    if (this.musicState.playedBy && this.musicState.playedBy.id !== userId) {
      return {
        success: false,
        message: `Only one person can play music at a time. Currently playing: ${this.musicState.playedBy.username}.`
      };
    }

    this.musicState = {
      isPlaying: true,
      playedBy: {
        id: user.id,
        username: user.username
      },
      trackInfo: sanitizeTrackInfo(trackInfo, user.username),
      currentTime: 0,
      startedAt: Date.now()
    };

    this.broadcastMusicState();

    return { success: true, musicState: this.musicState };
  }

  stopMusic(userId) {
    const user = this.participants.get(userId);
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    // Only the user currently playing OR the admin has authority to stop
    const isPlayer = this.musicState.playedBy && this.musicState.playedBy.id === userId;
    const isAdmin = user.role === Role.ADMIN;

    if (!isPlayer && !isAdmin) {
      return {
        success: false,
        message: 'Only the active player or an admin can stop music playback.'
      };
    }

    this.resetMusic();
    return { success: true, musicState: this.musicState };
  }

  pauseMusic(userId) {
    const user = this.participants.get(userId);
    if (!user) return { success: false, message: 'User not found' };

    const isPlayer = this.musicState.playedBy && this.musicState.playedBy.id === userId;
    const isAdmin = user.role === Role.ADMIN;

    if (!isPlayer && !isAdmin) {
      return { success: false, message: 'Permission denied.' };
    }

    if (!this.musicState.playedBy) {
      return { success: false, message: 'No music is currently playing.' };
    }

    // Freeze the position so clients (and a later seek/resume) know where playback stopped
    this.musicState.currentTime = this.getMusicPosition();
    this.musicState.isPlaying = false;
    this.musicState.startedAt = null;
    this.broadcastMusicState();

    return { success: true, musicState: this.musicState };
  }

  seekMusic(userId, time) {
    const user = this.participants.get(userId);
    if (!user) return { success: false, message: 'User not found' };

    const isPlayer = this.musicState.playedBy && this.musicState.playedBy.id === userId;
    const isAdmin = user.role === Role.ADMIN;

    if (!isPlayer && !isAdmin) {
      return { success: false, message: 'Permission denied.' };
    }

    if (!this.musicState.playedBy) {
      return { success: false, message: 'No music is currently playing.' };
    }

    this.musicState.currentTime = Math.max(0, Number(time) || 0);
    this.musicState.startedAt = this.musicState.isPlaying ? Date.now() : null;
    this.broadcastMusicState();

    return { success: true, musicState: this.musicState };
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
