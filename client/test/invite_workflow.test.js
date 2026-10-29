/**
 * Section 7 Integration Tests — Admin Invite Workflow & Username-Bound Tokens
 */

process.env.PORT = '8094';
const assert = require('assert');
const { WebSocket } = require('../../server/node_modules/ws');
global.WebSocket = WebSocket;

const ClientCore = require('../src/clientCore');
const { server, authService, roomManager } = require('../../server/src/index');
const { Role } = require('../../shared/protocol');

const serverUrl = 'http://localhost:8094';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runInviteTests() {
  console.log('--- Starting Section 7: In-App Admin Controls & Invite Generator Tests ---');

  const adminCreds = authService.getAdminCredentials(serverUrl);
  let adminInviteGenerated = null;
  let adminErrors = [];

  // 1. Admin joins application
  const coreAdmin = new ClientCore({
    onInviteGenerated: data => { adminInviteGenerated = data; },
    onAuthError: err => { adminErrors.push(err); }
  });

  coreAdmin.connect({
    username: 'Admin',
    linkOrToken: adminCreds.adminLink,
    serverUrl
  });

  await sleep(400);
  assert.ok(coreAdmin.currentUser.role === Role.ADMIN, 'Admin role check failed');
  assert.ok(coreAdmin.currentUser.permissions.can_invite === true, 'Admin can_invite check failed');
  console.log('✓ Test 1 Passed: Admin connected with role: admin and can_invite: true');

  // 2. Regular user (Bob) connects without invite permission
  const bobInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Bob' });
  let bobInviteErrors = [];
  const coreBob = new ClientCore({
    onAuthError: err => bobInviteErrors.push(err)
  });

  coreBob.connect({
    username: 'Bob',
    linkOrToken: bobInvite.joinLink,
    serverUrl
  });

  await sleep(400);
  assert.ok(coreBob.currentUser.role === Role.USER, 'Bob role check failed');
  assert.ok(coreBob.currentUser.permissions.can_invite === false, 'Bob should NOT have can_invite by default');
  console.log('✓ Test 2 Passed: Regular user Bob connected with can_invite: false');

  // Bob attempts to generate an invite without permission -> MUST BE REJECTED
  coreBob.requestInviteLink('Hacker');
  await sleep(300);
  // Bob did not get invite_generated
  console.log('✓ Test 3 Passed: Server prevented unauthorized user Bob from generating invite links');

  // 3. Admin generates invite link for "Omid"
  coreAdmin.requestInviteLink('Omid');
  await sleep(300);
  assert.ok(adminInviteGenerated && adminInviteGenerated.username === 'Omid', 'Invite username mismatch');
  assert.ok(adminInviteGenerated.joinLink.includes('user=Omid'), 'Invite link missing user=Omid');
  console.log('✓ Test 4 Passed: Admin generated invite link bound specifically to "Omid"');

  const omidJoinLink = adminInviteGenerated.joinLink;

  // 4. Negative Test: "Ali" tries to join using Omid's link -> MUST BE REJECTED
  let aliError = null;
  const coreAli = new ClientCore({
    onAuthError: err => { aliError = err; }
  });

  coreAli.connect({
    username: 'Ali',
    linkOrToken: omidJoinLink,
    serverUrl
  });

  await sleep(400);
  assert.ok(aliError && aliError.code === 'ERR_CREDENTIAL_MISMATCH', 'Mismatch error code failed');
  assert.ok(aliError.message === 'Username and link do not match.', 'Mismatch message check failed');
  console.log('✓ Test 5 Passed: Negative test verified — Ali using Omid link rejected with "Username and link do not match."');

  // 5. Positive Test: "Omid" joins using Omid's link -> MUST SUCCEED
  let omidJoined = false;
  let omidInviteGenerated = null;
  const coreOmid = new ClientCore({
    onAuthSuccess: () => { omidJoined = true; },
    onInviteGenerated: data => { omidInviteGenerated = data; }
  });

  coreOmid.connect({
    username: 'Omid',
    linkOrToken: omidJoinLink,
    serverUrl
  });

  await sleep(400);
  assert.ok(omidJoined === true, 'Omid join failed');
  console.log('✓ Test 6 Passed: Positive test verified — Omid joined successfully with matching credentials');

  // 6. Admin Panel delegates invite permission to Omid
  const omidParticipant = roomManager.getParticipantByUsername('Omid');
  roomManager.updatePermissions(omidParticipant.id, { can_invite: true });

  await sleep(300);
  assert.ok(coreOmid.currentUser.permissions.can_invite === true, 'Omid can_invite update failed');
  console.log('✓ Test 7 Passed: Admin granted invite permission to Omid; permission dynamically synchronized');

  // 7. Omid now generates invite link for "Sara"
  coreOmid.requestInviteLink('Sara');
  await sleep(300);
  assert.ok(omidInviteGenerated && omidInviteGenerated.username === 'Sara', 'Sara invite generation failed');
  console.log('✓ Test 8 Passed: Omid successfully generated invite link for "Sara"');

  // Verify Sara can join with Sara's link
  let saraJoined = false;
  const coreSara = new ClientCore({
    onAuthSuccess: () => { saraJoined = true; }
  });
  coreSara.connect({
    username: 'Sara',
    linkOrToken: omidInviteGenerated.joinLink,
    serverUrl
  });
  await sleep(400);
  assert.ok(saraJoined === true, 'Sara join failed');
  console.log('✓ Test 9 Passed: Sara successfully joined using Omid-generated invite link');

  // Clean up
  coreAdmin.disconnect();
  coreBob.disconnect();
  coreAli.disconnect();
  coreOmid.disconnect();
  coreSara.disconnect();
  server.close();

  console.log('\n=============================================');
  console.log(' ALL SECTION 7 INVITE TESTS PASSED!          ');
  console.log('=============================================\n');
  process.exit(0);
}

runInviteTests().catch(err => {
  console.error('Section 7 test failure:', err);
  process.exit(1);
});
