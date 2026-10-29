/**
 * Test automatic port forwarding (UPnP) with a simulated router — no real router is touched
 */

const assert = require('assert');
const PortAccess = require('../src/portAccess');

// Behaves like a UPnP router: records forwards and can refuse ports
function fakeRouter({ taken = [], publicIp = '203.0.113.50' } = {}) {
  const forwards = new Map();
  return {
    forwards,
    name: 'Test Router',
    localAddress: '192.168.1.20',
    externalIp: async () => publicIp,
    async addPortMapping(protocol, port, lease) {
      if (taken.includes(`${protocol}:${port}`)) throw Object.assign(new Error('ConflictInMappingEntry'), { code: 718 });
      forwards.set(`${protocol}:${port}`, lease);
    },
    async deletePortMapping(protocol, port) {
      forwards.delete(`${protocol}:${port}`);
    }
  };
}

const quiet = () => {};
const ports = [
  { protocol: 'TCP', port: 443, purpose: 'HTTPS' },
  { protocol: 'TCP', port: 80, purpose: 'Certificate checks' },
  { protocol: 'UDP', port: 3478, purpose: 'Media relay' }
];
const ranges = [{ protocol: 'UDP', from: 49152, to: 49155, purpose: 'Media relay channels' }];
const settle = () => new Promise(r => setTimeout(r, 50));

async function runPortAccessTests() {
  console.log('--- Starting Port Access Tests ---');

  // 1. Behind a UPnP router: every port forwarded to this machine, public IP learned
  const router = fakeRouter();
  const access = new PortAccess({ ports, ranges, discover: async () => router, log: quiet });
  const status = await access.start();
  await settle();
  assert.strictEqual(status.method, 'upnp');
  assert.strictEqual(status.publicIp, '203.0.113.50');
  assert.deepStrictEqual([...router.forwards.keys()].sort(),
    ['TCP:443', 'TCP:80', 'UDP:3478', 'UDP:49152', 'UDP:49153', 'UDP:49154', 'UDP:49155'].sort());
  assert.ok(access.report().ports.every(p => p.state === 'forwarded'), 'All ports must be reported as forwarded');
  console.log('✓ Test 1 Passed: Ports forwarded automatically by the router');

  // 2. Shutting down removes the forwards again
  await access.stop();
  assert.strictEqual(router.forwards.size, 0, 'Forwards must be removed on shutdown');
  console.log('✓ Test 2 Passed: Router forwards removed on shutdown');

  // 3. A port already forwarded to another device is reported with the reason
  const busy = new PortAccess({ ports, discover: async () => fakeRouter({ taken: ['TCP:443'] }), log: quiet });
  await busy.start();
  const https = busy.report().ports.find(p => p.label === '443/tcp');
  assert.strictEqual(https.state, 'failed');
  assert.strictEqual(https.error, 'already forwarded to another device');
  await busy.stop();
  console.log('✓ Test 3 Passed: Conflicting router forwards reported clearly');

  // 4. Routers that only accept permanent forwards still work (real UPnP client, simulated replies)
  const permanent = new PortAccess.UpnpGateway({ controlUrl: 'http://router/ctl', serviceType: 'x', name: 'Old Router', localAddress: '192.168.1.20' });
  const leases = [];
  permanent.soap = async (action, args) => {
    if (action === 'GetExternalIPAddress') return '<NewExternalIPAddress>203.0.113.50</NewExternalIPAddress>';
    if (action === 'AddPortMapping' && args.NewLeaseDuration !== 0) {
      throw Object.assign(new Error('OnlyPermanentLeasesSupported'), { code: 725 });
    }
    if (action === 'AddPortMapping') leases.push(args.NewLeaseDuration);
    return '';
  };
  const legacy = new PortAccess({ ports, discover: async () => permanent, log: quiet });
  await legacy.start();
  assert.ok(legacy.report().ports.every(p => p.state === 'forwarded'));
  assert.deepStrictEqual(leases, [0, 0, 0], 'Must retry with a permanent lease');
  await legacy.stop();
  console.log('✓ Test 4 Passed: Permanent-only routers supported');

  // 5. No UPnP router: manual instructions naming the exact ports and this machine
  const messages = [];
  const manual = new PortAccess({ ports, ranges, discover: async () => null, log: m => messages.push(m) });
  assert.strictEqual((await manual.start()).method, 'manual');
  assert.ok(messages[0].includes('443/tcp, 80/tcp, 3478/udp, 49152-49155/udp'), messages[0]);
  assert.ok(manual.report().ports.every(p => p.state === 'manual'));
  console.log('✓ Test 5 Passed: Without UPnP the exact ports to forward are reported');

  // 6. Carrier-grade NAT: the router has no public address, so it is not offered as one
  const cgnat = new PortAccess({ ports, discover: async () => fakeRouter({ publicIp: '100.72.1.9' }), log: quiet });
  assert.strictEqual((await cgnat.start()).publicIp, null);
  await cgnat.stop();
  console.log('✓ Test 6 Passed: Carrier-grade NAT detected');

  // 7. Disabled (development, tests): the router is never contacted
  let contacted = false;
  const off = new PortAccess({ ports, enabled: false, discover: async () => { contacted = true; }, log: quiet });
  assert.strictEqual((await off.start()).method, 'disabled');
  assert.strictEqual(contacted, false);
  console.log('✓ Test 7 Passed: Router untouched when port forwarding is off');

  console.log('\n=============================================');
  console.log(' ALL PORT ACCESS TESTS PASSED!              ');
  console.log('=============================================\n');
}

runPortAccessTests().catch(err => {
  console.error('Port access test failure:', err);
  process.exit(1);
});
