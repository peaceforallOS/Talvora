/**
 * Shared Protocol, Token Security & Data Models
 * Talvora
 */

const crypto = require('crypto');

// Protocol Message Types
const MessageType = {
  // Client -> Server
  AUTH: 'auth',
  INVITE_GENERATE: 'invite_generate',
  CHAT_SEND: 'chat_send',
  MUSIC_ACTION: 'music_action',
  MEDIA_STATE_CHANGE: 'media_state_change',
  SIGNAL: 'signal',

  // Server -> Client
  AUTH_SUCCESS: 'auth_success',
  AUTH_ERROR: 'auth_error',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  ROOM_STATE: 'room_state',
  PERMISSIONS_UPDATED: 'permissions_updated',
  CHAT_DELIVER: 'chat_deliver',
  MUSIC_STATE: 'music_state',
  MUSIC_ERROR: 'music_error',
  INVITE_GENERATED: 'invite_generated',
  KICKED: 'kicked'
};

// Chat Modes
const ChatMode = {
  PUBLIC: 'public',
  DIRECT: 'direct',
  GROUP: 'group'
};

// Roles
const Role = {
  ADMIN: 'admin',
  USER: 'user'
};

// Default Permissions
function createDefaultPermissions(isAdmin = false) {
  return {
    can_audio: true,
    can_video: true,
    can_chat: true,
    can_play_music: true,
    can_invite: !!isAdmin // By default, only admin can invite
  };
}

/**
 * Base64 URL safe encode/decode
 */
function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Generate a cryptographically signed token binding username to roomId
 */
function generateToken({ roomId, username, role = Role.USER, canInvite = false, secret }) {
  if (!secret) throw new Error('Secret is required for token generation');
  const payload = {
    roomId: String(roomId).trim(),
    username: String(username).trim(),
    role,
    canInvite: !!canInvite,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex')
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${payloadB64}.${signature}`;
}

/**
 * Verify a token and assert that it matches the entered username.
 * If username and link do not match, returns a specific error.
 */
function verifyToken({ inputUsername, token, secret }) {
  if (!token || typeof token !== 'string') {
    return {
      valid: false,
      code: 'ERR_INVALID_TOKEN_FORMAT',
      message: 'Invalid link or token format.'
    };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return {
      valid: false,
      code: 'ERR_INVALID_TOKEN_FORMAT',
      message: 'Invalid link or token format.'
    };
  }

  const [payloadB64, signature] = parts;

  // Verify HMAC signature
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return {
      valid: false,
      code: 'ERR_TOKEN_SIGNATURE_INVALID',
      message: 'The token signature is invalid or has been tampered with.'
    };
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (err) {
    return {
      valid: false,
      code: 'ERR_MALFORMED_PAYLOAD',
      message: 'Token payload is malformed.'
    };
  }

  // Exact Username and Link validation (case-insensitive normalized)
  const canonicalEntered = String(inputUsername || '').trim().toLowerCase();
  const canonicalTokenUser = String(payload.username || '').trim().toLowerCase();

  if (!canonicalEntered || canonicalEntered !== canonicalTokenUser) {
    return {
      valid: false,
      code: 'ERR_CREDENTIAL_MISMATCH',
      message: 'Username and link do not match.',
      expectedUsername: payload.username,
      enteredUsername: inputUsername
    };
  }

  return {
    valid: true,
    payload
  };
}

module.exports = {
  MessageType,
  ChatMode,
  Role,
  createDefaultPermissions,
  generateToken,
  verifyToken,
  base64UrlEncode,
  base64UrlDecode
};
