/**
 * Test Admin Web Management Panel HTTP Endpoints & Live Actions
 */

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const { MessageType } = require('../../shared/protocol');

process.env.PORT = '8098';
// Keep test revocations out of the real server config and leave the TURN port to a running server
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.VIDEOCALL_CONFIG = path.join(os.tmpdir(), `videocall-admin-test-${process.pid}.json`);
process.env.TURN_PORT = '0';
process.on('exit', () => fs.rmSync(process.env.VIDEOCALL_CONFIG, { force: true }));
const { server, authService, roomManager, adminSessions, releaseWatcher, panelUpdater } = require('../src/index');
const AdminSessions = require('../src/adminSession');

const BASE_URL = 'http://localhost:8098';

let sessionCookie = null; // panel session, sent with every request once signed in

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    if (sessionCookie) options = { ...options, headers: { ...options.headers, Cookie: sessionCookie } };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch(e) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runAdminPanelTests() {
  console.log('--- Starting Section 3: Admin Web Panel Tests ---');

  const creds = authService.getAdminCredentials(BASE_URL);
  const adminToken = creds.adminToken;

  // 1. Test Static files
  const htmlRes = await httpRequest({ host: 'localhost', port: 8098, path: '/admin', method: 'GET' });
  assert.ok(htmlRes.statusCode === 200, 'HTML status check failed');
  assert.ok(htmlRes.body.includes('src="admin.js"') && htmlRes.body.includes('id="users-tbody"'), 'HTML content check failed');
  console.log('✓ Test 1 Passed: Admin panel HTML page served successfully');

  const cssRes = await httpRequest({ host: 'localhost', port: 8098, path: '/admin.css', method: 'GET' });
  assert.ok(cssRes.statusCode === 200, 'CSS status check failed');
  assert.ok(cssRes.headers['content-type'].includes('text/css'), 'CSS mime check failed');
  console.log('✓ Test 2 Passed: Admin panel CSS stylesheet served with correct MIME');

  // 2. Test Unauthorized access to /api/admin/info
  const unauthRes = await httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/info', method: 'GET' });
  assert.ok(unauthRes.statusCode === 401, 'Unauthorized check failed');
  console.log('✓ Test 3 Passed: Unauthorized access without token correctly rejected with 401');

  // 3b. First visit: choose the panel password (needs the panel link token, entered twice)
  const post = (path, body) => httpRequest({
    host: 'localhost', port: 8098, path, method: 'POST', headers: { 'Content-Type': 'application/json' }
  }, body);
  const getSession = () => httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/session', method: 'GET' });

  assert.deepStrictEqual((await getSession()).json, { passwordSet: false, authenticated: false, expiresAt: null });
  const setupToken = authService.setupToken;
  assert.ok(creds.panelUrl.endsWith(`/admin?setup=${setupToken}`), 'First-visit panel link must carry the setup token');
  assert.strictEqual((await post('/api/admin/setup', { password: 'correct horse', confirm: 'correct horse' })).statusCode, 401,
    'Setup without the panel link token must be refused');
  assert.strictEqual((await post('/api/admin/setup', { setupToken: adminToken, password: 'correct horse', confirm: 'correct horse' })).statusCode, 401,
    "The admin's app link must not be able to claim the panel");
  assert.strictEqual((await post('/api/admin/setup', { setupToken, password: 'correct horse', confirm: 'correct house' })).statusCode, 400,
    'Mismatched confirmation must be refused');
  assert.strictEqual((await post('/api/admin/setup', { setupToken, password: 'short', confirm: 'short' })).statusCode, 400,
    'Too-short password must be refused');
  assert.strictEqual((await post('/api/admin/login', { password: 'correct horse' })).statusCode, 409, 'Login before setup must be refused');

  const setupRes = await post('/api/admin/setup', { setupToken, password: 'correct horse', confirm: 'correct horse' });
  assert.strictEqual(setupRes.statusCode, 200, 'Setup failed');
  const setCookie = setupRes.headers['set-cookie'][0];
  assert.ok(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), 'Session cookie must be HttpOnly and SameSite');
  assert.ok(!/Expires|Max-Age/i.test(setCookie), 'Session cookie must end when the browser closes');
  assert.ok(!JSON.stringify(require('fs').readFileSync(process.env.VIDEOCALL_CONFIG, 'utf8')).includes('correct horse'), 'Password stored in plain text');
  assert.strictEqual((await post('/api/admin/setup', { setupToken, password: 'hijacked1', confirm: 'hijacked1' })).statusCode, 409,
    'The password must not be replaceable through setup');
  assert.strictEqual(authService.setupToken, null, 'The one-time setup token must be deleted');
  assert.ok(authService.getAdminCredentials(BASE_URL).panelUrl.endsWith('/admin'), 'Panel link must no longer carry a secret');
  sessionCookie = setCookie.split(';')[0];

  const session = (await getSession()).json;
  assert.ok(session.authenticated && session.passwordSet, 'Setup must sign the admin in');
  assert.ok(Math.abs(session.expiresAt - (Date.now() + 3 * 3600 * 1000)) < 5000, 'Session must last 3 hours');
  console.log('✓ Test 3b Passed: First visit sets a confirmed password and signs in with a browser-session cookie');

  // 3. The admin opens the room, then a dummy user joins via WebSocket as an active room participant
  const adminWs = new WebSocket('ws://localhost:8098');
  await new Promise(r => adminWs.on('open', r));
  adminWs.send(JSON.stringify({ type: MessageType.AUTH, username: 'Admin', token: authService.getAdminToken() }));
  await new Promise(r => adminWs.on('message', raw => {
    if (JSON.parse(raw).type === MessageType.AUTH_SUCCESS) r();
  }));

  const invite = authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: 'Tester1' });
  const ws = new WebSocket('ws://localhost:8098');
  await new Promise(r => ws.on('open', r));

  ws.send(JSON.stringify({
    type: MessageType.AUTH,
    username: 'Tester1',
    token: invite.token
  }));

  await new Promise(r => ws.on('message', raw => {
    const d = JSON.parse(raw);
    if (d.type === MessageType.AUTH_SUCCESS) r();
  }));
  console.log('Dummy user "Tester1" joined room.');

  // 4. Test Authorized access to /api/admin/info
  const authRes = await httpRequest({
    host: 'localhost',
    port: 8098,
    path: '/api/admin/info',
    method: 'GET'
  });
  assert.ok(authRes.statusCode === 200, 'Authorized check failed');
  assert.ok(authRes.json.participants.length >= 1, 'Participants count check failed');
  const tester1 = authRes.json.participants.find(u => u.username === 'Tester1');
  assert.ok(!!tester1, 'Tester1 not found in participants');
  assert.ok(tester1.permissions.can_invite === false, 'can_invite should default to false');
  console.log('✓ Test 4 Passed: Admin panel info returned active participants and permissions');

  // 5. Test Live Permission Update via Admin Panel API
  // Enable can_invite for Tester1
  const permRes = await httpRequest({
    host: 'localhost',
    port: 8098,
    path: '/api/admin/permissions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    token: adminToken,
    userId: tester1.id,
    permissions: {
      ...tester1.permissions,
      can_invite: true,
      can_chat: false
    }
  });

  assert.ok(permRes.statusCode === 200, 'Permission update status failed');
  assert.ok(permRes.json.permissions.can_invite === true, 'can_invite not updated');
  assert.ok(permRes.json.permissions.can_chat === false, 'can_chat not updated');
  console.log('✓ Test 5 Passed: Admin panel updated live user permissions (can_invite: true, can_chat: false)');

  // 6. Test In-Panel Invite Link Generation
  const inviteRes = await httpRequest({
    host: 'localhost',
    port: 8098,
    path: '/api/admin/invite',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    token: adminToken,
    targetUsername: 'NewUser123',
    canInvite: false
  });

  assert.ok(inviteRes.statusCode === 200, 'Invite generation failed');
  assert.ok(inviteRes.json.joinLink.includes('user=NewUser123'), 'Invite link missing username');
  console.log('✓ Test 6 Passed: In-panel invite link generator generated valid user-locked link');

  // 7. The panel offers exactly the permissions the app has
  assert.deepStrictEqual(Object.keys(roomManager.getParticipant(tester1.id).permissions).sort(),
    ['can_audio', 'can_chat', 'can_invite', 'can_screen', 'can_video'], 'Unexpected permissions');
  const panelPage = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
  for (const key of ['can_audio', 'can_video', 'can_screen', 'can_chat', 'can_invite']) {
    assert.ok(panelPage.includes(`createSwitch(user.id, '${key}'`), `The panel has no switch for ${key}`);
  }
  console.log('✓ Test 7 Passed: Participants carry audio, video, screen, chat and invite permissions, each with its own switch');

  // 8. Test Kick User API
  const kickRes = await httpRequest({
    host: 'localhost',
    port: 8098,
    path: '/api/admin/kick',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    token: adminToken,
    userId: tester1.id,
    reason: 'Admin test kick'
  });

  assert.ok(kickRes.statusCode === 200, 'Kick API failed');
  assert.ok(!roomManager.getParticipantByUsername('Tester1') && roomManager.participants.size === 1, 'User should be removed from room');
  console.log('✓ Test 8 Passed: Admin panel kicked user and room state updated immediately');

  const joinAs = (username, token) => new Promise(resolve => {
    const sock = new WebSocket('ws://localhost:8098');
    sock.on('open', () => sock.send(JSON.stringify({ type: MessageType.AUTH, username, token })));
    sock.on('message', raw => {
      const d = JSON.parse(raw);
      if (d.type === MessageType.AUTH_SUCCESS || d.type === MessageType.AUTH_ERROR) resolve({ sock, msg: d });
    });
  });

  // 8b. Rejoining with the same link keeps the permissions the admin set (Test 5), also after a restart
  const back = await joinAs('tester1', invite.token);
  assert.strictEqual(back.msg.type, MessageType.AUTH_SUCCESS, 'Tester1 should be able to rejoin');
  assert.strictEqual(back.msg.user.permissions.can_chat, false, 'Revoked chat must stay revoked after rejoining');
  assert.strictEqual(back.msg.user.permissions.can_invite, true, 'Granted invite must survive rejoining');
  const AuthService = require('../src/auth');
  assert.deepStrictEqual({ ...new AuthService().permissionOverrides.tester1 }, { ...tester1.permissions, can_invite: true, can_chat: false },
    'Permission changes must be saved to the server config');
  // A saved permission this version no longer has (from an older version's config) is dropped on load
  const saved = JSON.parse(fs.readFileSync(process.env.VIDEOCALL_CONFIG, 'utf8'));
  saved.permissionOverrides.tester1.can_old_feature = false;
  fs.writeFileSync(process.env.VIDEOCALL_CONFIG, JSON.stringify(saved));
  assert.ok(!('can_old_feature' in new AuthService().permissionOverrides.tester1), 'Unknown saved permissions must be dropped');
  // Saved before screen sharing had its own switch: Video allowed it, so whoever had Video keeps it
  saved.permissionOverrides.olduser = { can_video: true, can_chat: true };
  saved.permissionOverrides.oldquiet = { can_video: false };
  fs.writeFileSync(process.env.VIDEOCALL_CONFIG, JSON.stringify(saved));
  const migrated = new AuthService().permissionOverrides;
  assert.strictEqual(migrated.olduser.can_screen, true, 'Video granted before 1.10.0 must keep screen sharing');
  assert.ok(!('can_screen' in migrated.oldquiet), 'Without video before, screen sharing stays at its default (off)');
  roomManager.kickParticipant(roomManager.getParticipantByUsername('Tester1').id);
  back.sock.close();
  console.log('✓ Test 8b Passed: Permissions set by the admin survive rejoining and restarts');

  // 9. Remove User: kicks the user and voids their invite link; a fresh link works again

  const removable = authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: 'Removable' });
  const first = await joinAs('Removable', removable.token);
  assert.strictEqual(first.msg.type, MessageType.AUTH_SUCCESS, 'Removable should join');
  const kickedMsg = new Promise(r => first.sock.on('message', raw => {
    if (JSON.parse(raw).type === MessageType.KICKED) r();
  }));

  const removeRes = await httpRequest({
    host: 'localhost', port: 8098, path: '/api/admin/remove', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { token: adminToken, userId: roomManager.getParticipantByUsername('Removable').id });
  assert.strictEqual(removeRes.statusCode, 200, 'Remove API failed');
  await kickedMsg;
  assert.ok(!roomManager.getParticipantByUsername('Removable'), 'Removed user should leave the room');

  const retry = await joinAs('Removable', removable.token);
  assert.strictEqual(retry.msg.code, 'ERR_LINK_REVOKED', 'Old invite link should be revoked');

  const reinvite = authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: 'removable' });
  const rejoin = await joinAs('Removable', reinvite.token);
  assert.strictEqual(rejoin.msg.type, MessageType.AUTH_SUCCESS, 'A new invite link should work');

  const removeAdminRes = await httpRequest({
    host: 'localhost', port: 8098, path: '/api/admin/remove', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { token: adminToken, username: 'Admin' });
  assert.strictEqual(removeAdminRes.statusCode, 400, 'The admin must not be removable');
  [first.sock, retry.sock, rejoin.sock].forEach(sock => sock.close());
  console.log('✓ Test 9 Passed: Remove User kicked the user, revoked their link, and a new invite works');

  // 9b. Updating from the panel: only when a newer release exists and the server can ask for it;
  // the request goes to the root update service (data/update-request), progress to update-status.json
  const dataDir = path.dirname(process.env.VIDEOCALL_CONFIG);
  const requestFile = path.join(dataDir, 'update-request');
  const statusFile = path.join(dataDir, 'update-status.json');
  fs.rmSync(requestFile, { force: true });
  fs.rmSync(statusFile, { force: true });
  const update = () => post('/api/admin/update', {});
  assert.strictEqual((await update()).statusCode, 409, 'Nothing to update to');
  releaseWatcher.check = async () => ({ version: '99.0.0', releaseUrl: 'https://example/r' });
  const checked = await post('/api/admin/release/check', {});
  assert.strictEqual(checked.statusCode, 200);
  assert.ok(checked.json.release.available && checked.json.release.latest === '99.0.0', '"Check now" must find the new release');
  const realMethod = panelUpdater.method;
  panelUpdater.method = () => null; // e.g. a system install without the update service
  const noWay = await update();
  assert.strictEqual(noWay.statusCode, 409);
  assert.ok(noWay.json.error.includes('sudo videocall-server update'), 'Without a way to update, the panel names the command');
  panelUpdater.method = () => 'service';
  let panelInfo = (await httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/info', method: 'GET' })).json;
  assert.ok(panelInfo.release.canUpdate, 'The panel must offer the Update button');
  const started = await update();
  assert.strictEqual(started.statusCode, 202, 'Update not started');
  assert.ok(fs.existsSync(requestFile), 'The request for the root update service was not written');
  panelInfo = (await httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/info', method: 'GET' })).json;
  assert.strictEqual(panelInfo.release.update.state, 'running');
  assert.strictEqual(panelInfo.release.update.version, '99.0.0');
  assert.strictEqual((await update()).statusCode, 409, 'A second update must wait for the first');
  // The updater (another process, possibly root) reports a failure; the panel shows it and allows a retry
  require('../src/releases').writeUpdateStatus(dataDir, { state: 'failed', version: '99.0.0', message: 'Could not check for updates: GitHub answered 403' });
  panelInfo = (await httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/info', method: 'GET' })).json;
  assert.strictEqual(panelInfo.release.update.state, 'failed');
  assert.ok(panelInfo.release.update.message.includes('403'));
  panelUpdater.method = realMethod;
  releaseWatcher.state = { ...releaseWatcher.state, available: false, latest: null };
  fs.rmSync(requestFile, { force: true });
  fs.rmSync(statusFile, { force: true });
  const panelScript = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
  assert.ok(panelScript.includes("'/api/admin/update'") && panelScript.includes("'/api/admin/release/check'"), 'The panel must call the update and check APIs');
  console.log('✓ Test 9b Passed: Update and "Check now" from the panel, with progress and errors');

  // 9c. Panel sign-ins survive a restart (an update restarts the server); the saved file holds no usable cookie
  const sessionFile = path.join(dataDir, `admin-sessions-test-${process.pid}.json`);
  const before = new AdminSessions({ file: sessionFile });
  const cookie = before.create().cookie.split(';')[0];
  const asRequest = c => ({ headers: { cookie: c } });
  const after = new AdminSessions({ file: sessionFile });
  assert.ok(after.get(asRequest(cookie)), 'Session lost on restart');
  assert.ok(!fs.readFileSync(sessionFile, 'utf8').includes(cookie.split('=')[1]), 'The session cookie must not be saved as is');
  after.destroy(asRequest(cookie));
  assert.strictEqual(new AdminSessions({ file: sessionFile }).get(asRequest(cookie)), null, 'Signing out must also end the saved session');
  fs.rmSync(sessionFile, { force: true });
  console.log('✓ Test 9c Passed: Panel sign-ins survive a restart; signing out ends them');

  // 10. Sign out, wrong/right password, lockout, the old token alone, and the 3-hour limit
  await post('/api/admin/logout', {});
  const info = () => httpRequest({ host: 'localhost', port: 8098, path: '/api/admin/info', method: 'GET' });
  assert.strictEqual((await info()).statusCode, 401, 'Signed-out session must be rejected');
  sessionCookie = null;
  assert.strictEqual((await httpRequest({
    host: 'localhost', port: 8098, path: `/api/admin/info?token=${encodeURIComponent(adminToken)}`, method: 'GET'
  })).statusCode, 401, 'The panel link token alone must no longer grant access');

  assert.strictEqual((await post('/api/admin/login', { password: 'wrong password' })).statusCode, 401, 'Wrong password accepted');
  const loginRes = await post('/api/admin/login', { password: 'correct horse' });
  assert.strictEqual(loginRes.statusCode, 200, 'Correct password rejected');
  sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
  assert.strictEqual((await info()).statusCode, 200, 'Signed-in session rejected');

  // The server-side 3-hour limit applies even while the browser keeps the cookie
  for (const session of adminSessions.sessions.values()) session.expiresAt = Date.now() - 1;
  assert.strictEqual((await info()).statusCode, 401, 'Expired session must be rejected');

  // An idle session (no open panel for 15 minutes, e.g. a restored browser session) ends too
  const relogin = await post('/api/admin/login', { password: 'correct horse' });
  sessionCookie = relogin.headers['set-cookie'][0].split(';')[0];
  for (const session of adminSessions.sessions.values()) session.lastSeen = Date.now() - 16 * 60 * 1000;
  assert.strictEqual((await info()).statusCode, 401, 'Idle session must be rejected');
  sessionCookie = null;

  // Parallel guesses cannot dodge the lockout: only one check per client runs at a time
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/api/admin/login', { password: 'burst' + i })));
  assert.ok(burst.filter(r => r.statusCode === 401).length <= 1, 'Parallel guesses must be throttled');
  for (let i = 0; i < 5; i++) await post('/api/admin/login', { password: 'guess' + i });
  assert.strictEqual((await post('/api/admin/login', { password: 'correct horse' })).statusCode, 429, 'Repeated wrong passwords must lock out');
  console.log('✓ Test 10 Passed: Logout, password check, 3-hour expiry and brute-force lockout');

  // 11. CSRF: plain HTML form posts and other origins are refused even with a valid session
  adminSessions.failures.clear();
  sessionCookie = adminSessions.create().cookie.split(';')[0];
  const formPost = await httpRequest({
    host: 'localhost', port: 8098, path: '/api/admin/permissions', method: 'POST', headers: { 'Content-Type': 'text/plain' }
  }, '{"x":"="}');
  assert.strictEqual(formPost.statusCode, 403, 'text/plain POST must be refused');
  const foreign = await httpRequest({
    host: 'localhost', port: 8098, path: '/api/admin/permissions', method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:9999' }
  }, {});
  assert.strictEqual(foreign.statusCode, 403, 'Cross-origin POST must be refused');
  assert.ok(!('access-control-allow-origin' in foreign.headers), 'Admin API must not allow cross-origin reads');
  assert.strictEqual((await post('/api/admin/permissions', { userId: 'nobody', permissions: {} })).statusCode, 404, 'Same-origin JSON POST must reach the API');
  console.log('✓ Test 11 Passed: Cross-site requests to the admin API are refused');

  // 12. reset-password from another process applies at once, while the server keeps running
  new AuthService().clearAdminPassword();
  assert.strictEqual((await info()).statusCode, 401, 'Existing sessions must end after a reset');
  const afterReset = (await getSession()).json;
  assert.ok(!afterReset.passwordSet && authService.setupToken, 'Reset must reopen first-time setup with a new link');
  assert.strictEqual((await post('/api/admin/setup', { setupToken: authService.setupToken, password: 'new password', confirm: 'new password' })).statusCode, 200,
    'A new password must be settable after a reset');
  roomManager.kickParticipant('nobody'); // server still serving requests
  assert.strictEqual((await httpRequest({ host: 'localhost', port: 8098, path: '/api/health', method: 'GET' })).statusCode, 200);
  console.log('✓ Test 12 Passed: Password reset applies immediately without restarting the server');

  ws.close();
  server.close();

  console.log('\n=============================================');
  console.log(' ALL SECTION 3 ADMIN PANEL TESTS PASSED!     ');
  console.log('=============================================\n');
  process.exit(0);
}

runAdminPanelTests().catch(err => {
  console.error('Section 3 test error:', err);
  process.exit(1);
});
