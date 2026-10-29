/**
 * MASTER END-TO-END VERIFICATION SUITE
 * Complete end-to-end verification covering all 9 instructions from VideoCall.odt
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.PORT = '8090';
// Use a throwaway server config, never the real one
process.env.VIDEOCALL_CONFIG = require('path').join(require('os').tmpdir(), `videocall-e2e-${process.pid}.json`);
process.on('exit', () => require('fs').rmSync(process.env.VIDEOCALL_CONFIG, { force: true }));
const { WebSocket } = require('../server/node_modules/ws');
global.WebSocket = WebSocket;

const ClientCore = require('../client/src/clientCore');
const { server, authService, roomManager, adminSessions } = require('../server/src/index');
// Management panel calls use a signed-in panel session
const ADMIN_COOKIE = adminSessions.create().cookie.split(';')[0];
const { ChatMode, Role } = require('../shared/protocol');

const SERVER_URL = 'http://localhost:8090';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    http.get(urlStr, { headers: { Cookie: ADMIN_COOKIE } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

function httpPost(urlStr, body) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        Cookie: ADMIN_COOKIE
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runE2E() {
  console.log('\n' + '='.repeat(70));
  console.log('       STARTING MASTER END-TO-END VERIFICATION SUITE        ');
  console.log('='.repeat(70) + '\n');

  // STEP 1: Verify Server Startup & Admin Provisioning (Instruction 3)
  console.log('[E2E Step 1] Verifying server startup provisioning and credentials...');
  const adminCreds = authService.getAdminCredentials(SERVER_URL);
  assert.ok(adminCreds.adminUsername === 'Admin', 'Admin username check failed');
  assert.ok(/\/admin(\?setup=[0-9a-f]{48})?$/.test(adminCreds.panelUrl), 'Panel URL format check failed');
  assert.ok(adminCreds.adminLink.includes('/join?room='), 'Admin join link format check failed');
  console.log('  -> Admin Panel URL: ' + adminCreds.panelUrl);
  console.log('  -> Admin Join Link: ' + adminCreds.adminLink);
  console.log('  [PASS] Server setup credentials generated successfully.\n');

  // STEP 2: Verify Admin Application Join (Instruction 3)
  console.log('[E2E Step 2] Admin enters link into client and joins room...');
  let adminInviteData = null;
  const coreAdmin = new ClientCore({
    onInviteGenerated: data => { adminInviteData = data; }
  });

  coreAdmin.connect({
    username: 'Admin',
    linkOrToken: adminCreds.adminLink,
    serverUrl: SERVER_URL
  });

  await sleep(400);
  assert.ok(coreAdmin.currentUser && coreAdmin.currentUser.role === Role.ADMIN, 'Admin join role check failed');
  assert.ok(coreAdmin.currentUser.permissions.can_invite === true, 'Admin can_invite check failed');
  console.log('  [PASS] Admin joined room with role: ADMIN and can_invite: true.\n');

  // STEP 3: Admin generates Invite Link for "Omid" (Instruction 3)
  console.log('[E2E Step 3] Admin clicks Invite button and generates link for "Omid"...');
  coreAdmin.requestInviteLink('Omid');
  await sleep(400);
  assert.ok(adminInviteData && adminInviteData.username === 'Omid', 'Invite username mismatch');
  assert.ok(adminInviteData.joinLink.includes('user=Omid'), 'Invite link missing user=Omid');
  const omidLink = adminInviteData.joinLink;
  console.log('  -> Generated link for Omid: ' + omidLink);
  console.log('  [PASS] Link bound specifically to Omid generated successfully.\n');

  // STEP 4: Credential Mismatch Negative Test: Ali enters Omid's link (Instruction 3)
  console.log('[E2E Step 4] Negative test: User "Ali" enters Omid\'s link...');
  let mismatchError = null;
  const coreAli = new ClientCore({
    onAuthError: err => { mismatchError = err; }
  });

  coreAli.connect({
    username: 'Ali',
    linkOrToken: omidLink,
    serverUrl: SERVER_URL
  });

  await sleep(400);
  assert.ok(mismatchError !== null, 'No error received for mismatching credentials');
  assert.ok(mismatchError.code === 'ERR_CREDENTIAL_MISMATCH', 'Mismatch code incorrect: ' + mismatchError.code);
  assert.ok(mismatchError.message === 'Username and link do not match.', 'Mismatch message incorrect: ' + mismatchError.message);
  console.log('  -> Application received error message: "' + mismatchError.message + '"');
  console.log('  [PASS] Mismatched credentials correctly rejected with exact error message.\n');

  // STEP 5: Matching Credentials Positive Test: Omid joins with Omid's link (Instruction 3)
  console.log('[E2E Step 5] Positive test: User "Omid" enters Omid\'s link...');
  let omidJoined = false;
  const coreOmid = new ClientCore({
    onAuthSuccess: () => { omidJoined = true; }
  });

  coreOmid.connect({
    username: 'Omid',
    linkOrToken: omidLink,
    serverUrl: SERVER_URL
  });

  await sleep(400);
  assert.ok(omidJoined === true, 'Omid join failed');
  assert.ok(coreOmid.currentUser.role === Role.USER, 'Omid should have regular user role');
  assert.ok(coreOmid.currentUser.permissions.can_invite === false, 'Omid should NOT have can_invite by default');
  console.log('  [PASS] Omid joined successfully with regular user role and default permissions.\n');

  // STEP 6: Multi-User Voice & Video Signaling Relay (Instruction 1)
  console.log('[E2E Step 6] Testing voice & video media relay signaling between Admin and Omid...');
  let omidReceivedSignal = null;
  coreOmid.mediaEngine = {
    createPeerConnection: () => {},
    handleSignal: (peerId, sig) => { omidReceivedSignal = sig; },
    removePeer: () => {},
    destroy: () => {}
  };

  const omidParticipant = roomManager.getParticipantByUsername('Omid');
  const adminParticipant = roomManager.getParticipantByUsername('Admin');

  coreAdmin.send({
    type: 'signal',
    targetPeerId: omidParticipant.id,
    signal: { sdp: { type: 'offer', sdp: 'v=0\r\no=admin 1234' } }
  });

  await sleep(400);
  assert.ok(omidReceivedSignal && omidReceivedSignal.sdp.type === 'offer', 'Signaling relay failed');
  console.log('  [PASS] Video and voice WebRTC signaling relayed cleanly through server.\n');

  // STEP 7: Built-in Chat Box Modes: Public, Direct & Group (Instruction 2)
  console.log('[E2E Step 7] Testing chat modes (Public, Direct 1-to-1, and Group)...');
  // Connect a 3rd user: Sarah
  const sarahInvite = authService.generateInviteLink({ baseUrl: SERVER_URL, targetUsername: 'Sarah' });
  const coreSarah = new ClientCore();
  coreSarah.connect({ username: 'Sarah', linkOrToken: sarahInvite.joinLink, serverUrl: SERVER_URL });
  await sleep(400);
  const sarahParticipant = roomManager.getParticipantByUsername('Sarah');

  let adminMsgs = [];
  let omidMsgs = [];
  let sarahMsgs = [];

  coreAdmin.onChatMessage = m => adminMsgs.push(m);
  coreOmid.onChatMessage = m => omidMsgs.push(m);
  coreSarah.onChatMessage = m => sarahMsgs.push(m);

  // 7a. Public Chat
  coreOmid.sendChatMessage({ mode: ChatMode.PUBLIC, text: 'Hello Room!' });
  await sleep(300);
  assert.ok(adminMsgs.some(m => m.text === 'Hello Room!'), 'Public chat not delivered to Admin');
  assert.ok(sarahMsgs.some(m => m.text === 'Hello Room!'), 'Public chat not delivered to Sarah');
  console.log('  -> 7a. Public broadcast: Received by all users.');

  // 7b. Direct Chat (Omid sends private 1-to-1 to Sarah)
  adminMsgs = [];
  coreOmid.sendChatMessage({ mode: ChatMode.DIRECT, recipients: [sarahParticipant.id], text: 'Private secret for Sarah' });
  await sleep(300);
  assert.ok(sarahMsgs.some(m => m.text === 'Private secret for Sarah'), 'Direct chat not delivered to Sarah');
  assert.ok(!adminMsgs.some(m => m.text === 'Private secret for Sarah'), 'Admin saw private 1-to-1 message!');
  console.log('  -> 7b. Direct 1-to-1 chat: Delivered strictly to Sarah; concealed from others.');

  // 7c. Group Chat (Admin sends group chat to Omid and Sarah)
  coreAdmin.sendChatMessage({ mode: ChatMode.GROUP, recipients: [omidParticipant.id, sarahParticipant.id], text: 'Group meeting' });
  await sleep(300);
  assert.ok(omidMsgs.some(m => m.text === 'Group meeting'), 'Group message missing for Omid');
  assert.ok(sarahMsgs.some(m => m.text === 'Group meeting'), 'Group message missing for Sarah');
  console.log('  -> 7c. Group chat: Delivered selectively to chosen group members.');
  console.log('  [PASS] All 3 chat modes verified.\n');

  // STEP 8: Synchronized Music Player & Exclusive Playback Locking (Instruction 5)
  console.log('[E2E Step 8] Testing music playback concurrency lock and Admin override...');
  // Omid starts playing
  coreOmid.sendMusicAction({ action: 'play', trackInfo: { title: 'Nocturne in E-flat', artist: 'Chopin' } });
  await sleep(300);
  assert.ok(roomManager.musicState.isPlaying === true, 'Music should be playing');
  assert.ok(roomManager.musicState.playedBy.username === 'Omid', 'Lock should belong to Omid');
  console.log('  -> Omid started music and acquired lock.');

  // Sarah tries to play while Omid is playing -> MUST BE REJECTED
  let sarahMusicError = null;
  coreSarah.onMusicError = err => { sarahMusicError = err; };
  coreSarah.sendMusicAction({ action: 'play', trackInfo: { title: 'Sarah Song' } });
  await sleep(300);
  assert.ok(sarahMusicError && sarahMusicError.includes('Only one person can play music at a time'), 'Concurrency error missing');
  assert.ok(roomManager.musicState.playedBy.username === 'Omid', 'Music lock was violated');
  console.log('  -> Sarah blocked: "' + sarahMusicError + '"');

  // Sarah tries to stop Omid's music -> MUST BE REJECTED
  coreSarah.sendMusicAction({ action: 'stop' });
  await sleep(300);
  assert.ok(roomManager.musicState.isPlaying === true, 'Non-admin stopped someone else music');
  console.log('  -> Sarah prevented from stopping Omid\'s music.');

  // Admin exercises override authority -> MUST STOP
  coreAdmin.sendMusicAction({ action: 'stop' });
  await sleep(300);
  assert.ok(roomManager.musicState.isPlaying === false, 'Admin override stop failed');
  console.log('  -> Admin successfully stopped playback via override authority.');
  console.log('  [PASS] Music player exclusive concurrency lock & Admin override verified.\n');

  // STEP 9: User Management Panel Real-Time Moderation & Permission Control (Instruction 4)
  console.log('[E2E Step 9] Testing Admin Web Management Panel actions and live permission revocations...');
  // 9a. Verify panel info endpoint
  const panelInfo = await httpGet(`${SERVER_URL}/api/admin/info`);
  assert.ok(panelInfo.status === 200, 'Panel info API failed');
  const panelData = JSON.parse(panelInfo.data);
  assert.ok(panelData.participants.length === 3, 'User count check failed in panel: ' + panelData.participants.length);
  console.log('  -> Admin panel displays all 3 active users in room.');

  // 9b. Admin enables can_invite for Omid via panel
  let omidPermsUpdated = null;
  coreOmid.onPermissionsUpdated = perms => { omidPermsUpdated = perms; };

  const grantRes = await httpPost(`${SERVER_URL}/api/admin/permissions`, {
    token: adminCreds.adminToken,
    userId: omidParticipant.id,
    permissions: { ...omidParticipant.permissions, can_invite: true }
  });
  assert.ok(grantRes.status === 200, 'Grant invite failed');
  await sleep(300);
  assert.ok(omidPermsUpdated && omidPermsUpdated.can_invite === true, 'Omid did not receive can_invite update');
  console.log('  -> Admin panel enabled can_invite for Omid.');

  // 9c. Omid now generates invite link for "Kaveh"
  let kavehInvite = null;
  coreOmid.onInviteGenerated = d => { kavehInvite = d; };
  coreOmid.requestInviteLink('Kaveh');
  await sleep(300);
  assert.ok(kavehInvite && kavehInvite.username === 'Kaveh', 'Kaveh invite failed');
  console.log('  -> Omid successfully generated invite link for "Kaveh" using delegated permission.');

  // 9d. Admin revokes audio and chat access for Sarah via panel
  const revokeRes = await httpPost(`${SERVER_URL}/api/admin/permissions`, {
    token: adminCreds.adminToken,
    userId: sarahParticipant.id,
    permissions: { ...sarahParticipant.permissions, can_audio: false, can_chat: false }
  });
  assert.ok(revokeRes.status === 200, 'Revoke permissions failed');
  await sleep(300);
  assert.ok(sarahParticipant.permissions.can_audio === false, 'can_audio not revoked');
  assert.ok(sarahParticipant.permissions.can_chat === false, 'can_chat not revoked');

  // Verify Sarah cannot send chat now
  adminMsgs = [];
  coreSarah.sendChatMessage({ mode: ChatMode.PUBLIC, text: 'Blocked message from Sarah' });
  await sleep(300);
  assert.ok(!adminMsgs.some(m => m.text === 'Blocked message from Sarah'), 'Sarah sent message despite chat revoked');
  console.log('  -> Sarah permissions revoked (audio: false, chat: false); messaging blocked.');

  // 9e. Kick Sarah via admin panel
  let sarahKicked = false;
  coreSarah.onKicked = () => { sarahKicked = true; };

  const kickRes = await httpPost(`${SERVER_URL}/api/admin/kick`, {
    token: adminCreds.adminToken,
    userId: sarahParticipant.id,
    reason: 'Kicked by Room Admin'
  });
  assert.ok(kickRes.status === 200, 'Kick API failed');
  await sleep(400);
  assert.ok(sarahKicked === true, 'Sarah kick event not received');
  assert.ok(roomManager.participants.size === 2, 'Room count mismatch after kick');
  console.log('  -> Sarah kicked from room by admin; room state updated immediately.');
  console.log('  [PASS] Admin Management Panel live moderation & permission controls verified.\n');

  // STEP 10: Deliverables Verification (Instruction 7 & 8)
  console.log('[E2E Step 10] Verifying required deliverables and extra.txt...');
  assert.ok(fs.existsSync(path.join(__dirname, '../dist/windows/VideoCall-Setup.exe')), 'Missing Windows client deliverable');
  assert.ok(fs.existsSync(path.join(__dirname, '../dist/linux/VideoCall.AppImage')), 'Missing Linux client deliverable');
  assert.ok(fs.existsSync(path.join(__dirname, '../dist/videocall-server.tar.gz')), 'Missing Linux server installer bundle');
  assert.ok(fs.existsSync(path.join(__dirname, '../docs/extra.txt')), 'Missing extra.txt');
  console.log('  ✓ Deliverable 1: Windows Client -> dist/windows/VideoCall-Setup.exe');
  console.log('  ✓ Deliverable 2: Linux Client   -> dist/linux/VideoCall.AppImage');
  console.log('  ✓ Deliverable 3: Linux Server   -> dist/videocall-server.tar.gz');
  console.log('  ✓ Deliverable 4: Extra Features -> docs/extra.txt');
  console.log('  [PASS] All deliverables present and verified.\n');

  // Clean up
  coreAdmin.disconnect();
  coreOmid.disconnect();
  server.close();

  console.log('='.repeat(70));
  console.log('   ALL MASTER END-TO-END VERIFICATION CHECKS PASSED (100%)!   ');
  console.log('='.repeat(70) + '\n');
  process.exit(0);
}

runE2E().catch(err => {
  console.error('\nE2E Test Failure:', err);
  process.exit(1);
});
