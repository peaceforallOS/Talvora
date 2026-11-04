/**
 * Chat history: saved across restarts, private messages stay private, the admin can clear it
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const { MessageType } = require('../../shared/protocol');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videocall-chat-test-'));
process.env.PORT = '8099';
process.env.VIDEOCALL_CONFIG = path.join(tempDir, 'config.json');
process.env.TURN_PORT = '0';
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { server, authService } = require('../src/index');
const ChatHistory = require('../src/chatHistory');

const BASE_URL = 'http://localhost:8099';
const HISTORY_FILE = path.join(tempDir, 'chat-history.jsonl');
const wait = ms => new Promise(r => setTimeout(r, ms));

// Joins the room and collects everything the server sends
async function join(username, token) {
  const ws = new WebSocket('ws://localhost:8099');
  const inbox = [];
  ws.on('message', raw => inbox.push(JSON.parse(raw)));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: MessageType.AUTH, username, token }));
  await wait(200);
  const user = inbox.find(m => m.type === MessageType.AUTH_SUCCESS)?.user;
  assert.ok(user, `${username} could not join`);
  return { ws, inbox, user, history: () => inbox.find(m => m.type === MessageType.CHAT_HISTORY)?.messages.map(m => m.text) };
}

function panelPost(apiPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function run() {
  console.log('--- Starting Chat History Tests ---');

  // 1. Who sees what, including after everyone has left and joined again
  const token = name => new URL(authService.generateInviteLink({ baseUrl: BASE_URL, targetUsername: name }).joinLink).searchParams.get('token');
  const adminToken = authService.getAdminToken();
  const admin = await join('Admin', adminToken);
  const ali = await join('Ali', token('Ali'));
  const sara = await join('Sara', token('Sara'));
  assert.deepStrictEqual(admin.history(), [], 'A new server has no history');

  ali.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'public', recipients: [], text: 'hello all' }));
  ali.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'direct', recipients: [sara.user.id], text: 'secret for Sara' }));
  admin.ws.send(JSON.stringify({ type: MessageType.CHAT_SEND, mode: 'direct', recipients: [ali.user.id], text: 'secret for Ali' }));
  await wait(200);

  for (const c of [admin, ali, sara]) c.ws.close();
  await wait(200);
  const admin2 = await join('Admin', adminToken);
  const ali2 = await join('ali', token('Ali')); // names are matched without regard to case
  const sara2 = await join('Sara', token('Sara'));
  assert.deepStrictEqual(admin2.history(), ['hello all', 'secret for Ali'], 'Admin sees the public message and their own direct one');
  assert.deepStrictEqual(ali2.history(), ['hello all', 'secret for Sara', 'secret for Ali'], 'Ali sees everything Ali sent or received');
  assert.deepStrictEqual(sara2.history(), ['hello all', 'secret for Sara'], "Sara does not see someone else's direct message");
  console.log('✓ Test 1 Passed: History comes back on joining, direct messages only for their two people');

  // 2. A restart: the same file read by a new server
  const restarted = new ChatHistory({ file: HISTORY_FILE });
  assert.strictEqual(restarted.count, 3, 'Saved messages must survive a restart');
  assert.deepStrictEqual(restarted.visibleTo('Sara').map(m => m.text), ['hello all', 'secret for Sara']);
  console.log('✓ Test 2 Passed: A restarted server still has the messages');

  // 3. Only a signed-in admin can clear it, and it goes for everyone at once
  const refused = await panelPost('/api/admin/chat/clear', {});
  assert.strictEqual(refused.statusCode, 401, 'Clearing needs the management panel login');
  assert.ok(fs.existsSync(HISTORY_FILE), 'Refused request must not clear anything');

  const setup = await panelPost('/api/admin/setup', { setupToken: authService.setupToken, password: 'correct horse', confirm: 'correct horse' });
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  const cleared = await panelPost('/api/admin/chat/clear', {}, cookie);
  assert.strictEqual(cleared.statusCode, 200, 'Admin could not clear the history');
  await wait(200);
  assert.ok(sara2.inbox.some(m => m.type === MessageType.CHAT_CLEARED), 'People in the room must be told');
  assert.ok(!fs.existsSync(HISTORY_FILE), 'The saved messages must really be deleted');
  sara2.ws.close();
  await wait(200);
  assert.deepStrictEqual((await join('Sara', token('Sara'))).history(), [], 'Nothing comes back after clearing');
  console.log('✓ Test 3 Passed: The admin clears the history for everyone, and it stays gone');

  // 4. Damage and size: a line cut short is skipped, the oldest messages go first
  const file = path.join(tempDir, 'unit.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ mode: 'public', text: 'kept' })}\n{"mode":"pub`);
  assert.deepStrictEqual(new ChatHistory({ file }).messages.map(m => m.text), ['kept'], 'A damaged line must not lose the rest');

  fs.rmSync(file);
  const small = new ChatHistory({ file, maxMessages: 3 });
  for (let i = 1; i <= 505; i++) small.add({ mode: 'public', text: String(i) });
  assert.strictEqual(small.count, 3);
  assert.deepStrictEqual(small.visibleTo('x').map(m => m.text), ['503', '504', '505']);
  assert.deepStrictEqual(new ChatHistory({ file, maxMessages: 3 }).messages.map(m => m.text), ['503', '504', '505'], 'The newest must also be on disk');
  console.log('✓ Test 4 Passed: Damaged lines are skipped and the size stays bounded');

  server.close();
  console.log('\n=============================================');
  console.log(' ALL CHAT HISTORY TESTS PASSED!');
  console.log('=============================================\n');
  process.exit(0);
}

run().catch(err => {
  console.error('Chat history test failure:', err);
  process.exit(1);
});
