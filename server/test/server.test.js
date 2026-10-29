/**
 * Section 2 Integration Test
 * Tests Server Initialization, Strict Username-Link Binding, Music Concurrency Lock & Permissions
 */

const assert = require('assert');
const { WebSocket } = require('ws');
const { MessageType, Role, ChatMode } = require('../../shared/protocol');

process.env.PORT = '8099';
// Use a throwaway server config, never the real one
process.env.VIDEOCALL_CONFIG = require('path').join(require('os').tmpdir(), `videocall-test-${process.pid}.json`);
process.on('exit', () => require('fs').rmSync(process.env.VIDEOCALL_CONFIG, { force: true }));
const { server, authService, roomManager } = require('../src/index');

const WS_URL = 'ws://localhost:8099';

function createWsClient() {
  return new WebSocket(WS_URL);
}

function waitForMessage(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);

    const onMessage = raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (!type || data.type === type) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(data);
        }
      } catch (e) {}
    };

    ws.on('message', onMessage);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('--- Starting Section 2 Integration Tests ---');

  // Test 1: Verify Admin credentials generated on startup
  const creds = authService.getAdminCredentials('http://localhost:8099');
  assert.ok(creds.adminUsername === 'Admin', 'Admin username check failed');
  assert.ok(/\/admin\?setup=[0-9a-f]{48}$/.test(creds.panelUrl), 'Admin panel URL check failed');
  assert.ok(creds.adminLink.includes('/join?room='), 'Admin join link check failed');
  console.log('✓ Test 1 Passed: Admin panel URL and login link generated successfully');

  // Test 2: Admin joins via WebSocket
  const adminWs = createWsClient();
  await new Promise(r => adminWs.on('open', r));

  adminWs.send(JSON.stringify({
    type: MessageType.AUTH,
    username: 'Admin',
    token: creds.adminToken
  }));

  const adminAuthMsg = await waitForMessage(adminWs, MessageType.AUTH_SUCCESS);
  assert.ok(adminAuthMsg.user.role === Role.ADMIN, 'Admin role check failed');
  assert.ok(adminAuthMsg.user.permissions.can_invite === true, 'Admin can_invite check failed');
  console.log('✓ Test 2 Passed: Admin authenticated and joined room');

  // Test 3: Admin generates invite link for "Omid"
  adminWs.send(JSON.stringify({
    type: MessageType.INVITE_GENERATE,
    targetUsername: 'Omid'
  }));

  const inviteMsg = await waitForMessage(adminWs, MessageType.INVITE_GENERATED);
  assert.ok(inviteMsg.username === 'Omid', 'Invite username mismatch');
  assert.ok(inviteMsg.joinLink.includes('user=Omid'), 'Invite link does not contain Omid');
  const omidToken = inviteMsg.token;
  console.log('✓ Test 3 Passed: Invite link generated specifically for Omid');

  // Test 4: "Ali" tries to join with Omid's link -> MUST BE REJECTED
  const aliWs = createWsClient();
  await new Promise(r => aliWs.on('open', r));

  aliWs.send(JSON.stringify({
    type: MessageType.AUTH,
    username: 'Ali',
    token: omidToken
  }));

  const aliAuthError = await waitForMessage(aliWs, MessageType.AUTH_ERROR);
  assert.ok(aliAuthError.code === 'ERR_CREDENTIAL_MISMATCH', 'Mismatch code check failed');
  assert.ok(aliAuthError.message === 'Username and link do not match.', 'Mismatch message check failed');
  console.log('✓ Test 4 Passed: Ali entering Omid link was rejected with "Username and link do not match."');
  aliWs.close();

  // Test 5: "Omid" joins with Omid's link -> MUST SUCCEED
  const omidWs = createWsClient();
  await new Promise(r => omidWs.on('open', r));

  omidWs.send(JSON.stringify({
    type: MessageType.AUTH,
    username: 'Omid',
    token: omidToken
  }));

  const omidAuthSuccess = await waitForMessage(omidWs, MessageType.AUTH_SUCCESS);
  assert.ok(omidAuthSuccess.user.username === 'Omid', 'Omid username mismatch');
  console.log('✓ Test 5 Passed: Omid successfully joined room with matching credentials');

  // Test 6: Music exclusivity and Admin authority
  // Omid starts music
  omidWs.send(JSON.stringify({
    type: MessageType.MUSIC_ACTION,
    action: 'play',
    trackInfo: { title: 'Track 1', artist: 'Omid' }
  }));

  const musicState1 = await waitForMessage(omidWs, MessageType.MUSIC_STATE);
  assert.ok(musicState1.musicState.isPlaying === true, 'Music should be playing');
  assert.ok(musicState1.musicState.playedBy.username === 'Omid', 'Music playedBy check failed');
  console.log('✓ Test 6a Passed: Omid started music, gained playback lock');

  // Admin generates link for second user "Reza"
  adminWs.send(JSON.stringify({
    type: MessageType.INVITE_GENERATE,
    targetUsername: 'Reza'
  }));
  const rezaInvite = await waitForMessage(adminWs, MessageType.INVITE_GENERATED);
  const rezaWs = createWsClient();
  await new Promise(r => rezaWs.on('open', r));
  rezaWs.send(JSON.stringify({
    type: MessageType.AUTH,
    username: 'Reza',
    token: rezaInvite.token
  }));
  await waitForMessage(rezaWs, MessageType.AUTH_SUCCESS);

  // Reza tries to play music while Omid is playing -> MUST BE REJECTED
  rezaWs.send(JSON.stringify({
    type: MessageType.MUSIC_ACTION,
    action: 'play',
    trackInfo: { title: 'Reza Song' }
  }));
  const rezaMusicError = await waitForMessage(rezaWs, MessageType.MUSIC_ERROR);
  assert.ok(rezaMusicError.message.includes('Only one person can play music at a time'), 'Music lock error check failed');
  console.log('✓ Test 6b Passed: Reza blocked from playing music while Omid is playing');

  // Admin stops music -> MUST SUCCEED
  adminWs.send(JSON.stringify({
    type: MessageType.MUSIC_ACTION,
    action: 'stop'
  }));
  const musicStateStopped = await waitForMessage(omidWs, MessageType.MUSIC_STATE);
  assert.ok(musicStateStopped.musicState.isPlaying === false, 'Music should be stopped');
  console.log('✓ Test 6c Passed: Admin successfully stopped music using override authority');

  // Test 7: Chat and Permission Revocation
  // Revoke chat for Reza via roomManager
  const rezaParticipant = roomManager.getParticipantByUsername('Reza');
  roomManager.updatePermissions(rezaParticipant.id, { can_chat: false });

  await sleep(100);
  assert.ok(rezaParticipant.permissions.can_chat === false, 'can_chat should be false');

  // Reza tries to send chat
  rezaWs.send(JSON.stringify({
    type: MessageType.CHAT_SEND,
    mode: ChatMode.PUBLIC,
    text: 'Hello from Reza'
  }));

  const chatErr = await waitForMessage(rezaWs, 'error');
  assert.ok(chatErr.message.includes('revoked'), 'Chat revoke error message check failed');
  console.log('✓ Test 7 Passed: Revoked chat permission successfully blocked messaging');

  // Clean up
  adminWs.close();
  omidWs.close();
  rezaWs.close();
  server.close();

  console.log('\n========================================');
  console.log(' ALL SECTION 2 BACKEND TESTS PASSED!   ');
  console.log('========================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
