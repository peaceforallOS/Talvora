/**
 * Server Hardening & Regression Tests
 * Malformed input resilience, session handling, music lock semantics, admin API sanitizing
 */

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const { MessageType, Role, generateToken } = require('../../shared/protocol');

process.env.PORT = '8098';
// Use a throwaway server config, never the real one
process.env.VIDEOCALL_CONFIG = require('path').join(require('os').tmpdir(), `videocall-test-${process.pid}.json`);
process.on('exit', () => require('fs').rmSync(process.env.VIDEOCALL_CONFIG, { force: true }));
const { server, authService, roomManager, adminSessions } = require('../src/index');
// Admin API calls in these tests use a signed-in panel session
const ADMIN_COOKIE = adminSessions.create().cookie.split(';')[0];

const BASE_URL = 'http://localhost:8098';
const WS_URL = 'ws://localhost:8098';

function waitForMessage(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
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

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        Cookie: ADMIN_COOKIE,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function join(username, role = Role.USER) {
  const ws = new WebSocket(WS_URL);
  await new Promise(r => ws.on('open', r));
  const token = role === Role.ADMIN
    ? authService.getAdminToken()
    : authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: username }).token;
  ws.send(JSON.stringify({ type: MessageType.AUTH, username, token }));
  const msg = await waitForMessage(ws, MessageType.AUTH_SUCCESS);
  return { ws, user: msg.user, authMsg: msg };
}

async function runTests() {
  console.log('--- Starting Server Hardening Tests ---');

  // Test 1: Malformed / hostile frames must not crash the server
  const raw = new WebSocket(WS_URL);
  await new Promise(r => raw.on('open', r));
  for (const frame of ['null', '42', '"str"', '[]', '{"type":"auth","username":5,"token":{}}']) {
    raw.send(frame);
  }
  await sleep(200);
  const health = await request('GET', '/api/health');
  assert.strictEqual(health.status, 200, 'Server died after malformed frames');
  raw.close();
  console.log('✓ Test 1 Passed: Server survives malformed WebSocket frames');

  // Test 2: Authenticated users sending malformed payloads do not crash the server
  const admin = await join('Admin', Role.ADMIN);
  const omid = await join('Omid');
  omid.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'public', text: 12345 }));
  omid.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'group', recipients: 'abc', text: 'hi' }));
  omid.ws.send(JSON.stringify({ type: MessageType.MEDIA_STATE_CHANGE, mediaState: null }));
  omid.ws.send(JSON.stringify({ type: MessageType.INVITE_GENERATE, targetUsername: { a: 1 } }));
  omid.ws.send(JSON.stringify({ type: MessageType.SIGNAL, targetPeerId: admin.user.id, signal: null }));
  await sleep(200);
  assert.strictEqual((await request('GET', '/api/health')).status, 200, 'Server died after malformed payloads');
  console.log('✓ Test 2 Passed: Server survives malformed authenticated payloads');

  // Test 3: Media state only accepts known boolean keys
  omid.ws.send(JSON.stringify({ type: MessageType.MEDIA_STATE_CHANGE, mediaState: { audio: true, video: 'yes', evil: 1 } }));
  await sleep(150);
  const omidState = roomManager.getParticipant(omid.user.id).mediaState;
  assert.strictEqual(omidState.audio, true, 'Valid audio flag not applied');
  assert.strictEqual(omidState.video, false, 'Non-boolean video flag was applied');
  assert.ok(!('evil' in omidState), 'Unknown media key was stored');
  console.log('✓ Test 3 Passed: Media state payload sanitized');

  // Test 4: A second auth on an established connection is rejected
  omid.ws.send(JSON.stringify({ type: MessageType.AUTH, username: 'Admin', token: authService.getAdminToken() }));
  const reauth = await waitForMessage(omid.ws, MessageType.AUTH_ERROR);
  assert.strictEqual(reauth.code, 'ERR_ALREADY_AUTHENTICATED', 'Re-auth on same socket was not rejected');
  assert.strictEqual(roomManager.getParticipant(omid.user.id).role, Role.USER, 'Re-auth escalated role');
  console.log('✓ Test 4 Passed: Re-authentication on an established connection rejected');

  // Test 5: Tokens signed for another room are rejected
  const foreignToken = generateToken({ roomId: 'other-room', username: 'Eve', secret: authService.secret });
  const eve = new WebSocket(WS_URL);
  await new Promise(r => eve.on('open', r));
  eve.send(JSON.stringify({ type: MessageType.AUTH, username: 'Eve', token: foreignToken }));
  const eveErr = await waitForMessage(eve, MessageType.AUTH_ERROR);
  assert.strictEqual(eveErr.code, 'ERR_ROOM_MISMATCH', 'Foreign-room token accepted');
  eve.close();
  console.log('✓ Test 5 Passed: Token for a different room rejected');

  // Test 6: Joining again with the same username replaces the stale session
  const kickedPromise = waitForMessage(omid.ws, MessageType.KICKED);
  const omid2 = await join('Omid');
  await kickedPromise;
  await sleep(150);
  const omids = roomManager.getAllPublicUsers().filter(u => u.username === 'Omid');
  assert.strictEqual(omids.length, 1, 'Duplicate session for the same username');
  assert.strictEqual(omids[0].id, omid2.user.id, 'Newest session was not kept');
  console.log('✓ Test 6 Passed: Re-joining replaces the stale session');

  // Test 7: Pausing keeps the music lock; seek reports a fresh position
  const reza = await join('Reza');
  omid2.ws.send(JSON.stringify({ type: MessageType.MUSIC_ACTION, action: 'play', trackInfo: { title: 'Song', audioDataUrl: 'data:audio/mp3;base64,AAAA' } }));
  await waitForMessage(reza.ws, MessageType.MUSIC_STATE);
  omid2.ws.send(JSON.stringify({ type: MessageType.MUSIC_ACTION, action: 'pause' }));
  const paused = await waitForMessage(reza.ws, MessageType.MUSIC_STATE);
  assert.strictEqual(paused.musicState.isPlaying, false, 'Pause did not pause');
  assert.strictEqual(paused.musicState.playedBy.id, omid2.user.id, 'Pause released the lock');

  reza.ws.send(JSON.stringify({ type: MessageType.MUSIC_ACTION, action: 'play', trackInfo: { title: 'Steal' } }));
  const stealErr = await waitForMessage(reza.ws, MessageType.MUSIC_ERROR);
  assert.ok(stealErr.message.includes('Omid'), 'Another user took the lock of a paused track');

  omid2.ws.send(JSON.stringify({ type: MessageType.MUSIC_ACTION, action: 'seek', time: 42 }));
  const seeked = await waitForMessage(reza.ws, MessageType.MUSIC_STATE);
  assert.strictEqual(seeked.musicState.position, 42, 'Seek position not reported');
  console.log('✓ Test 7 Passed: Paused music keeps its lock and seek position syncs');

  // Test 8: Admin polling does not receive the embedded audio payload
  const info = JSON.parse((await request('GET', '/api/admin/info')).data);
  assert.strictEqual(info.musicState.trackInfo.title, 'Song', 'Track title missing from admin info');
  assert.ok(!('audioDataUrl' in info.musicState.trackInfo), 'Admin info includes the audio payload');
  console.log('✓ Test 8 Passed: Admin info omits embedded audio data');

  // Test 9: A paused DJ leaving releases the music lock
  const resetPromise = waitForMessage(reza.ws, MessageType.MUSIC_STATE);
  omid2.ws.close();
  const reset = await resetPromise;
  assert.strictEqual(reset.musicState.playedBy, null, 'Lock not released when the paused DJ left');
  console.log('✓ Test 9 Passed: Music lock released when the DJ leaves');

  // Test 10: Admin permission API ignores unknown keys and non-boolean values
  const permRes = await request('POST', '/api/admin/permissions', {
    userId: reza.user.id,
    permissions: { can_chat: false, can_video: 'no', role: 'admin' }
  });
  assert.strictEqual(permRes.status, 200, 'Permission update failed');
  const rezaUser = roomManager.getParticipant(reza.user.id);
  assert.strictEqual(rezaUser.permissions.can_chat, false, 'Valid permission not applied');
  assert.strictEqual(rezaUser.permissions.can_video, true, 'Non-boolean permission applied');
  assert.ok(!('role' in rezaUser.permissions), 'Unknown permission key stored');
  console.log('✓ Test 10 Passed: Admin permission updates sanitized');

  // Test 11: Static file serving cannot escape its directories
  for (const p of ['/client/..%2f..%2fserver/data/server-config.json', '/shared/%2e%2e/server/data/server-config.json', '/../server/data/server-config.json']) {
    const res = await request('GET', p);
    assert.ok(!res.data.includes('serverSecret'), `Secret leaked via ${p}`);
  }
  assert.strictEqual((await request('GET', '/join')).status, 200, 'Web client not served at /join');
  // After a server update, browsers must not run a cached old script with the new page
  for (const p of ['/join', '/app.js', '/admin']) {
    assert.strictEqual((await request('GET', p)).headers['cache-control'], 'no-cache', `${p} may be served stale from cache`);
  }
  console.log('✓ Test 11 Passed: Static file serving confined to its directories and never stale');

  // Test 12: Without HTTPS the server only listens on this computer and refuses to serve plain HTTP to the network
  assert.strictEqual(server.address().address, '127.0.0.1', 'Plain HTTP must only listen on this computer');
  const { spawnSync } = require('child_process');
  const env = { ...process.env, HOST: '0.0.0.0', PORT: '8093', TURN_PORT: '0' };
  delete env.TLS_MODE;
  delete env.ALLOW_INSECURE_HTTP;
  const refused = spawnSync(process.execPath, [require('path').join(__dirname, '../src/index.js')], { env, encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(refused.status, 1, 'Server started plain HTTP on the network');
  assert.ok(refused.stderr.includes('must be encrypted'), 'Refusal reason not explained');
  console.log('✓ Test 12 Passed: Plain HTTP never reaches the network without an explicit opt-out');

  admin.ws.close();
  reza.ws.close();
  server.close();

  console.log('\n========================================');
  console.log(' ALL SERVER HARDENING TESTS PASSED!     ');
  console.log('========================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
