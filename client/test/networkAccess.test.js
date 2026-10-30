/**
 * Test the connection check (which server ports are reachable) and the local firewall helpers
 */

const assert = require('assert');
const http = require('http');
const ConnectionCheck = require('../src/connectionCheck');
const firewall = require('../firewall');

// Imitates RTCPeerConnection gathering against a STUN server that answers, is silent, or is local
function fakeRtc(behaviour) {
  return class {
    constructor() {
      this.iceGatheringState = 'new';
      setTimeout(() => {
        if (behaviour === 'answers') this.onicecandidate({ candidate: { type: 'srflx' } });
        if (behaviour === 'unreachable') this.onicecandidateerror({ errorCode: 701 });
        if (behaviour === 'silent') return; // a blocked port: no answer, gathering keeps waiting
        this.iceGatheringState = 'complete';
        this.onicegatheringstatechange();
      }, 20);
    }
    createDataChannel() {}
    async createOffer() { return {}; }
    async setLocalDescription() {}
    close() {}
  };
}

async function runNetworkAccessTests() {
  console.log('--- Starting Network Access Tests ---');

  // 1. Web port: a running server is reachable, a closed port is reported
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404);
    res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepStrictEqual(await ConnectionCheck.checkWeb(origin), { ok: true });
  server.close();
  assert.strictEqual((await ConnectionCheck.checkWeb(origin)).ok, false, 'A closed port must be reported');
  console.log('✓ Test 1 Passed: Web port reachability detected');

  // 2. Media relay port (UDP): answer, no answer, and same-network servers
  assert.deepStrictEqual(await ConnectionCheck.checkMedia('203.0.113.5', fakeRtc('answers')), { ok: true });
  assert.strictEqual((await ConnectionCheck.checkMedia('203.0.113.5', fakeRtc('unreachable'))).ok, false);
  assert.deepStrictEqual(await ConnectionCheck.checkMedia('203.0.113.5', fakeRtc('silent'), 200), { ok: false, reason: 'no answer on UDP' },
    'No answer in time means UDP is blocked');
  assert.deepStrictEqual(await ConnectionCheck.checkMedia('192.168.1.10', fakeRtc('local')), { ok: true },
    'On the same network no separate address comes back, but no error either');
  console.log('✓ Test 2 Passed: Media relay port reachability detected');

  // 3. Advice: this computer's firewall can be fixed with permission; other blocks are explained
  const https = 'https://call.example.com';
  const allOk = { web: { ok: true }, media: { ok: true }, firewall: { firewall: 'ufw', blocking: false } };
  assert.strictEqual(ConnectionCheck.explain(https, allOk).ok, true);

  const localBlock = ConnectionCheck.explain(https, {
    web: { ok: false, reason: 'no answer' }, media: { ok: false, reason: 'no answer on UDP' },
    firewall: { firewall: 'ufw', blocking: true, canFix: true }
  });
  assert.ok(localBlock.fixable && /ufw on this computer may be blocking/.test(localBlock.advice));
  assert.deepStrictEqual(localBlock.problems.map(p => p.split(':')[0]), ['port 443/tcp (app and sign-in)', 'port 3478/udp (audio and video relay)']);

  const serverDown = ConnectionCheck.explain('https://call.example.com:8443', {
    web: { ok: false, reason: 'connection refused or blocked' }, media: { ok: false, reason: 'no answer on UDP' }, firewall: null
  });
  assert.ok(!serverDown.fixable && /port 8443 is not open on the server/.test(serverDown.advice));

  const udpBlocked = ConnectionCheck.explain(https, { web: { ok: true }, media: { ok: false, reason: 'no answer on UDP' }, firewall: null });
  assert.ok(!udpBlocked.fixable && /UDP ports 3478/.test(udpBlocked.advice));

  const windowsNoRule = ConnectionCheck.explain(https, {
    web: { ok: true }, media: { ok: true }, firewall: { firewall: 'Windows Firewall', blocking: true, canFix: true }
  });
  assert.ok(windowsNoRule.fixable && /faster/.test(windowsNoRule.advice), 'Missing Windows rule is an improvement, not a failure');
  console.log('✓ Test 3 Passed: Advice distinguishes this computer, the network and the server');

  // 4. Windows: one elevated command removes old rules and allows this program in and out
  const command = firewall.windowsAllowCommand('C:\\Users\\Omid\\AppData\\Local\\Temp\\Talvora\\Talvora.exe');
  assert.strictEqual(command.split(' & ').length, 4);
  assert.ok(command.includes('delete rule name="VideoCall"'), 'The rule from the app\'s earlier name must be removed');
  assert.ok(command.includes('delete rule name="Talvora"'));
  assert.ok(command.includes('dir=in action=allow program="C:\\Users\\Omid\\AppData\\Local\\Temp\\Talvora\\Talvora.exe"'));
  assert.ok(command.includes('dir=out action=allow'));
  assert.ok(!firewall.windowsAllowCommand('C:\\a"b.exe').includes('a"b'), 'Quotes must not break out of the program path');
  console.log('✓ Test 4 Passed: Windows Firewall rule command built safely');

  // 5. Linux: only ufw blocking outgoing traffic counts as blocking
  const files = (enabled, policy) => file => (file.endsWith('ufw.conf') ? `ENABLED=${enabled}` : `DEFAULT_OUTPUT_POLICY="${policy}"`);
  assert.deepStrictEqual(firewall.linuxStatus(files('no', 'DROP')), { firewall: null, blocking: false, canFix: false });
  assert.deepStrictEqual(firewall.linuxStatus(files('yes', 'ACCEPT')), { firewall: 'ufw', blocking: false, canFix: false });
  assert.deepStrictEqual(firewall.linuxStatus(files('yes', 'REJECT')), { firewall: 'ufw', blocking: true, canFix: true });
  console.log('✓ Test 5 Passed: Linux firewall blocking detected');

  // 6. Windows: the PowerShell that opens the administrator prompt is started in advance, so it
  //    answers at once; a declined prompt (Start-Process throws) is reported as not allowed
  if (process.platform === 'win32') {
    assert.strictEqual(await firewall.prepareElevation(), true, 'Helper did not start'); // while the user reads the dialog
    const started = Date.now();
    assert.strictEqual(await firewall.runPowerShell('try { throw "declined" } catch { exit 1 }'), 1);
    const warm = Date.now() - started;
    assert.ok(warm < 1000, `Prepared PowerShell took ${warm} ms to answer`);
    assert.strictEqual(await firewall.runPowerShell('exit 0'), 0, 'Without a prepared helper a new one is used');
    firewall.prepareElevation();
    firewall.releaseElevation();
    console.log(`✓ Test 6 Passed: Administrator prompt ready in advance (answered in ${warm} ms)`);
  }

  console.log('\n=============================================');
  console.log(' ALL NETWORK ACCESS TESTS PASSED!           ');
  console.log('=============================================\n');
}

runNetworkAccessTests().catch(err => {
  console.error('Network access test failure:', err);
  process.exit(1);
});
