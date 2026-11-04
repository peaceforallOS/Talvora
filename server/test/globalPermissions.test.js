/**
 * Global permissions: one switch for all invited users at once, also for people not in the room and
 * anyone who joins later. The admin keeps everything, and one person can still be changed afterwards.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const { MessageType } = require('../../shared/protocol');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videocall-global-test-'));
process.env.PORT = '8100';
process.env.VIDEOCALL_CONFIG = path.join(tempDir, 'config.json');
process.env.TURN_PORT = '0';
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { server, authService, roomManager } = require('../src/index');
const AuthService = require('../src/auth');

const BASE_URL = 'http://localhost:8100';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function join(username, token) {
  const ws = new WebSocket('ws://localhost:8100');
  const inbox = [];
  ws.on('message', raw => inbox.push(JSON.parse(raw)));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: MessageType.AUTH, username, token }));
  await wait(150);
  const user = inbox.find(m => m.type === MessageType.AUTH_SUCCESS)?.user;
  assert.ok(user, `${username} could not join`);
  return { ws, inbox, user };
}
const token = name => new URL(authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: name }).joinLink).searchParams.get('token');
const live = name => roomManager.getParticipantByUsername(name).permissions;

let cookie = null;
function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const setAll = (permission, value) => api('POST', '/api/admin/permissions/all', { permission, value });
const allUsers = async () => (await api('GET', '/api/admin/info')).json.allUsers;

async function run() {
  console.log('--- Starting Global Permission Tests ---');

  // 1. Only a signed-in admin, and only real permissions
  assert.strictEqual((await setAll('can_chat', false)).status, 401, 'Needs the management panel login');
  const setup = await api('POST', '/api/admin/setup', { setupToken: authService.setupToken, password: 'correct horse', confirm: 'correct horse' });
  cookie = setup.headers['set-cookie'][0].split(';')[0];
  assert.strictEqual((await setAll('can_fly', true)).status, 400, 'Unknown permission');
  assert.strictEqual((await setAll('can_chat', 'no')).status, 400, 'Not on or off');
  assert.strictEqual((await setAll('__proto__', true)).status, 400);
  console.log('✓ Test 1 Passed: Only the admin can use it, and only for real permissions');

  // 2. The defaults show as they are; every permission has its switch
  const admin = await join('Admin', authService.getAdminToken());
  const ali = await join('Ali', token('Ali'));
  const start = await allUsers();
  assert.deepStrictEqual(Object.keys(start).sort(), ['can_audio', 'can_chat', 'can_invite', 'can_screen', 'can_video'], 'All permissions, not just some');
  assert.deepStrictEqual(start.can_chat, { on: true, mixed: false });
  assert.deepStrictEqual(start.can_audio, { on: false, mixed: false });
  console.log('✓ Test 2 Passed: Every permission has a global state');

  // 3. For everyone in the room at once, and they are told; the admin keeps it
  const asghar = await join('Asghar', token('Asghar'));
  for (const c of [ali, asghar]) c.inbox.length = 0;
  for (const key of Object.keys(start)) {
    const value = !start[key].on;
    const res = await setAll(key, value);
    assert.strictEqual(res.status, 200, key);
    assert.strictEqual(live('Ali')[key], value, `Ali: ${key}`);
    assert.strictEqual(live('Asghar')[key], value, `Asghar: ${key}`);
    assert.strictEqual(live('Admin')[key], true, `The admin always keeps ${key}`);
    assert.deepStrictEqual(res.json.allUsers[key], { on: value, mixed: false });
  }
  await wait(150);
  const toldAli = ali.inbox.filter(m => m.type === MessageType.PERMISSIONS_UPDATED);
  assert.strictEqual(toldAli.length, 5, 'Told once per change');
  assert.strictEqual(toldAli[4].permissions.can_invite, true);
  console.log('✓ Test 3 Passed: All permissions change for everyone at once; the admin is untouched');

  // 4. Turning it off takes effect: chat refused; voice switched off
  await setAll('can_chat', false);
  await setAll('can_audio', true);
  ali.ws.send(JSON.stringify({ type: MessageType.MEDIA_STATE_CHANGE, mediaState: { audio: true } }));
  await wait(100);
  await setAll('can_audio', false);
  assert.strictEqual(roomManager.getParticipantByUsername('Ali').mediaState.audio, false, 'A microphone that was on goes off');
  ali.inbox.length = 0;
  ali.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'public', recipients: [], text: 'blocked' }));
  await wait(100);
  assert.ok(ali.inbox.some(m => m.type === 'error' && /revoked/.test(m.message)), 'Chat is refused');
  console.log('✓ Test 4 Passed: The server enforces it');

  // 5. People who join later, and rejoining
  const later = await join('Later', token('Later'));
  assert.strictEqual(later.user.permissions.can_chat, false, 'Someone new follows the global choice');
  assert.strictEqual(later.user.permissions.can_audio, false);
  await setAll('can_chat', true);
  await setAll('can_video', true);
  const newer = await join('Newer', token('Newer'));
  assert.strictEqual(newer.user.permissions.can_video, true, 'Turned on for all: someone new has it too');
  ali.ws.close();
  await wait(100);
  const aliBack = await join('Ali', token('Ali'));
  assert.strictEqual(aliBack.user.permissions.can_video, true, 'Rejoining keeps it');
  console.log('✓ Test 5 Passed: Applies to people who join later and to rejoining');

  // 6. One person can still differ; the row shows it; the switch brings them back
  const oneOff = await api('POST', '/api/admin/permissions', { userId: live('Asghar') && roomManager.getParticipantByUsername('Asghar').id, permissions: { can_video: false } });
  assert.strictEqual(oneOff.status, 200, 'Changing one person still works');
  assert.strictEqual(live('Asghar').can_video, false);
  assert.strictEqual(live('Newer').can_video, true, 'The others are left alone');
  assert.deepStrictEqual((await allUsers()).can_video, { on: true, mixed: true }, 'The row shows that someone differs');
  asghar.ws.close();
  await wait(100);
  const asgharBack = await join('Asghar', token('Asghar'));
  assert.strictEqual(asgharBack.user.permissions.can_video, false, 'The one-person choice survives rejoining');
  await setAll('can_video', true);
  assert.strictEqual(live('Asghar').can_video, true, 'A later global change replaces it');
  assert.deepStrictEqual((await allUsers()).can_video, { on: true, mixed: false });
  console.log('✓ Test 6 Passed: Per-person changes still work, on top of the global choice');

  // 7. People not in the room follow it too
  asgharBack.ws.close();
  await wait(100);
  await setAll('can_video', false);
  const offlineBack = await join('Asghar', token('Asghar'));
  assert.strictEqual(offlineBack.user.permissions.can_video, false, 'Someone away with a saved choice follows it when back');
  console.log('✓ Test 7 Passed: People not in the room follow it');

  // 8. A restart keeps it, including the screen-sharing rule for old saved settings
  await setAll('can_screen', false);
  await setAll('can_video', true);
  const raw = JSON.parse(fs.readFileSync(process.env.VIDEOCALL_CONFIG, 'utf8'));
  assert.strictEqual(raw.globalPermissions.can_screen, false, 'Saved');
  const restarted = new AuthService({ configPath: process.env.VIDEOCALL_CONFIG });
  assert.strictEqual(restarted.getInvitedPermissions().can_screen, false);
  assert.strictEqual(restarted.getInvitedPermissions().can_video, true);
  assert.strictEqual(restarted.permissionOverrides.asghar.can_screen, false, 'Video on does not bring screen sharing back after a restart');
  fs.writeFileSync(process.env.VIDEOCALL_CONFIG, JSON.stringify({ ...raw, globalPermissions: { can_fly: true, can_chat: 'yes', can_audio: true } }));
  const odd = new AuthService({ configPath: process.env.VIDEOCALL_CONFIG });
  assert.deepStrictEqual(odd.globalPermissions, { can_audio: true }, 'Anything unknown in the file is ignored');
  fs.writeFileSync(process.env.VIDEOCALL_CONFIG, JSON.stringify(raw));
  console.log('✓ Test 8 Passed: Survives a restart');

  for (const c of [admin, later, newer, aliBack, offlineBack]) c.ws.close();
  server.close();
  console.log('\n=============================================');
  console.log(' ALL GLOBAL PERMISSION TESTS PASSED!');
  console.log('=============================================\n');
  process.exit(0);
}

run().catch(err => {
  console.error('Global permission test failure:', err);
  process.exit(1);
});
