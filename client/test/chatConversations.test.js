/**
 * Chat conversations: Everyone shows only public messages, Direct one conversation per person with
 * that person's own unread count, and everything stays right after leaving and joining again.
 */

const assert = require('assert');

console.log('--- Starting Chat Conversation Tests ---');

// The few parts of a page the chat touches
class FakeElement {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this.hiddenClass = false;
    this.listeners = {};
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 100;
    const element = this;
    this.classList = {
      add: name => { if (name === 'hidden') element.hiddenClass = true; },
      remove: name => { if (name === 'hidden') element.hiddenClass = false; },
      toggle: (name, on) => { if (name === 'hidden') element.hiddenClass = on; }
    };
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  appendChild(child) { if (child.isFragment) this.children.push(...child.children); else this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(fragment) { this.children = fragment ? [...fragment.children] : []; }
  focus() {}
  querySelector() { return new FakeElement(); }
  setAttribute() {}
  set innerHTML(html) { this.html = html; this.children = []; }
  get innerHTML() { return this.html || ''; }
}
global.document = {
  createElement: () => new FakeElement(),
  createDocumentFragment: () => Object.assign(new FakeElement(), { isFragment: true }),
  addEventListener: () => {},
  body: new FakeElement()
};
global.window = { addEventListener: () => {} };
const store = new Map();
global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };

const ChatController = require('../src/chat');

function chatFor(username) {
  const sent = [];
  const el = {
    container: new FakeElement(), input: new FakeElement(), form: new FakeElement(), modeSelect: new FakeElement(),
    recipientsBox: new FakeElement(), recipientsList: new FakeElement(), unreadBadge: new FakeElement(),
    revokedBanner: new FakeElement(), publicBadge: new FakeElement(), directBadge: new FakeElement()
  };
  const notices = [];
  const chat = new ChatController({
    core: { ws: { url: 'wss://server' }, sendChatMessage: m => sent.push(m) },
    onNotice: m => notices.push(m),
    ...el
  });
  chat.username = username;
  const mode = m => { el.modeSelect.value = m; el.modeSelect.listeners.change(); };
  // The messages on screen; each row keeps its message
  const shown = () => chat.messages.filter(m => chat.belongsToView(m)).map(m => m.text);
  const rows = () => el.container.children.length;
  return { chat, el, sent, notices, mode, shown, rows };
}
let time = 1000;
const pub = (from, text) => ({ senderUsername: from, mode: 'public', recipients: [], recipientUsernames: [], text, timestamp: ++time });
const dm = (from, to, text) => ({ senderUsername: from, mode: 'direct', recipients: ['id-of-' + to], recipientUsernames: [to], text, timestamp: ++time });
const people = [{ id: 'me', username: 'Me' }, { id: 'a1', username: 'Ali' }, { id: 'b1', username: 'Asghar' }];

// 1. Who a direct message is with
assert.strictEqual(ChatController.peerOf(dm('Ali', 'Me', 'x'), 'Me'), 'Ali', 'Received: the sender');
assert.strictEqual(ChatController.peerOf(dm('Me', 'Ali', 'x'), 'me'), 'Ali', 'Sent: the recipient, whatever the case of the name');
assert.strictEqual(ChatController.peerOf(pub('Ali', 'x'), 'Me'), null, 'Public: nobody in particular');
assert.strictEqual(ChatController.peerOf({ senderUsername: 'Me', mode: 'direct', recipients: ['a1'] }, 'Me', people), 'Ali', 'Older server: found through the person in the room');
console.log('✓ Test 1 Passed: Direct messages belong to a person');

// 2. The two sections are separate; each person is their own conversation
let t = chatFor('Me');
t.chat.updateParticipants(people, 'me');
t.chat.receiveMessage(pub('Ali', 'hello room'), 'Me');
t.chat.receiveMessage(dm('Me', 'Ali', 'private to Ali'), 'Me');
t.chat.receiveMessage(dm('Asghar', 'Me', 'private from Asghar'), 'Me');
assert.deepStrictEqual(t.shown(), ['hello room'], 'Everyone never shows direct messages');
assert.strictEqual(t.rows(), 1, 'On screen too');
t.mode('direct');
assert.deepStrictEqual(t.shown(), [], 'Direct with nobody chosen shows nothing');
assert.strictEqual(t.rows(), 0);
assert.ok(t.el.container.dataset.empty.includes('Choose someone'));
t.chat.selectPeer('Ali');
assert.deepStrictEqual(t.shown(), ['private to Ali'], 'Only the conversation with Ali');
assert.strictEqual(t.rows(), 1);
t.chat.selectPeer('Asghar');
assert.deepStrictEqual(t.shown(), ['private from Asghar'], 'Only the conversation with Asghar');
t.mode('public');
assert.deepStrictEqual(t.shown(), ['hello room'], 'Back to Everyone');
t.mode('direct');
assert.deepStrictEqual(t.shown(), ['private from Asghar'], 'And back to the same conversation');
console.log('✓ Test 2 Passed: Everyone and each direct conversation are separate');

// 3. Sending goes to the person whose conversation is open
t.el.input.value = 'hi';
t.chat.sendMessage();
assert.deepStrictEqual(t.sent[0], { mode: 'direct', recipients: ['b1'], text: 'hi' });
t.chat.selectPeer('Ali');
t.chat.updateParticipants([people[0], { id: 'a2', username: 'Ali' }], 'me'); // Ali joined again: a new id
t.el.input.value = 'again';
t.chat.sendMessage();
assert.deepStrictEqual(t.sent[1].recipients, ['a2'], 'To Ali under the id of this session');
t.chat.updateParticipants([people[0]], 'me'); // Ali left
t.el.input.value = 'not delivered';
t.chat.sendMessage();
assert.strictEqual(t.sent.length, 2, 'Someone not in the room cannot be sent to');
assert.strictEqual(t.el.input.value, 'not delivered', 'What was typed is kept');
assert.ok(t.notices[0].includes('Ali is not in the room'));
assert.deepStrictEqual(t.shown(), ['private to Ali'], 'But the conversation can still be read');
console.log('✓ Test 3 Passed: Messages go to the open conversation, and past ones stay readable');

// 4. Unread counts
t = chatFor('Me');
t.chat.updateParticipants(people, 'me');
t.chat.receiveMessage(dm('Ali', 'Me', 'one'), 'Me');
t.chat.receiveMessage(dm('Ali', 'Me', 'two'), 'Me');
t.chat.receiveMessage(dm('Asghar', 'Me', 'three'), 'Me');
assert.strictEqual(t.chat.directUnread.get('ali'), 2, 'Counted per person');
assert.strictEqual(t.chat.directUnread.get('asghar'), 1);
assert.strictEqual(t.el.directBadge.textContent, '3', 'The Direct button shows them all');
assert.strictEqual(t.el.directBadge.hiddenClass, false);
assert.strictEqual(t.chat.publicUnread, 0);
t.mode('direct');
t.chat.selectPeer('Ali');
assert.ok(!t.chat.directUnread.has('ali'), 'Opening a conversation reads it');
assert.strictEqual(t.chat.directUnread.get('asghar'), 1, 'Not the others');
assert.strictEqual(t.el.directBadge.textContent, '1');
t.chat.receiveMessage(dm('Ali', 'Me', 'four'), 'Me');
assert.ok(!t.chat.directUnread.has('ali'), 'A message in the open conversation is read at once');
t.chat.receiveMessage(pub('Ali', 'to everyone'), 'Me');
assert.strictEqual(t.chat.publicUnread, 1, 'Public messages count on the Everyone button while in Direct');
assert.strictEqual(t.el.publicBadge.hiddenClass, false);
t.chat.isPanelOpen = false;
t.chat.receiveMessage(dm('Ali', 'Me', 'five'), 'Me');
assert.strictEqual(t.chat.directUnread.get('ali'), 1, 'Not read while the chat is closed');
assert.strictEqual(t.el.unreadBadge.hiddenClass, false, 'The Chat tab shows it');
t.chat.markRead();
assert.strictEqual(t.chat.directUnread.get('ali'), 1, 'Still not read while closed');
t.chat.isPanelOpen = true;
t.chat.isChatTabActive = false;
t.chat.receiveMessage(dm('Ali', 'Me', 'six'), 'Me');
assert.strictEqual(t.chat.directUnread.get('ali'), 2, 'Nor while the People tab is showing');
t.chat.isChatTabActive = true;
t.chat.markRead();
assert.ok(!t.chat.directUnread.has('ali'), 'Coming back reads it');
t.chat.receiveMessage(dm('Me', 'Asghar', 'mine'), 'Me');
assert.strictEqual(t.chat.directUnread.get('asghar'), 1, 'One\'s own messages are never unread');
console.log('✓ Test 4 Passed: Unread counts per person, in each section');

// 5. Leaving and joining again: what was read stays read, what was not stays unread
const history = t.chat.messages.slice();
t.chat.reset();
assert.strictEqual(t.chat.selectedPeer, null);
t.chat.updateParticipants(people, 'me');
t.chat.loadHistory(history, 'Me');
assert.ok(!t.chat.directUnread.has('ali'), 'Read before leaving: still read');
assert.strictEqual(t.chat.directUnread.get('asghar'), 1, 'Unread before leaving: still unread');
assert.strictEqual(t.chat.publicUnread, 0, 'Old public messages are not counted');
assert.deepStrictEqual([...t.chat.directNames.keys()].sort(), ['ali', 'asghar']);
const other = chatFor('Asghar');
assert.deepStrictEqual(other.chat.loadLastRead(), {}, 'Kept per person: someone else on this computer starts fresh');
console.log('✓ Test 5 Passed: Unread counts survive leaving and joining again');

// 6. Someone with history who is not in the room is still listed
t = chatFor('Me');
t.mode('direct');
t.chat.updateParticipants(people.slice(0, 1), 'me');
t.chat.loadHistory([dm('Ali', 'Me', 'old')], 'Me');
assert.strictEqual(t.el.recipientsList.children.length, 1, 'Listed though not in the room');
assert.ok(t.el.recipientsList.children[0].className.includes('away'));
t.chat.selectPeer('Ali');
assert.ok(t.el.input.placeholder.includes('not in the room'));
assert.deepStrictEqual(t.shown(), ['old']);
console.log('✓ Test 6 Passed: Past conversations stay listed');

// 7. The admin clears the history
t.chat.receiveMessage(dm('Ali', 'Me', 'new'), 'Me');
t.chat.clearMessages();
assert.deepStrictEqual(t.chat.messages, []);
assert.strictEqual(t.chat.directNames.size, 0);
assert.strictEqual(t.el.directBadge.hiddenClass, true);
assert.strictEqual(t.rows(), 0);
console.log('✓ Test 7 Passed: Clearing the history clears the conversations and counts');

// 8. Each message's direction comes from its first word (Persian: right to left), typing and sent alike
const row = t.chat.createMessageRow(pub('Ali', 'سلام hello'), 'Me');
assert.ok(row.children[0].innerHTML.includes('class="bubble-text" dir="auto"'), 'A sent message finds its own direction');
const page = require('fs').readFileSync(require('path').join(__dirname, '../src/index.html'), 'utf8');
assert.ok(/id="chat-input"[^>]*dir="auto"/.test(page), 'The typing box too');
console.log('✓ Test 8 Passed: Messages and the typing box take their direction from the first word');

console.log('\n========================================');
console.log(' ALL CHAT CONVERSATION TESTS PASSED!    ');
console.log('========================================');
