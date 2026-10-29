/**
 * Section 5 Integration Tests — Chat Box Modes (Public, Direct & Group)
 */

process.env.PORT = '8096';
const assert = require('assert');
const { WebSocket } = require('../../server/node_modules/ws');
global.WebSocket = WebSocket;

const ClientCore = require('../src/clientCore');
const { server, authService, roomManager } = require('../../server/src/index');
const { ChatMode } = require('../../shared/protocol');

const serverUrl = 'http://localhost:8096';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runChatTests() {
  console.log('--- Starting Section 5: Chat Box Tests ---');

  // Setup 4 clients: Admin, Alice, Bob, Charlie
  const adminInvite = authService.getAdminCredentials(serverUrl);
  const aliceInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Alice' });
  const bobInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Bob' });
  const charlieInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Charlie' });

  const adminMsgs = [];
  const aliceMsgs = [];
  const bobMsgs = [];
  const charlieMsgs = [];

  const coreAdmin = new ClientCore({ onChatMessage: m => adminMsgs.push(m) });
  const coreAlice = new ClientCore({ onChatMessage: m => aliceMsgs.push(m) });
  const coreBob = new ClientCore({ onChatMessage: m => bobMsgs.push(m) });
  const coreCharlie = new ClientCore({ onChatMessage: m => charlieMsgs.push(m) });

  coreAdmin.connect({ username: 'Admin', linkOrToken: adminInvite.adminLink, serverUrl });
  coreAlice.connect({ username: 'Alice', linkOrToken: aliceInvite.joinLink, serverUrl });
  coreBob.connect({ username: 'Bob', linkOrToken: bobInvite.joinLink, serverUrl });
  coreCharlie.connect({ username: 'Charlie', linkOrToken: charlieInvite.joinLink, serverUrl });

  await sleep(600);
  console.log('✓ All 4 test users connected to room.');

  const bobUser = roomManager.getParticipantByUsername('Bob');
  const charlieUser = roomManager.getParticipantByUsername('Charlie');
  const aliceUser = roomManager.getParticipantByUsername('Alice');

  // 1. Test Public Chat Broadcast
  coreAlice.sendChatMessage({
    mode: ChatMode.PUBLIC,
    text: 'Hello everyone in public chat!'
  });

  await sleep(300);
  assert.ok(aliceMsgs.some(m => m.text === 'Hello everyone in public chat!'), 'Alice missing own public msg');
  assert.ok(bobMsgs.some(m => m.text === 'Hello everyone in public chat!'), 'Bob did not receive public msg');
  assert.ok(charlieMsgs.some(m => m.text === 'Hello everyone in public chat!'), 'Charlie did not receive public msg');
  assert.ok(adminMsgs.some(m => m.text === 'Hello everyone in public chat!'), 'Admin did not receive public msg');
  console.log('✓ Test 1 Passed: Public chat broadcast reached all room members');

  // 2. Test Direct Chat (1-to-1)
  // Alice sends direct message to Bob ONLY
  coreAlice.sendChatMessage({
    mode: ChatMode.DIRECT,
    recipients: [bobUser.id],
    text: 'Secret 1-to-1 message for Bob'
  });

  await sleep(300);
  assert.ok(bobMsgs.some(m => m.text === 'Secret 1-to-1 message for Bob'), 'Bob should receive direct message');
  assert.ok(aliceMsgs.some(m => m.text === 'Secret 1-to-1 message for Bob'), 'Alice should see own direct message');
  assert.ok(!charlieMsgs.some(m => m.text === 'Secret 1-to-1 message for Bob'), 'Charlie received private 1-to-1 message!');
  assert.ok(!adminMsgs.some(m => m.text === 'Secret 1-to-1 message for Bob'), 'Admin received private 1-to-1 message!');
  console.log('✓ Test 2 Passed: Direct 1-to-1 chat delivered strictly to target recipient');

  // 3. Test Group Chat (Selective recipients)
  // Alice sends group message to Bob and Charlie (Admin is excluded)
  coreAlice.sendChatMessage({
    mode: ChatMode.GROUP,
    recipients: [bobUser.id, charlieUser.id],
    text: 'Team group announcement for Bob and Charlie'
  });

  await sleep(300);
  assert.ok(bobMsgs.some(m => m.text === 'Team group announcement for Bob and Charlie'), 'Bob should receive group message');
  assert.ok(charlieMsgs.some(m => m.text === 'Team group announcement for Bob and Charlie'), 'Charlie should receive group message');
  assert.ok(aliceMsgs.some(m => m.text === 'Team group announcement for Bob and Charlie'), 'Alice should receive own group message');
  assert.ok(!adminMsgs.some(m => m.text === 'Team group announcement for Bob and Charlie'), 'Admin was excluded but received group message!');
  console.log('✓ Test 3 Passed: Group chat delivered selectively to chosen recipients');

  // 4. Test Chat Revocation Enforcement
  roomManager.updatePermissions(aliceUser.id, { can_chat: false });
  await sleep(200);

  coreAlice.sendChatMessage({
    mode: ChatMode.PUBLIC,
    text: 'Unauthorized attempt after revocation'
  });

  await sleep(300);
  assert.ok(!bobMsgs.some(m => m.text === 'Unauthorized attempt after revocation'), 'Revoked user message was delivered!');
  console.log('✓ Test 4 Passed: Revoked chat access successfully blocked messaging');

  // Clean up
  coreAdmin.disconnect();
  coreAlice.disconnect();
  coreBob.disconnect();
  coreCharlie.disconnect();
  server.close();

  console.log('\n=============================================');
  console.log(' ALL SECTION 5 CHAT TESTS PASSED!           ');
  console.log('=============================================\n');
  process.exit(0);
}

runChatTests().catch(err => {
  console.error('Section 5 test failure:', err);
  process.exit(1);
});
