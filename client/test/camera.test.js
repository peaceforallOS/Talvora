/**
 * Camera Tests — the camera opens only while it is on: joining opens just the microphone (nothing
 * at all without voice permission; it opens later, muted), turning
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
let lastConstraints = null;
// Node has its own read-only navigator: replace it for the media engine
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    getUserMedia: async constraints => {
      lastConstraints = constraints;
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
  constructor(track) { this.track = track; this.encoding = {}; }
  async replaceTrack(track) { this.track = track; }
  getParameters() { return { encodings: [{ ...this.encoding }] }; }
  async setParameters(p) { this.encoding = { ...p.encodings[0] }; }
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

  // 7. Joining without voice permission opens nothing; the microphone opens later, still muted
  const quiet = new MediaEngine();
  const before = opened.length;
  await quiet.initLocalMedia({ audio: false });
  assert.strictEqual(opened.length, before, 'Nothing may be opened without voice permission');
  const quietPeer = quiet.createPeerConnection('peer-3', true);
  assert.strictEqual(quietPeer.addTrackCalls, 0, 'Nothing is sent without voice or camera');
  assert.strictEqual(await quiet.switchMicrophone('desk-mic'), null, 'Choosing a microphone before it may be used must not open it');
  assert.strictEqual(opened.length, before);
  const [micA, micB] = await Promise.all([quiet.startMicrophone(), quiet.startMicrophone()]);
  assert.ok(micA && micA === micB, 'Opening the microphone twice at once opens it once');
  assert.strictEqual(opened.length, before + 1);
  assert.deepStrictEqual(lastConstraints.audio.deviceId, { ideal: 'desk-mic' }, 'The chosen microphone is used');
  assert.strictEqual(micA.enabled, false, 'The microphone starts muted');
  assert.strictEqual(quietPeer.addTrackCalls, 1, 'The microphone is added to the call');
  assert.strictEqual(quietPeer.getSenders()[0].track, micA);
  assert.strictEqual(quiet.setAudioEnabled(true), true, 'Unmuting works');
  quiet.destroy();
  assert.ok(micA.stopped, 'Leaving releases the microphone');
  console.log('✓ Test 7 Passed: Without voice permission the microphone opens only when allowed and unmuted');

  // 8. Shared sound: our encoder gets stereo at a music bitrate on the shared-sound m-line; the voice stays mono
  const sdp = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1', ''
  ].join('\r\n');
  const tuned = MediaEngine.tuneRemoteSdp(sdp, '2');
  const fmtps = tuned.match(/a=fmtp:111 [^\r\n]*/g);
  assert.strictEqual(fmtps[0], 'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0', 'The voice stays mono at its own bitrate');
  assert.ok(/maxaveragebitrate=128000/.test(fmtps[1]) && /usedtx=0/.test(fmtps[1]) && !/usedtx=1/.test(fmtps[1]) && /stereo=1/.test(fmtps[1]) && /sprop-stereo=1/.test(fmtps[1]), 'Shared sound not tuned: ' + fmtps[1]);
  assert.ok(!/maxaveragebitrate/.test(MediaEngine.tuneRemoteSdp(sdp, null)), 'Without a shared-sound m-line only the voice is set (mono)');
  // Our own descriptions accept stereo on every audio m-line (a peer's shared sound then arrives in stereo)
  const allowed = MediaEngine.allowStereo(sdp).match(/a=fmtp:111 [^\r\n]*/g);
  assert.ok(allowed.length === 2 && allowed.every(l => /stereo=1/.test(l)), 'Stereo not accepted: ' + allowed);
  const videoSection = MediaEngine.allowStereo(sdp).split('m=video')[1].split('m=audio')[0];
  assert.ok(!/stereo/.test(videoSection), 'Video m-lines untouched');
  const bare = sdp.replace('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n', '');
  assert.ok(/a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 maxaveragebitrate=128000/.test(MediaEngine.tuneRemoteSdp(bare, '2')), 'Missing fmtp line not added');
  console.log('✓ Test 8 Passed: Shared sound gets a music bitrate; the voice is left alone');

  // 9. Screen-sharing quality follows the measured bandwidth: down after two low measurements (straight
  // to the level that fits), up one level after three comfortably higher ones
  const sharer = new MediaEngine();
  await sharer.initLocalMedia({ audio: false });
  const link = sharer.createPeerConnection('viewer', true);
  link.connectionState = 'connected';
  const screenTrack = new FakeTrack('video', 'screen');
  screenTrack.getSettings = () => ({ height: 1080 });
  sharer.screenStream = new MediaStream([screenTrack]);
  sharer.screenLevels = new WeakMap();
  await sharer.sendVideo(link, screenTrack);
  const soundTrack = new FakeTrack('audio', 'system sound');
  sharer.screenAudioTrack = soundTrack;
  await sharer.sendScreenAudio(link, soundTrack);
  let bandwidth = 5000;
  sharer.availableKbps = async () => bandwidth;
  const level = () => sharer.screenLevelsNow().viewer;
  const step = async (kbps, times = 1) => { bandwidth = kbps; for (let i = 0; i < times; i++) await sharer.adaptScreenQuality(); return level(); };
  assert.strictEqual(level(), undefined);
  assert.strictEqual(await step(5000), 720, 'Starts at 720p until measured; one good measurement is not enough');
  assert.strictEqual(await step(5000, 2), 1080, 'Up after three good measurements');
  const video = link.getSenders().find(x => x.track === screenTrack);
  assert.deepStrictEqual([video.encoding.scaleResolutionDownBy, video.encoding.maxBitrate, video.encoding.maxFramerate], [1, 4000000, 30]);
  assert.strictEqual(await step(1000), 1080, 'One low measurement is not enough to step down');
  assert.strictEqual(await step(1000), 540, 'Two low measurements: straight to the level that fits');
  assert.strictEqual(video.encoding.scaleResolutionDownBy, 2, '540p from a 1080p screen');
  assert.strictEqual(link.getSenders().find(x => x.track === soundTrack).encoding.maxBitrate, 96000, 'The shared sound follows the level');
  assert.strictEqual(await step(2000, 3), 540, 'Up needs a margin above the next level (1800 x 1.25)');
  assert.strictEqual(await step(2300, 3), 720, 'Up one level with the margin');
  assert.strictEqual(await step(300, 2), 270, 'A very slow link: the lowest level');
  assert.strictEqual(await step(99999, 30), 1080, 'Never above 1080p');
  sharer.destroy();
  console.log('✓ Test 9 Passed: Screen-sharing quality follows the measured bandwidth, without flickering');

  console.log('\n========================================');
  console.log(' ALL CAMERA TESTS PASSED!               ');
  console.log('========================================');
})().catch(err => {
  console.error('Camera test failure:', err);
  process.exit(1);
});
