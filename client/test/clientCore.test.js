/**
 * Section 4 Integration Tests — Client Core & Media Engine Relay
 */

process.env.PORT = '8097';
const assert = require('assert');
const { WebSocket } = require('../../server/node_modules/ws');
global.WebSocket = WebSocket; // Polyfill for Node environment

const ClientCore = require('../src/clientCore');
const { server, authService, roomManager } = require('../../server/src/index');

async function runClientCoreTests() {
  console.log('--- Starting Section 4 Client Core Tests ---');

  const serverUrl = 'http://localhost:8097';
  const creds = authService.getAdminCredentials(serverUrl);

  // 1. Test Join with Empty Credentials
  let caughtError = null;
  const core1 = new ClientCore({
    onAuthError: err => { caughtError = err; }
  });

  core1.connect({ username: '', linkOrToken: '', serverUrl });
  assert.ok(caughtError && caughtError.code === 'ERR_EMPTY_USERNAME', 'Empty username check failed');
  console.log('✓ Test 1 Passed: Empty username correctly flagged');

  // 2. Test Mismatch: Ali attempts to join using Omid's token
  const omidInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Omid' });

  let mismatchError = null;
  const coreAli = new ClientCore({
    onAuthError: err => { mismatchError = err; }
  });

  coreAli.connect({
    username: 'Ali',
    linkOrToken: omidInvite.joinLink,
    serverUrl
  });

  await new Promise(r => setTimeout(r, 400));
  assert.ok(mismatchError && mismatchError.message === 'Username and link do not match.', 'Mismatch error check failed');
  console.log('✓ Test 2 Passed: Ali entering Omid link rejected with "Username and link do not match."');

  // 2b. Invited users cannot join before the admin
  let earlyError = null;
  const coreEarly = new ClientCore({ onAuthError: err => { earlyError = err; } });
  coreEarly.connect({ username: 'Omid', linkOrToken: omidInvite.joinLink, serverUrl });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(earlyError && earlyError.code === 'ERR_ADMIN_ABSENT', 'Joined before the admin');
  assert.strictEqual(earlyError.message, 'The admin is not in the room yet. Please try again later.');
  assert.strictEqual(roomManager.participants.size, 0, 'Someone is in the room without the admin');
  // The admin opens the room (Test 5 joins the admin again, from a second window)
  const coreOpener = new ClientCore();
  coreOpener.connect({ username: 'Admin', linkOrToken: creds.adminLink, serverUrl });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(coreOpener.currentUser, 'Admin failed to join');
  console.log('✓ Test 2b Passed: Invited users wait for the admin to open the room');

  // 3. Test Success: Omid joins with Omid's token
  let omidUser = null;
  let omidRoomState = null;
  const coreOmid = new ClientCore({
    onAuthSuccess: (user, state) => {
      omidUser = user;
      omidRoomState = state;
    }
  });

  coreOmid.connect({
    username: 'Omid',
    linkOrToken: omidInvite.joinLink,
    serverUrl
  });

  await new Promise(r => setTimeout(r, 400));
  assert.ok(omidUser && omidUser.username === 'Omid', 'Omid auth check failed');
  assert.ok(omidRoomState && omidRoomState.roomId === authService.roomId, 'Room state check failed');
  console.log('✓ Test 3 Passed: Omid successfully authenticated and joined room');

  // 4. Test Client Permission Enforcement
  // Simulate admin revoking audio and video for Omid
  let updatedPerms = null;
  let mediaDisabled = false;

  // Mock mediaEngine
  coreOmid.mediaEngine = {
    setAudioEnabled: val => { if (!val) mediaDisabled = true; },
    stopCamera: () => {},
    setIceServers: () => {},
    createPeerConnection: () => {},
    handleSignal: () => {},
    removePeer: () => {},
    destroy: () => {}
  };

  coreOmid.onPermissionsUpdated = perms => {
    updatedPerms = perms;
  };

  // Server revokes can_audio
  const participant = roomManager.getParticipantByUsername('Omid');
  roomManager.updatePermissions(participant.id, { can_audio: false, can_video: false });

  await new Promise(r => setTimeout(r, 400));
  assert.ok(updatedPerms && updatedPerms.can_audio === false, 'Audio perm revoke failed');
  assert.ok(mediaDisabled === true, 'Client mediaEngine setAudioEnabled(false) not called');
  console.log('✓ Test 4 Passed: Client received permission revocation and automatically muted media engine');

  // 5. Test WebRTC Signaling Relay between two peers
  const adminInvite = creds.adminLink;
  let receivedSignal = null;
  let receivedIceServers = null;

  const coreAdmin = new ClientCore({
    mediaEngine: {
      setIceServers: servers => { receivedIceServers = servers; },
      createPeerConnection: () => {},
      handleSignal: (peerId, signal) => {
        receivedSignal = signal;
      },
      removePeer: () => {},
      destroy: () => {}
    }
  });

  coreAdmin.connect({
    username: 'Admin',
    linkOrToken: adminInvite,
    serverUrl
  });

  await new Promise(r => setTimeout(r, 400));

  // Omid sends WebRTC signal to Admin
  const adminParticipant = roomManager.getParticipantByUsername('Admin');
  coreOmid.send({
    type: 'signal',
    targetPeerId: adminParticipant.id,
    signal: { sdp: { type: 'offer', sdp: 'dummy-offer' } }
  });

  await new Promise(r => setTimeout(r, 400));
  assert.ok(receivedSignal && receivedSignal.sdp.type === 'offer', 'Signaling relay failed');
  console.log('✓ Test 5 Passed: WebRTC signaling relay between peers functioned successfully');

  // 6. The server hands authenticated clients its TURN relay for peers that cannot connect directly
  const turnEntry = (receivedIceServers || []).find(s => String(s.urls).startsWith('turn:'));
  assert.ok(turnEntry && turnEntry.username && turnEntry.credential, 'TURN relay credentials not delivered');
  assert.ok(String(turnEntry.urls).startsWith('turn:localhost:'), 'TURN host should match the address the client used');
  console.log('✓ Test 6 Passed: Client received the server TURN relay configuration');

  // 7. The stage: Omid joined the audience, raises his hand, the admin brings him up
  assert.strictEqual(coreOmid.currentUser.onStage, false, 'Invited people join the audience');
  assert.strictEqual(ClientCore.isOnStage(coreOmid.currentUser), false);
  assert.strictEqual(ClientCore.isOnStage({ username: 'old server' }), true, 'Without a stage (older servers) everyone counts as on it');
  const handsAtAdmin = [];
  const stageAtOmid = [];
  coreAdmin.onHandChanged = (user, isMe) => handsAtAdmin.push([user.username, user.handRaised, isMe]);
  coreOmid.onStageChanged = (user, isMe) => stageAtOmid.push([user.username, user.onStage, isMe]);
  coreOmid.raiseHand(true);
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(handsAtAdmin, [['Omid', true, false]], 'The admin learns about the raised hand');
  assert.strictEqual(coreAdmin.roomState.participants.find(u => u.username === 'Omid').handRaised, true);
  coreAdmin.setStage(coreOmid.currentUser.id, true);
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(stageAtOmid, [['Omid', true, true]], 'Omid learns he is on stage');
  assert.ok(coreOmid.currentUser.onStage && !coreOmid.currentUser.handRaised, 'His own state follows (hand lowered)');
  assert.strictEqual(coreAdmin.roomState.participants.find(u => u.username === 'Omid').onStage, true);
  console.log('✓ Test 7 Passed: Raised hands and the stage reach everyone, including oneself');

  // Clean up
  coreOmid.disconnect();
  coreAdmin.disconnect();
  server.close();

  console.log('\n=============================================');
  console.log(' ALL SECTION 4 CLIENT CORE TESTS PASSED!    ');
  console.log('=============================================\n');
  process.exit(0);
}

runClientCoreTests().catch(err => {
  console.error('Section 4 test failure:', err);
  process.exit(1);
});
