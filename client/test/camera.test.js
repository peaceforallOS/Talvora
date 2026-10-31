/**
 * Camera Tests — the camera opens only while it is on: joining opens just the microphone, turning
 * the camera off releases it, and every connection keeps one video slot that the camera and screen
 * sharing reuse (only the first video needs a negotiation).
 */

const assert = require('assert');

console.log('--- Starting Camera Tests ---');

// Minimal browser stand-ins: tracks, streams, devices and peer connections that record what happens
class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
  getSettings() { return { deviceId: this.label }; }
}
global.MediaStream = class {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter(x => x !== t); }
};
const opened = [];
// Node has its own read-only navigator: replace it for the media engine
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    getUserMedia: async constraints => {
      const tracks = [];
      if (constraints.audio) tracks.push(new FakeTrack('audio', 'mic'));
      if (constraints.video) tracks.push(new FakeTrack('video', `camera-${opened.length + 1}`));
      opened.push(...tracks);
      return new MediaStream(tracks);
    },
    getDisplayMedia: async () => new MediaStream([new FakeTrack('video', 'screen')])
  }
} });
global.window = {}; // no AudioContext: the microphone is used without noise suppression
class FakeSender {
  constructor(track) { this.track = track; }
  async replaceTrack(track) { this.track = track; }
}
global.RTCPeerConnection = class {
  constructor() { this.senders = []; this.addTrackCalls = 0; this.signalingState = 'stable'; }
  addTrack(track) { this.addTrackCalls++; const s = new FakeSender(track); this.senders.push(s); return s; }
  getSenders() { return [...this.senders]; }
  close() { this.signalingState = 'closed'; }
};

const MediaEngine = require('../src/mediaEngine');

(async () => {
  const engine = new MediaEngine();

  // 1. Joining opens only the microphone
  const stream = await engine.initLocalMedia({ audio: true });
  assert.strictEqual(stream.getVideoTracks().length, 0, 'The camera must not open when joining');
  assert.ok(!opened.some(t => t.kind === 'video'), 'No camera may be opened when joining');
  assert.strictEqual(engine.cameraOn, false);
  const peer = engine.createPeerConnection('peer-1', true);
  assert.strictEqual(peer.addTrackCalls, 1, 'Only the microphone is sent before the camera is on');
  console.log('✓ Test 1 Passed: Joining opens the microphone only');

  // 2. Camera on: one video slot is added (one negotiation)
  const cam1 = await engine.startCamera();
  assert.ok(cam1 && cam1.kind === 'video' && engine.cameraOn);
  assert.strictEqual(peer.addTrackCalls, 2, 'The first camera adds one video sender');
  const slot = peer.getSenders()[1];
  assert.strictEqual(slot.track, cam1);
  assert.strictEqual(await engine.startCamera(), cam1, 'Turning on twice keeps the same camera');
  console.log('✓ Test 2 Passed: Turning the camera on adds one video slot');

  // 3. Camera off releases the device; the slot stays, sending nothing
  engine.stopCamera();
  assert.ok(cam1.stopped, 'The camera must be released when turned off');
  assert.strictEqual(engine.cameraOn, false);
  assert.strictEqual(slot.track, null, 'Peers stop receiving video');
  console.log('✓ Test 3 Passed: Turning the camera off releases it');

  // 4. On again: a new capture reuses the slot (no new sender, no renegotiation)
  const cam2 = await engine.startCamera();
  assert.notStrictEqual(cam2, cam1);
  assert.strictEqual(peer.addTrackCalls, 2, 'The video slot must be reused');
  assert.strictEqual(slot.track, cam2);
  console.log('✓ Test 4 Passed: Turning the camera on again reuses the video slot');

  // 5. Screen sharing with the camera off uses the same slot; stopping goes back to nothing
  engine.stopCamera();
  const screen = await engine.startScreenShare();
  assert.strictEqual(slot.track, screen.getVideoTracks()[0], 'The screen is sent in the video slot');
  const cam3 = await engine.startCamera();
  assert.strictEqual(slot.track, screen.getVideoTracks()[0], 'Peers keep seeing the screen when the camera turns on');
  engine.stopScreenShare();
  assert.strictEqual(slot.track, cam3, 'After sharing, peers see the camera again');
  engine.stopCamera();
  await engine.startScreenShare();
  engine.stopScreenShare();
  assert.strictEqual(slot.track, null, 'After sharing with the camera off, peers see nothing');
  assert.strictEqual(peer.addTrackCalls, 2, 'Screen sharing must not add senders');
  console.log('✓ Test 5 Passed: Screen sharing shares the video slot with the camera');

  // 6. Someone joining while the camera is on gets it at once; the camera choice is kept while off
  await engine.startCamera();
  const late = engine.createPeerConnection('peer-2', false);
  assert.strictEqual(late.addTrackCalls, 2, 'A new peer gets the microphone and the camera');
  engine.stopCamera();
  assert.strictEqual(await engine.switchCamera('front-camera'), null, 'Choosing a camera while off must not open it');
  assert.strictEqual(engine.cameraOn, false);
  assert.strictEqual(engine.preferredDevices.videoinput, 'front-camera');
  console.log('✓ Test 6 Passed: New peers and camera choice handled');

  engine.destroy();
  console.log('\n========================================');
  console.log(' ALL CAMERA TESTS PASSED!               ');
  console.log('========================================');
})().catch(err => {
  console.error('Camera test failure:', err);
  process.exit(1);
});
