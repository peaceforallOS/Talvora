/**
 * Plugging a microphone in or out during a call: the call moves to the new device, goes back when it is
 * unplugged, keeps mute as it was, and the other people keep receiving audio without a new negotiation.
 */

const assert = require('assert');

console.log('--- Starting Microphone Switching Tests ---');

class FakeTrack {
  constructor(deviceId, label) {
    this.kind = 'audio';
    this.deviceId = deviceId;
    this.label = label;
    this.enabled = true;
    this.readyState = 'live';
    this.onended = null;
  }
  stop() { this.readyState = 'ended'; }
  getSettings() { return { deviceId: this.deviceId }; }
  // What the browser does when the device goes away (not when the app stops the track)
  lose() { this.readyState = 'ended'; if (this.onended) this.onended(); }
}
global.MediaStream = class {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter(x => x !== t); }
};

const LAPTOP = { deviceId: 'laptop', kind: 'audioinput', label: 'Laptop Microphone' };
const HEADSET = { deviceId: 'headset', kind: 'audioinput', label: 'USB Headset' };
const USB_MIC = { deviceId: 'usbmic', kind: 'audioinput', label: 'USB Microphone' };
const ALIASES = [
  { deviceId: 'default', kind: 'audioinput', label: 'Default - Laptop Microphone' },
  { deviceId: 'communications', kind: 'audioinput', label: 'Communications - Laptop Microphone' }
];
const SPEAKER = { deviceId: 'speaker', kind: 'audiooutput', label: 'Speakers' };

let connected = [LAPTOP];
let failing = new Set();
const listeners = new Set();
const opened = [];
function plug(...devices) { connected = devices; listeners.forEach(fn => fn()); }

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    enumerateDevices: async () => [...ALIASES, ...connected, SPEAKER],
    getUserMedia: async constraints => {
      const asked = constraints.audio.deviceId?.exact;
      if (asked && !connected.some(d => d.deviceId === asked)) throw new Error('OverconstrainedError');
      if (asked && failing.has(asked)) throw new Error('NotReadableError');
      if (!asked && connected.length === 0) throw new Error('NotFoundError');
      const ideal = constraints.audio.deviceId?.ideal;
      const chosen = asked || (connected.some(d => d.deviceId === ideal) ? ideal : null);
      const device = connected.find(d => d.deviceId === chosen) || connected[0];
      const track = new FakeTrack(chosen || 'default', device.label);
      opened.push(chosen || 'default');
      return new MediaStream([track]);
    }
  }
} });
global.window = {}; // no AudioContext: the track itself is sent, so replaceTrack can be checked
global.RTCPeerConnection = class {
  constructor() { this.senders = []; this.addTrackCalls = 0; this.signalingState = 'stable'; }
  addTrack(track) { this.addTrackCalls++; const s = { track, replaceTrack: async t => { s.track = t; }, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }; this.senders.push(s); return s; }
  getSenders() { return [...this.senders]; }
  close() { this.signalingState = 'closed'; }
};

const MediaEngine = require('../src/mediaEngine');
const settle = () => new Promise(resolve => setTimeout(resolve, 760)); // past the wait for events to settle

async function call(options = {}) {
  const notices = [];
  const engine = new MediaEngine({ onMicrophoneChanged: label => notices.push(label) });
  if (options.preferred) engine.setPreferredDevices({ audioinput: options.preferred });
  await engine.initLocalMedia({ audio: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  const peer = engine.createPeerConnection('peer-1', true);
  return { engine, peer, notices, mic: () => engine.localStream.getAudioTracks()[0], sent: () => peer.senders[0].track };
}

(async () => {
  // 1. Plug in, unplug: laptop -> headset -> laptop
  connected = [LAPTOP];
  let c = await call({ preferred: 'laptop' });
  assert.strictEqual(c.mic().deviceId, 'laptop');
  const addTracks = c.peer.addTrackCalls;
  plug(LAPTOP, HEADSET);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'headset', 'Plugging a headset in moves the call to it');
  assert.strictEqual(c.sent(), c.mic(), 'The other people receive the new microphone');
  assert.strictEqual(c.peer.addTrackCalls, addTracks, 'Without a new negotiation');
  assert.deepStrictEqual(c.notices, ['USB Headset'], 'The person is told');
  assert.strictEqual(c.engine.currentDevices().audioinput, 'headset', 'The settings show it');
  const headsetTrack = c.mic();
  plug(LAPTOP);
  headsetTrack.lose();
  await settle();
  assert.strictEqual(c.mic().deviceId, 'laptop', 'Unplugging it goes back to the laptop');
  assert.strictEqual(c.sent(), c.mic());
  assert.deepStrictEqual(c.notices, ['USB Headset', 'Laptop Microphone']);
  c.engine.destroy();
  console.log('✓ Test 1 Passed: The call follows a headset plugged in and out');

  // 2. Starting on the system's default; several events for one change switch once
  connected = [LAPTOP];
  opened.length = 0;
  c = await call();
  assert.strictEqual(c.mic().deviceId, 'default');
  plug(LAPTOP, HEADSET);
  listeners.forEach(fn => fn());
  listeners.forEach(fn => fn());
  await settle();
  assert.strictEqual(c.mic().deviceId, 'headset');
  assert.deepStrictEqual(opened, ['default', 'headset'], 'One change, however many events, opens the device once');
  plug(LAPTOP);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'default', 'Back to the system\'s default');
  c.engine.destroy();
  console.log('✓ Test 2 Passed: Works from the default microphone, opening each device once');

  // 3. Mute stays as it was
  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  c.engine.setAudioEnabled(false);
  plug(LAPTOP, HEADSET);
  await settle();
  assert.strictEqual(c.mic().enabled, false, 'Muted stays muted on the new device');
  c.engine.setAudioEnabled(true);
  plug(LAPTOP);
  await settle();
  assert.strictEqual(c.mic().enabled, true, 'Unmuted stays unmuted');
  c.engine.destroy();
  console.log('✓ Test 3 Passed: Mute is kept across a switch');

  // 4. Nothing to do: other devices changing, or a microphone not in use being unplugged
  connected = [LAPTOP, USB_MIC];
  c = await call({ preferred: 'laptop' });
  const before = c.mic();
  plug(LAPTOP, USB_MIC); // e.g. a speaker or camera came or went
  await settle();
  assert.strictEqual(c.mic(), before, 'A change that is not a microphone leaves the call alone');
  plug(LAPTOP);
  await settle();
  assert.strictEqual(c.mic(), before, 'Unplugging a microphone not in use leaves the call alone');
  assert.deepStrictEqual(c.notices, []);
  c.engine.destroy();
  console.log('✓ Test 4 Passed: Unrelated changes leave the call alone');

  // 5. Going back through several devices
  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  plug(LAPTOP, HEADSET);
  await settle();
  plug(LAPTOP, HEADSET, USB_MIC);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'usbmic');
  plug(LAPTOP, HEADSET);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'headset', 'The one used before it');
  plug(LAPTOP);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'laptop', 'And the one before that');
  c.engine.destroy();
  console.log('✓ Test 5 Passed: Unplugging goes back through what was in use');

  // 6. The only microphone unplugged, then one plugged in; a new device that will not open
  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  const only = c.mic();
  plug();
  only.lose();
  await settle();
  assert.deepStrictEqual(c.notices, [null], 'Told when no microphone is left');
  plug(HEADSET);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'headset', 'The next one plugged in is picked up');
  assert.strictEqual(c.sent(), c.mic());
  c.engine.destroy();

  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  failing = new Set(['headset']);
  plug(LAPTOP, HEADSET);
  await settle();
  assert.strictEqual(c.mic().readyState, 'live', 'A device that will not open still leaves a working microphone');
  assert.strictEqual(c.mic().deviceId, 'laptop', 'The one already in use');
  failing = new Set();
  c.engine.destroy();
  console.log('✓ Test 6 Passed: No microphone left, and a device that will not open');

  // 7. The track ending with no change in the list (the driver reset): reopened
  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  c.mic().lose();
  await settle();
  assert.strictEqual(c.mic().deviceId, 'laptop');
  assert.strictEqual(c.mic().readyState, 'live', 'Reopened');
  c.engine.destroy();
  console.log('✓ Test 7 Passed: A microphone that stops on its own is reopened');

  // 7b. A device appearing with no event at all (Linux: Bluetooth, sound-system devices)
  connected = [LAPTOP];
  c = await call({ preferred: 'laptop' });
  connected = [LAPTOP, HEADSET]; // no devicechange
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.strictEqual(c.mic().deviceId, 'headset', 'Found by looking at the list regularly');
  c.engine.destroy();
  console.log('✓ Test 7b Passed: A device that sends no event is still found');

  // 8. Chosen by hand; leaving the call stops watching
  connected = [LAPTOP, HEADSET];
  c = await call({ preferred: 'laptop' });
  await c.engine.switchMicrophone('headset');
  assert.strictEqual(c.mic().deviceId, 'headset');
  assert.deepStrictEqual(c.notices, [], 'A choice made by hand needs no announcement');
  plug(LAPTOP);
  await settle();
  assert.strictEqual(c.mic().deviceId, 'default', 'Unplugged: the system\'s default');
  await c.engine.switchMicrophone('default');
  assert.strictEqual(c.engine.currentDevices().audioinput, 'default');
  c.engine.destroy();
  assert.strictEqual(listeners.size, 0, 'Leaving the call stops watching');
  opened.length = 0;
  plug(LAPTOP, HEADSET);
  await settle();
  assert.deepStrictEqual(opened, [], 'And opens nothing afterwards');
  console.log('✓ Test 8 Passed: Choices by hand are respected, and leaving stops the watching');

  console.log('\n========================================');
  console.log(' ALL MICROPHONE SWITCHING TESTS PASSED! ');
  console.log('========================================');
  process.exit(0);
})().catch(err => {
  console.error('Microphone switching test failure:', err);
  process.exit(1);
});
