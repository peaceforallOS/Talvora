/**
 * Test the embedded TURN relay's credential lifecycle, quota and socket cleanup
 */

const assert = require('assert');

process.env.TURN_PORT = '34781';
const TurnRelay = require('../src/turnServer');

function runTurnTests() {
  console.log('--- Starting TURN Relay Tests ---');

  const relay = new TurnRelay();
  relay.start();
  const credentials = relay.server.authentification.credentials;

  // 1. Per-participant credentials in the ICE servers handed to an authenticated client
  const iceServers = relay.getIceServers('192.0.2.10:8080', 'conn_a');
  const turn = iceServers.find(s => String(s.urls).startsWith('turn:'));
  assert.strictEqual(turn.urls, 'turn:192.0.2.10:34781?transport=udp');
  assert.strictEqual(credentials[turn.username], turn.credential, 'Credentials must be registered with the relay');
  assert.notStrictEqual(relay.getIceServers('192.0.2.10', 'conn_b')[1].username, turn.username, 'Each participant gets their own credentials');
  console.log('✓ Test 1 Passed: Each participant receives their own TURN credentials');

  // 2. IPv6 and malformed Host headers
  assert.strictEqual(relay.getIceServers('[2001:db8::1]:8080', 'conn_c')[1].urls, 'turn:[2001:db8::1]:34781?transport=udp');
  assert.ok(!relay.getIceServers('[::1', 'conn_d').some(s => String(s.urls).startsWith('turn:')), 'Malformed host must not produce a TURN entry');
  console.log('✓ Test 2 Passed: Host header parsed safely');

  // 3. Leaving revokes credentials and closes that participant's relay sockets
  let closed = 0;
  relay.server.allocations['fake-5-tuple'] = {
    user: { username: turn.username },
    timer: null,
    sockets: [{ close: () => closed++ }]
  };
  assert.ok(relay.server.allocate.checkQuota(turn.username), 'Quota should allow a few allocations');
  relay.revokeCredentials('conn_a');
  assert.strictEqual(credentials[turn.username], undefined, 'Credentials must be revoked');
  assert.strictEqual(closed, 1, 'Relay sockets must be closed');
  assert.strictEqual(Object.keys(relay.server.allocations).length, 0, 'Allocation must be dropped');
  console.log('✓ Test 3 Passed: Leaving revokes credentials and frees relay ports');

  // 4. Refresh settings that node-turn reads but does not define
  assert.strictEqual(relay.server.defaultLifetime, 600);
  assert.strictEqual(relay.server.maxAllocateTimeout, 3600);
  console.log('✓ Test 4 Passed: Allocation refresh lifetimes configured');

  relay.stop();
  console.log('\n=============================================');
  console.log(' ALL TURN RELAY TESTS PASSED!               ');
  console.log('=============================================\n');
}

runTurnTests();
