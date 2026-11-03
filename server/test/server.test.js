/**
 * Section 2 Integration Test
 * Tests Server Initialization, Strict Username-Link Binding & Permissions
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

  // Test 1b: Invited users cannot join before the admin is in the room
  const earlyWs = createWsClient();
  await new Promise(r => earlyWs.on('open', r));
  const earlyToken = authService.generateInviteLink({ baseUrl: 'http://localhost:8099', targetUsername: 'Early' }).token;
  earlyWs.send(JSON.stringify({ type: MessageType.AUTH, username: 'Early', token: earlyToken }));
  const earlyError = await waitForMessage(earlyWs, MessageType.AUTH_ERROR);
  assert.strictEqual(earlyError.code, 'ERR_ADMIN_ABSENT');
  assert.strictEqual(earlyError.message, 'The admin is not in the room yet. Please try again later.');
  assert.strictEqual(roomManager.participants.size, 0, 'Nobody may be in the room before the admin');
  earlyWs.close();
  console.log('✓ Test 1b Passed: Invited users wait for the admin');

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

  // Test 6: The admin invites a second user, "Reza", who joins with that link
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
  const rezaJoined = await waitForMessage(rezaWs, MessageType.AUTH_SUCCESS);
  assert.strictEqual(rezaJoined.user.username, 'Reza', 'Reza username mismatch');
  console.log('✓ Test 6 Passed: A second invited user joined the room');

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

  // Test 7b: The stage. Invited people join the audience; only the admin brings them up (directly, or
  // by accepting a raised hand); the audience sends no media whatever its permissions
  const omidState = () => roomManager.getParticipantByUsername('Omid');
  assert.strictEqual(adminAuthMsg.user.onStage, true, 'The admin is always on stage');
  assert.strictEqual(omidAuthSuccess.user.onStage, false, 'Invited people join the audience');
  assert.strictEqual(omidAuthSuccess.user.handRaised, false);
  roomManager.updatePermissions(omidState().id, { can_audio: true, can_video: true, can_screen: true });
  omidWs.send(JSON.stringify({ type: MessageType.MEDIA_STATE_CHANGE, mediaState: { audio: true, video: true, screen: true } }));
  await sleep(150);
  assert.deepStrictEqual({ ...omidState().mediaState }, { audio: false, video: false, screen: false }, 'The audience sends nothing, even with permission');
  // Omid raises his hand: everyone (above all the admin) learns it
  const handSeen = waitForMessage(adminWs, MessageType.ROOM_STATE);
  omidWs.send(JSON.stringify({ type: MessageType.HAND_RAISE, raised: true }));
  const hand = await handSeen;
  assert.deepStrictEqual([hand.action, hand.userId, hand.handRaised], ['hand_changed', omidState().id, true]);
  // Reza cannot bring Omid up; the admin can
  rezaWs.send(JSON.stringify({ type: MessageType.STAGE_SET, userId: omidState().id, onStage: true }));
  assert.ok((await waitForMessage(rezaWs, 'error')).message.includes('Only the admin'), 'A user must not move people to the stage');
  assert.strictEqual(omidState().onStage, false);
  const stageSeen = waitForMessage(omidWs, MessageType.ROOM_STATE);
  adminWs.send(JSON.stringify({ type: MessageType.STAGE_SET, userId: omidState().id, onStage: true }));
  const staged = await stageSeen;
  assert.deepStrictEqual([staged.action, staged.onStage, staged.handRaised], ['stage_changed', true, false], 'Brought on stage, hand lowered');
  omidWs.send(JSON.stringify({ type: MessageType.MEDIA_STATE_CHANGE, mediaState: { audio: true, video: true } }));
  await sleep(150);
  assert.deepStrictEqual([omidState().mediaState.audio, omidState().mediaState.video], [true, true], 'On stage, permissions apply');
  omidWs.send(JSON.stringify({ type: MessageType.HAND_RAISE, raised: true }));
  await sleep(150);
  assert.strictEqual(omidState().handRaised, false, 'No raised hand on stage');
  // Back to the audience: everything off
  adminWs.send(JSON.stringify({ type: MessageType.STAGE_SET, userId: omidState().id, onStage: false }));
  await sleep(150);
  assert.strictEqual(omidState().onStage, false);
  assert.deepStrictEqual({ ...omidState().mediaState }, { audio: false, video: false, screen: false }, 'Leaving the stage turns media off');
  adminWs.send(JSON.stringify({ type: MessageType.STAGE_SET, userId: roomManager.getParticipantByUsername('Admin').id, onStage: false }));
  await sleep(150);
  assert.strictEqual(roomManager.getParticipantByUsername('Admin').onStage, true, 'The admin cannot leave the stage');
  console.log('✓ Test 7b Passed: Invited people join the audience; the admin brings them on stage, also via a raised hand');

  // Test 8: The admin leaves and comes back in time: everyone stays
  roomManager.adminGraceMs = 800; // 10 seconds in use; shorter here
  const joinAdmin = async (options) => {
    const ws = new WebSocket(WS_URL, options);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: MessageType.AUTH, username: 'Admin', token: creds.adminToken }));
    await waitForMessage(ws, MessageType.AUTH_SUCCESS);
    return ws;
  };
  let leftNotice = waitForMessage(omidWs, MessageType.ROOM_NOTICE);
  const rezaLeftNotice = waitForMessage(rezaWs, MessageType.ROOM_NOTICE);
  adminWs.close();
  assert.match((await leftNotice).message, /The admin left the room\. Everyone will be removed in 1 seconds/);
  await rezaLeftNotice;
  const omidKicks = [];
  omidWs.on('message', raw => { if (JSON.parse(raw).type === MessageType.KICKED) omidKicks.push(JSON.parse(raw)); });
  const backNotice = waitForMessage(rezaWs, MessageType.ROOM_NOTICE);
  let admin2 = await joinAdmin();
  assert.strictEqual((await backNotice).message, 'The admin is back.');
  await sleep(1200);
  assert.ok(roomManager.getParticipantByUsername('Omid') && roomManager.getParticipantByUsername('Reza'), 'Users removed although the admin came back');
  assert.strictEqual(omidKicks.length, 0);
  console.log('✓ Test 8 Passed: The admin coming back in time keeps everyone in the room');

  // Test 9: The admin joining again from another window is not "leaving"
  const notices = [];
  rezaWs.on('message', raw => { if (JSON.parse(raw).type === MessageType.ROOM_NOTICE) notices.push(JSON.parse(raw)); });
  const admin3 = await joinAdmin();
  await sleep(300);
  assert.deepStrictEqual(notices, [], 'A second admin window must not announce that the admin left');
  assert.strictEqual(roomManager.adminGraceTimer, null);
  admin2.close();
  console.log('✓ Test 9 Passed: Switching the admin to another window keeps the room as it is');

  // Test 10: An admin connection that stops answering is noticed (heartbeat), then everyone is removed
  const silentAdmin = await joinAdmin({ autoPong: false }); // like a laptop that went to sleep
  admin3.close();
  leftNotice = waitForMessage(omidWs, MessageType.ROOM_NOTICE, 15000);
  const omidKicked = waitForMessage(omidWs, MessageType.KICKED, 20000);
  const rezaKicked = waitForMessage(rezaWs, MessageType.KICKED, 20000);
  await leftNotice;
  assert.strictEqual(roomManager.getParticipantByUsername('Admin'), null, 'Silent admin connection not closed');
  assert.strictEqual((await omidKicked).reason, 'The admin left the room.');
  assert.strictEqual((await rezaKicked).reason, 'The admin left the room.');
  await sleep(100);
  assert.strictEqual(roomManager.participants.size, 0, 'Everyone must be removed when the admin stays away');
  silentAdmin.terminate();
  console.log('✓ Test 10 Passed: When the admin stays away, everyone is removed after the wait');

  // Clean up
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
