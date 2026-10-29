/**
 * Test the recent-servers history and server ping
 */

const assert = require('assert');
const http = require('http');
const ServerHistory = require('../src/serverHistory');

function memoryStorage() {
  const data = {};
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); }
  };
}

async function runServerHistoryTests() {
  console.log('--- Starting Recent Servers Tests ---');

  // 1. Recording joins: one entry per server and username, newest first
  const history = new ServerHistory(memoryStorage());
  history.record({ username: 'Omid', link: 'http://10.0.0.5:8080/join?room=main-room&user=Omid&token=a.b', roomId: 'main-room' });
  history.record({ username: 'Omid', link: 'http://203.0.113.9:8080/join?room=main-room&user=Omid&token=c.d', roomId: 'main-room' });
  history.record({ username: 'omid', link: 'http://10.0.0.5:8080/join?room=main-room&user=omid&token=e.f', roomId: 'main-room' });
  let entries = history.list();
  assert.strictEqual(entries.length, 2, 'Same server and username must be one entry');
  assert.strictEqual(entries[0].server, 'http://10.0.0.5:8080', 'Most recent server must come first');
  assert.ok(entries[0].link.endsWith('token=e.f'), 'Reconnect must use the latest link');
  console.log('✓ Test 1 Passed: Joins recorded once per server and user, newest first');

  // 2. Bare tokens (no server address) are not recorded; entries can be removed
  assert.strictEqual(history.record({ username: 'Omid', link: 'abc.def' }), null);
  history.remove(entries[1]);
  assert.deepStrictEqual(history.list().map(e => e.server), ['http://10.0.0.5:8080']);
  console.log('✓ Test 2 Passed: Links without a server are skipped and entries can be removed');

  // 3. The list is capped and survives corrupted storage
  for (let i = 0; i < 20; i++) history.record({ username: `U${i}`, link: `http://10.0.1.${i}:8080/join?token=x.y` });
  assert.strictEqual(history.list().length, 12, 'History must be capped');
  const broken = memoryStorage();
  broken.setItem('vc_server_history', '{not json');
  assert.deepStrictEqual(new ServerHistory(broken).list(), [], 'Corrupt storage must not crash');
  console.log('✓ Test 3 Passed: History capped and resilient to corrupt storage');

  // 4. Ping: online with latency, server errors and unreachable servers reported as offline
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end('{"status":"healthy"}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const online = await ServerHistory.ping(`http://127.0.0.1:${port}`);
  assert.ok(online.online && Number.isInteger(online.ms), 'Running server must be online');
  server.close();
  const offline = await ServerHistory.ping(`http://127.0.0.1:${port}`);
  assert.deepStrictEqual(offline, { online: false, reason: 'Unreachable' }, 'Stopped server must be offline');
  const failing = await ServerHistory.ping('http://x', async () => ({ ok: false, status: 503 }));
  assert.deepStrictEqual(failing, { online: false, reason: 'Server error (503)' });
  console.log('✓ Test 4 Passed: Ping reports online latency and offline servers');

  console.log('\n=============================================');
  console.log(' ALL RECENT SERVERS TESTS PASSED!           ');
  console.log('=============================================\n');
}

runServerHistoryTests().catch(err => {
  console.error('Recent servers test failure:', err);
  process.exit(1);
});
