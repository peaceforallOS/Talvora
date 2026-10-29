/**
 * Client Connection Lifecycle Tests — kick notification, lost connection, link parsing
 */

process.env.PORT = '8094';
const assert = require('assert');
const { WebSocket } = require('../../server/node_modules/ws');
global.WebSocket = WebSocket; // Polyfill for Node environment

const ClientCore = require('../src/clientCore');
const { server, authService, roomManager } = require('../../server/src/index');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runConnectionTests() {
  console.log('--- Starting Client Connection Lifecycle Tests ---');

  const serverUrl = 'http://localhost:8094';

  // 1. A kick (message + close code 4001) is reported exactly once
  const kicks = [];
  const disconnects = [];
  const coreOmid = new ClientCore({
    onKicked: data => kicks.push(data),
    onDisconnected: data => disconnects.push(data)
  });
  const omidInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Omid' });
  coreOmid.connect({ username: 'Omid', linkOrToken: omidInvite.joinLink, serverUrl });
  await sleep(400);
  assert.ok(coreOmid.currentUser, 'Omid failed to join');

  roomManager.kickParticipant(coreOmid.currentUser.id, 'Bye');
  await sleep(300);
  assert.strictEqual(kicks.length, 1, `Kick reported ${kicks.length} times`);
  assert.strictEqual(kicks[0].reason, 'Bye', 'Kick reason not delivered');
  assert.strictEqual(disconnects.length, 0, 'Kick also reported as a lost connection');
  console.log('✓ Test 1 Passed: Kick reported exactly once');

  // 2. An unexpected server-side close is reported as a lost connection
  const coreSara = new ClientCore({
    onKicked: data => kicks.push(data),
    onDisconnected: data => disconnects.push(data)
  });
  const saraInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Sara' });
  coreSara.connect({ username: 'Sara', linkOrToken: saraInvite.joinLink, serverUrl });
  await sleep(400);
  assert.ok(coreSara.currentUser, 'Sara failed to join');
  roomManager.getParticipant(coreSara.currentUser.id).ws.terminate();
  await sleep(300);
  assert.strictEqual(disconnects.length, 1, 'Lost connection not reported');
  console.log('✓ Test 2 Passed: Lost connection reported');

  // 3. A deliberate disconnect fires no callbacks
  const coreReza = new ClientCore({
    onKicked: data => kicks.push(data),
    onDisconnected: data => disconnects.push(data)
  });
  const rezaInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Reza' });
  coreReza.connect({ username: 'Reza', linkOrToken: rezaInvite.joinLink, serverUrl });
  await sleep(400);
  coreReza.disconnect();
  await sleep(300);
  assert.strictEqual(kicks.length + disconnects.length, 2, 'Deliberate disconnect fired callbacks');
  assert.strictEqual(coreReza.currentUser, null, 'Session state not cleared on disconnect');
  console.log('✓ Test 3 Passed: Deliberate disconnect is silent');

  // 4. A bare token without a server address gives a clear error instead of a broken URL
  global.window = { location: { origin: 'null' } }; // as in the file:// desktop app
  let noServerError = null;
  const coreBare = new ClientCore({ onAuthError: err => { noServerError = err; } });
  coreBare.connect({ username: 'Omid', linkOrToken: omidInvite.token });
  assert.ok(noServerError && noServerError.code === 'ERR_NO_SERVER', 'Bare token without server not flagged');
  delete global.window;
  console.log('✓ Test 4 Passed: Bare token without a server address flagged');

  // 5. Unencrypted servers on the network are refused before anything is sent; https and this computer are fine
  let insecureError = null;
  const coreInsecure = new ClientCore({ onAuthError: err => { insecureError = err; } });
  coreInsecure.connect({ username: 'Omid', linkOrToken: omidInvite.joinLink.replace('http://localhost:8094', 'http://192.168.1.10:8080') });
  assert.ok(insecureError && insecureError.code === 'ERR_INSECURE_SERVER', 'http:// link to another computer not refused');
  assert.strictEqual(coreInsecure.ws, null, 'A socket was opened to an unencrypted server');
  for (const origin of ['https://call.example.com', 'https://192.168.1.10:8443', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.ok(ClientCore.isSecureServer(origin), `${origin} should be allowed`);
  }
  for (const origin of ['http://192.168.1.10:8080', 'http://call.example.com', 'http://localhost.evil.com', 'ftp://localhost', 'not a url']) {
    assert.ok(!ClientCore.isSecureServer(origin), `${origin} should be refused`);
  }
  console.log('✓ Test 5 Passed: Unencrypted servers on the network are refused');

  server.close();
  console.log('\n========================================');
  console.log(' ALL CLIENT CONNECTION TESTS PASSED!    ');
  console.log('========================================\n');
  process.exit(0);
}

runConnectionTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
