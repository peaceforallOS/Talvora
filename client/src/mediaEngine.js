/**
 * Media Engine — Voice, Video, Screen Share & WebRTC Relay Management
 */

// RNNoise (neural noise suppression) runs in an AudioWorklet; it requires 48 kHz audio
const RNNOISE_DIR = 'vendor/rnnoise/';
const AUDIO_SAMPLE_RATE = 48000;

// Voice activity detection on the noise-suppressed signal. Normal speech sits around
// -35..-20 dBFS; RNNoise pushes background noise below about -60 dBFS.
const VOICE_THRESHOLD_DB = -50;
const VOICE_HOLD_MS = 400; // keep the indicator on between words
const METER_FLOOR_DB = -65;
const METER_CEILING_DB = -15;

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: AUDIO_SAMPLE_RATE };
// The computer's sound shared with the screen: its own track, never through the microphone's noise
// suppression. Echo cancellation stays on: the capture also records what Talvora itself plays (the
// others' voices and shared sound), which it removes, so nobody hears themselves; noise suppression and
// automatic gain would damage music. Sent at a music bitrate, without silence suppression.
const SCREEN_AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
const SCREEN_AUDIO_OPUS = { maxaveragebitrate: 128000, usedtx: 0, useinbandfec: 1 };
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } };

// Tracks how loud a signal is and whether someone is talking on it
class VoiceDetector {
  constructor(audioContext, sourceNode) {
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    sourceNode.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.lastVoiceAt = 0;
    this.speaking = false;
  }

  // Returns { level: 0-100, speaking }
  sample(now) {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sumSquares = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      sumSquares += this.buffer[i] * this.buffer[i];
    }
    const db = 20 * Math.log10(Math.sqrt(sumSquares / this.buffer.length) || 1e-8);
    if (db > VOICE_THRESHOLD_DB) this.lastVoiceAt = now;
    this.speaking = now - this.lastVoiceAt < VOICE_HOLD_MS;
    const level = ((db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)) * 100;
    return { level: Math.round(Math.min(100, Math.max(0, level))), speaking: this.speaking };
  }

  disconnect() {
    this.analyser.disconnect();
  }
}

class MediaEngine {
  constructor(options = {}) {
    this.onRemoteTrack = options.onRemoteTrack || (() => {});
    this.onAudioLevel = options.onAudioLevel || (() => {});
    this.onPeerSpeaking = options.onPeerSpeaking || (() => {});
    this.onSendSignal = options.onSendSignal || (() => {});
    this.onScreenShareEnded = options.onScreenShareEnded || (() => {});
    this.onRemoteScreenAudio = options.onRemoteScreenAudio || (() => {}); // (peerId, track | null)

    this.localStream = null;
    this.screenStream = null;
    this.screenAudioTrack = null; // the computer's sound while sharing the screen
    this.screenAudioStream = new MediaStream(); // its own stream id, apart from the microphone's
    this.screenAudioSenders = new WeakMap(); // RTCPeerConnection -> the sender of our shared sound
    this.remoteScreenAudio = new Map(); // peerId -> that peer's shared sound (played apart from their voice)
    this.peerConnections = new Map(); // peerId -> RTCPeerConnection
    this.videoSenders = new WeakMap(); // RTCPeerConnection -> the sender of our one outgoing video (camera or screen)
    this.negotiation = new Map(); // peerId -> { polite, makingOffer, ignoreOffer, queue }
    this.remoteStreams = new Map(); // peerId -> MediaStream aggregating that peer's tracks
    this.audioContext = null;
    this.audioContextReady = null; // resolves the audioContext once it runs (see ensureAudioContext)
    this.micStarting = null; // pending startMicrophone()
    this.rawAudioTrack = null; // microphone track before noise suppression
    this.micSource = null; // its node in the processing graph, replaced when the microphone changes
    this.micInput = null; // first processing node (the high-pass filter)
    this.preferredDevices = {}; // { audioinput, videoinput } ids chosen in the settings
    this.noiseSuppressor = null;
    this.localDetector = null;
    this.peerDetectors = new Map(); // peerId -> { detector, source, track }
    this.levelInterval = null;
    this.generation = 0;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  setIceServers(iceServers) {
    this.rtcConfig = { ...this.rtcConfig, iceServers };
  }

  /**
   * Open the microphone (and the camera, if asked) when joining. Without voice permission nothing
   * is opened (audio: false): the microphone opens with startMicrophone() once the user may speak
   * and unmutes. The camera is usually opened later with startCamera(), only once it is turned on.
   */
  async initLocalMedia({ audio = true, video = false } = {}) {
    // destroy() bumps the generation; a capture that resolves afterwards is discarded
    const generation = this.generation;
    let stream;
    // The devices chosen earlier, if still connected (ideal: falls back to the default otherwise)
    const preferred = kind => (this.preferredDevices[kind] ? { deviceId: { ideal: this.preferredDevices[kind] } } : {});
    if (!audio && !video) {
      stream = new MediaStream();
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audio ? { ...AUDIO_CONSTRAINTS, ...preferred('audioinput') } : false,
          video: video ? { ...VIDEO_CONSTRAINTS, ...preferred('videoinput') } : false
        });
      } catch (err) {
        console.warn('getUserMedia failed, trying audio only fallback:', err);
        try {
          stream = audio ? await navigator.mediaDevices.getUserMedia({ audio: true, video: false }) : new MediaStream();
        } catch (audioErr) {
          console.warn('Microphone access also failed or unavailable:', audioErr);
          // Create an empty dummy MediaStream so app functions without crashing on headless systems
          stream = new MediaStream();
        }
      }
    }

    if (generation !== this.generation) {
      stream.getTracks().forEach(t => t.stop());
      return null;
    }
    // Without a microphone, still analyse peers' audio to show who is speaking
    if (stream.getAudioTracks().length) await this.setupAudioProcessing(stream, generation);
    else await this.ensureAudioContext(generation);
    if (generation !== this.generation) {
      stream.getTracks().forEach(t => t.stop());
      return null;
    }
    this.localStream = stream;

    // Peers may have connected while we were waiting for device access
    for (const pc of this.peerConnections.values()) {
      this.addLocalTracks(pc);
    }
    return this.localStream;
  }

  /**
   * Attach local tracks that this connection is not sending yet.
   * While screen sharing, the screen track is sent in place of the camera.
   */
  addLocalTracks(pc) {
    const audio = this.localStream?.getAudioTracks()[0];
    if (audio && !pc.getSenders().some(s => s.track === audio)) pc.addTrack(audio, this.localStream);
    const video = this.screenStream?.getVideoTracks()[0] || this.localStream?.getVideoTracks()[0] || null;
    if (video) this.sendVideo(pc, video);
    if (this.screenAudioTrack) this.sendScreenAudio(pc, this.screenAudioTrack);
  }

  /**
   * Send the computer's sound (or null for nothing) on this connection's shared-sound slot: the first
   * share adds the sender (one negotiation), later shares reuse it, like the video slot.
   */
  sendScreenAudio(pc, track) {
    if (pc.signalingState === 'closed') return Promise.resolve();
    const sender = this.screenAudioSenders.get(pc);
    if (sender && pc.getSenders().includes(sender)) {
      if (sender.track === track) return Promise.resolve();
      return sender.replaceTrack(track).catch(e => console.warn('Cannot change the shared sound:', e));
    }
    if (track) this.screenAudioSenders.set(pc, pc.addTrack(track, this.screenAudioStream));
    return Promise.resolve();
  }

  // The m-line (mid) of our shared sound on this connection, once negotiated; told to the peer with
  // every description so it plays that track apart from our voice
  screenAudioMid(pc) {
    const sender = this.screenAudioSenders.get(pc);
    if (!sender || !pc.getTransceivers) return null;
    const transceiver = pc.getTransceivers().find(t => t.sender === sender);
    return (transceiver && transceiver.mid) || null;
  }

  /**
   * Our encoder follows the codec parameters in the peer's description: for the shared-sound m-line,
   * ask for a music bitrate without silence suppression. Only our own sending is affected.
   */
  static tuneRemoteSdp(sdp, mid, params = SCREEN_AUDIO_OPUS) {
    if (!mid || typeof sdp !== 'string') return sdp;
    const sections = sdp.split(/(?=\r?\nm=)/);
    return sections.map(section => {
      if (!new RegExp(`\\r?\\na=mid:${mid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\r?\\n|$)`).test(section)) return section;
      const opus = section.match(/a=rtpmap:(\d+) opus\/48000[^\r\n]*/i);
      if (!opus) return section;
      const fmtp = new RegExp(`(a=fmtp:${opus[1]} )([^\\r\\n]*)`);
      const merge = existing => {
        const values = new Map(existing.split(';').map(p => p.trim()).filter(Boolean).map(p => p.split('=')));
        for (const [key, value] of Object.entries(params)) values.set(key, String(value));
        return [...values].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
      };
      if (fmtp.test(section)) return section.replace(fmtp, (m, head, existing) => head + merge(existing));
      const eol = section.includes('\r\n') ? '\r\n' : '\n';
      return section.replace(opus[0], `${opus[0]}${eol}a=fmtp:${opus[1]} ${merge('')}`);
    }).join('');
  }

  // A peer's shared sound arrived (or ended): played on its own, never counted as their voice
  setRemoteScreenAudio(peerId, track) {
    const remoteStream = this.remoteStreams.get(peerId);
    if (track && remoteStream && remoteStream.getTracks().includes(track)) {
      remoteStream.removeTrack(track);
      if (this.peerDetectors.get(peerId)?.track === track) {
        this.unwatchPeerAudio(peerId);
        this.watchPeerAudio(peerId, remoteStream);
      }
    }
    if ((this.remoteScreenAudio.get(peerId) || null) === track) return;
    if (track) this.remoteScreenAudio.set(peerId, track);
    else this.remoteScreenAudio.delete(peerId);
    this.onRemoteScreenAudio(peerId, track);
  }

  // The peer told us which m-line carries its shared sound: sort its audio tracks accordingly
  sortRemoteAudio(peerId, pc, mid) {
    const transceiver = mid && pc.getTransceivers ? pc.getTransceivers().find(t => t.mid === mid) : null;
    const track = transceiver?.receiver?.track;
    if (track && track.kind === 'audio') this.setRemoteScreenAudio(peerId, track);
  }

  /**
   * Send `track` (camera, screen, or null for nothing) as this connection's video. The first video
   * adds a sender (one negotiation); later changes reuse it, so turning the camera on and off and
   * screen sharing need no renegotiation.
   */
  sendVideo(pc, track) {
    if (pc.signalingState === 'closed') return Promise.resolve();
    const sender = this.videoSenders.get(pc);
    if (sender && pc.getSenders().includes(sender)) {
      if (sender.track === track) return Promise.resolve();
      return sender.replaceTrack(track).catch(e => console.warn('Cannot change the outgoing video:', e));
    }
    if (track) this.videoSenders.set(pc, pc.addTrack(track, this.localStream || this.screenStream || new MediaStream([track])));
    return Promise.resolve();
  }

  /**
   * Route the microphone through noise suppression (high-pass filter + RNNoise) and swap the
   * cleaned track into `stream`, so peers only ever receive the processed audio. Also starts
   * voice activity detection. If processing is unavailable the raw (browser-denoised) track is kept.
   */
  async setupAudioProcessing(stream, generation) {
    const rawTrack = stream.getAudioTracks()[0];
    if (!rawTrack) return;
    const ctx = await this.ensureAudioContext(generation);
    if (!ctx) return;

    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    // Remove rumble, desk thumps and mains hum below the voice range
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    source.connect(highpass);

    let cleaned = highpass;
    let noiseSuppressor = null;
    try {
      noiseSuppressor = await this.createNoiseSuppressor(ctx);
      highpass.connect(noiseSuppressor);
      cleaned = noiseSuppressor;
    } catch (e) {
      console.warn('RNNoise noise suppression unavailable, using browser noise suppression only:', e);
    }
    // destroy() ran while the worklet was loading (it closed the context): the caller discards the stream
    if (generation !== this.generation) return;

    const destination = ctx.createMediaStreamDestination();
    cleaned.connect(destination);
    const processedTrack = destination.stream.getAudioTracks()[0];

    this.noiseSuppressor = noiseSuppressor;
    this.rawAudioTrack = rawTrack;
    this.micSource = source;
    this.micInput = highpass;
    stream.removeTrack(rawTrack);
    stream.addTrack(processedTrack);
    this.localDetector = new VoiceDetector(ctx, cleaned);
  }

  /**
   * The audio graph shared by the microphone's processing and the peers' speaking detection.
   * Created once per call; resolves null when audio processing cannot run.
   */
  ensureAudioContext(generation) {
    if (!this.audioContextReady) {
      this.audioContextReady = (async () => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        let ctx;
        try {
          ctx = new AudioCtx({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'interactive' });
          // A suspended context would send silence; give up on processing if it will not run
          await Promise.race([ctx.resume(), new Promise(resolve => setTimeout(resolve, 1000))]);
          if (ctx.state !== 'running') throw new Error(`AudioContext is ${ctx.state}`);
        } catch (e) {
          console.warn('Audio processing unavailable:', e);
          if (ctx) ctx.close();
          return null;
        }
        if (generation !== this.generation) {
          ctx.close();
          return null;
        }
        this.audioContext = ctx;
        this.startLevelMonitor();
        // Peers whose audio arrived while the context was starting
        for (const [peerId, remoteStream] of this.remoteStreams) {
          this.watchPeerAudio(peerId, remoteStream);
        }
        return ctx;
      })();
    }
    return this.audioContextReady;
  }

  /**
   * Open the microphone during the call (joined without voice permission). The new track starts
   * muted and is added to every connection (one negotiation); the caller unmutes it.
   * Resolves the track, or null when the engine was reset meanwhile. Throws when it cannot be opened.
   */
  async startMicrophone() {
    const existing = this.localStream?.getAudioTracks()[0];
    if (existing) return existing;
    if (this.micStarting) return this.micStarting;
    const generation = this.generation;
    this.micStarting = (async () => {
      const preferred = this.preferredDevices.audioinput ? { deviceId: { ideal: this.preferredDevices.audioinput } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS, ...preferred } });
      if (generation !== this.generation) {
        stream.getTracks().forEach(t => t.stop());
        return null;
      }
      await this.setupAudioProcessing(stream, generation);
      const track = stream.getAudioTracks()[0];
      if (generation !== this.generation || !track) {
        stream.getTracks().forEach(t => t.stop());
        return null;
      }
      if (!this.localStream) this.localStream = new MediaStream();
      this.localStream.addTrack(track);
      this.setAudioEnabled(false);
      for (const pc of this.peerConnections.values()) {
        if (pc.signalingState !== 'closed') this.addLocalTracks(pc);
      }
      return track;
    })();
    try {
      return await this.micStarting;
    } finally {
      this.micStarting = null;
    }
  }

  async createNoiseSuppressor(ctx) {
    const simdSupported = WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]));
    const wasmUrl = RNNOISE_DIR + (simdSupported ? 'rnnoise_simd.wasm' : 'rnnoise.wasm');
    const [wasmBinary] = await Promise.all([
      fetch(wasmUrl).then(res => {
        if (!res.ok) throw new Error(`Could not load ${wasmUrl} (${res.status})`);
        return res.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(RNNOISE_DIR + 'workletProcessor.js')
    ]);
    // RNNoise only processes one channel: mix stereo microphones down to mono first
    return new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions: { maxChannels: 1, wasmBinary }
    });
  }

  // Analyse a peer's incoming audio to show when they are talking
  watchPeerAudio(peerId, stream) {
    const track = stream.getAudioTracks()[0];
    const existing = this.peerDetectors.get(peerId);
    if (!this.audioContext || !track || existing?.track === track) return;
    this.unwatchPeerAudio(peerId);
    try {
      const source = this.audioContext.createMediaStreamSource(new MediaStream([track]));
      this.peerDetectors.set(peerId, { detector: new VoiceDetector(this.audioContext, source), source, track });
    } catch (e) {
      console.warn(`Cannot analyse audio from peer ${peerId}:`, e);
    }
  }

  unwatchPeerAudio(peerId) {
    const entry = this.peerDetectors.get(peerId);
    if (!entry) return;
    entry.source.disconnect();
    entry.detector.disconnect();
    this.peerDetectors.delete(peerId);
    if (entry.detector.speaking) this.onPeerSpeaking(peerId, false);
  }

  startLevelMonitor() {
    if (this.levelInterval) clearInterval(this.levelInterval);
    this.levelInterval = setInterval(() => {
      const now = performance.now();
      const track = this.localStream?.getAudioTracks()[0];
      if (this.localDetector) {
        const { level, speaking } = this.localDetector.sample(now);
        const live = !!track && track.enabled;
        this.onAudioLevel(live ? level : 0, live && speaking);
      }
      for (const [peerId, { detector }] of this.peerDetectors) {
        const wasSpeaking = detector.speaking;
        const { speaking } = detector.sample(now);
        if (speaking !== wasSpeaking) this.onPeerSpeaking(peerId, speaking);
      }
    }, 50);
  }

  setAudioEnabled(enabled) {
    if (!this.localStream) return false;
    const track = this.localStream.getAudioTracks()[0];
    if (this.rawAudioTrack) this.rawAudioTrack.enabled = !!enabled;
    if (track) {
      track.enabled = !!enabled;
      return track.enabled;
    }
    return false;
  }

  /**
   * Camera: open only while it is on. Off releases the device (its light goes out) and frees the
   * capture, encoding and preview memory; peers keep the video slot and receive nothing.
   * Resolves the camera track, or null when the engine was reset meanwhile. Throws when the
   * camera cannot be opened.
   */
  async startCamera() {
    const existing = this.localStream?.getVideoTracks()[0];
    if (existing) return existing;
    const generation = this.generation;
    const preferred = this.preferredDevices.videoinput ? { deviceId: { ideal: this.preferredDevices.videoinput } } : {};
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_CONSTRAINTS, ...preferred } });
    const track = stream.getVideoTracks()[0];
    if (generation !== this.generation || !track || this.localStream?.getVideoTracks()[0]) {
      stream.getTracks().forEach(t => t.stop());
      return generation === this.generation ? this.localStream?.getVideoTracks()[0] || null : null;
    }
    if (!this.localStream) this.localStream = new MediaStream();
    this.localStream.addTrack(track);
    // While screen sharing, peers keep seeing the screen; the camera follows when sharing stops
    if (!this.screenStream) {
      await Promise.all([...this.peerConnections.values()].map(pc => this.sendVideo(pc, track)));
    }
    return track;
  }

  stopCamera() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    this.localStream.removeTrack(track);
    track.stop();
    for (const pc of this.peerConnections.values()) {
      if (this.videoSenders.get(pc)?.track === track) this.sendVideo(pc, null);
    }
  }

  get cameraOn() {
    return !!this.localStream?.getVideoTracks()[0];
  }

  // --- Device selection (settings) ---

  setPreferredDevices(devices) {
    this.preferredDevices = { ...this.preferredDevices, ...devices };
  }

  // Ids of the microphone and camera in use (to show in the settings)
  currentDevices() {
    const mic = this.rawAudioTrack || this.localStream?.getAudioTracks()[0];
    const cam = this.localStream?.getVideoTracks()[0];
    return { audioinput: mic?.getSettings().deviceId || null, videoinput: cam?.getSettings().deviceId || null };
  }

  /**
   * Switch to another microphone during the call. With noise suppression running, only the
   * source of the processing graph changes, so peers keep receiving the same track; mute stays.
   */
  async switchMicrophone(deviceId) {
    const current = this.rawAudioTrack || this.localStream?.getAudioTracks()[0];
    // Microphone not opened yet (no voice permission so far): only remember the choice
    if (!current) {
      this.setPreferredDevices({ audioinput: deviceId });
      return null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } });
    const track = stream.getAudioTracks()[0];
    track.enabled = current ? current.enabled : true;
    this.setPreferredDevices({ audioinput: deviceId });

    if (this.audioContext && this.micInput) {
      const source = this.audioContext.createMediaStreamSource(new MediaStream([track]));
      source.connect(this.micInput);
      if (this.micSource) this.micSource.disconnect();
      this.micSource = source;
      this.rawAudioTrack = track;
    } else {
      if (!this.localStream) this.localStream = new MediaStream();
      if (current) this.localStream.removeTrack(current);
      this.localStream.addTrack(track);
      for (const pc of this.peerConnections.values()) {
        const sender = current && pc.getSenders().find(s => s.track === current);
        if (sender) await sender.replaceTrack(track);
        else if (pc.signalingState !== 'closed') pc.addTrack(track, this.localStream);
      }
    }
    if (current) current.stop();
    return track;
  }

  // Switch to another camera during the call; while screen sharing, peers keep seeing the screen.
  // With the camera off, the choice is only remembered and used when it is turned on.
  async switchCamera(deviceId) {
    this.setPreferredDevices({ videoinput: deviceId });
    const current = this.localStream?.getVideoTracks()[0] || null;
    if (!current) return null;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } });
    const track = stream.getVideoTracks()[0];
    if (this.localStream?.getVideoTracks()[0] !== current) {
      // turned off (or the engine reset) while the new camera was opening
      track.stop();
      return null;
    }
    this.localStream.removeTrack(current);
    this.localStream.addTrack(track);
    if (!this.screenStream) {
      await Promise.all([...this.peerConnections.values()].map(pc => this.sendVideo(pc, track)));
    }
    current.stop();
    return track;
  }

  /**
   * Share the screen, and with `audio` the computer's sound, which the main process grants with the
   * screen (Windows: system audio; Linux: the speakers' monitor in PulseAudio/PipeWire).
   */
  async startScreenShare({ audio = false } = {}) {
    if (this.screenStream) return this.screenStream;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: audio ? SCREEN_AUDIO_CONSTRAINTS : false
      });

      const screenTrack = this.screenStream.getVideoTracks()[0];
      screenTrack.onended = () => {
        this.stopScreenShare();
        this.onScreenShareEnded();
      };

      // Sent in place of the camera
      for (const pc of this.peerConnections.values()) {
        this.sendVideo(pc, screenTrack);
      }

      if (audio) {
        const shared = this.screenStream.getAudioTracks()[0];
        if (shared) {
          shared.contentHint = 'music';
          this.screenAudioTrack = shared;
          for (const pc of this.peerConnections.values()) this.sendScreenAudio(pc, shared);
        }
      }

      return this.screenStream;
    } catch (err) {
      console.warn('Screen share cancelled or failed:', err);
      return null;
    }
  }

  get sharingAudio() {
    return !!this.screenAudioTrack;
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    const screenTrack = this.screenStream.getVideoTracks()[0];
    this.screenStream.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    if (this.screenAudioTrack) {
      this.screenAudioTrack.stop();
      this.screenAudioTrack = null;
      for (const pc of this.peerConnections.values()) {
        if (this.screenAudioSenders.get(pc)?.track) this.sendScreenAudio(pc, null);
      }
    }

    // Back to the camera, or to no video when the camera is off
    const camTrack = this.localStream?.getVideoTracks()[0] || null;
    for (const pc of this.peerConnections.values()) {
      if (this.videoSenders.get(pc)?.track === screenTrack) this.sendVideo(pc, camTrack);
    }
  }

  // --- WebRTC Peer Connection & Signaling ---
  //
  // Uses the "perfect negotiation" pattern: either side may (re)negotiate whenever its
  // tracks change, and offer collisions are resolved by one side being polite. The peer
  // that joins later initiates and is impolite; the peer already in the room is polite.

  createPeerConnection(peerId, isInitiator = false) {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const state = { polite: !isInitiator, makingOffer: false, ignoreOffer: false, queue: Promise.resolve() };
    this.peerConnections.set(peerId, pc);
    this.negotiation.set(peerId, state);

    // Handle remote media tracks: aggregate all of a peer's tracks in one stream; their shared
    // sound (the m-line they told us about) is kept apart from their voice
    pc.ontrack = event => {
      if (event.track.kind === 'audio' && state.remoteScreenAudioMid && event.transceiver?.mid === state.remoteScreenAudioMid) {
        this.setRemoteScreenAudio(peerId, event.track);
        event.track.addEventListener('ended', () => {
          if (this.remoteScreenAudio.get(peerId) === event.track) this.setRemoteScreenAudio(peerId, null);
        });
        return;
      }
      let remoteStream = this.remoteStreams.get(peerId);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        this.remoteStreams.set(peerId, remoteStream);
      }
      if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }
      event.track.addEventListener('ended', () => {
        remoteStream.removeTrack(event.track);
        if (this.peerDetectors.get(peerId)?.track === event.track) this.unwatchPeerAudio(peerId);
      });
      if (event.track.kind === 'audio') this.watchPeerAudio(peerId, remoteStream);
      this.onRemoteTrack(peerId, remoteStream, event.track);
    };

    // Handle ICE candidates
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.onSendSignal(peerId, { candidate: event.candidate });
      }
    };

    // ICE connection state monitor
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        console.warn(`Peer ${peerId} ICE failed, restarting ICE`);
        pc.restartIce();
      } else if (pc.iceConnectionState === 'disconnected') {
        console.warn(`Peer ${peerId} ICE state: disconnected`);
      }
    };

    // Send an offer whenever our side's tracks change
    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        this.onSendSignal(peerId, { sdp: pc.localDescription, screenAudioMid: this.screenAudioMid(pc) });
      } catch (err) {
        console.error('Error creating SDP offer:', err);
      } finally {
        state.makingOffer = false;
      }
    };

    // Add local media tracks (triggers negotiation when there is anything to send)
    this.addLocalTracks(pc);

    return pc;
  }

  handleSignal(peerId, signal) {
    if (!this.peerConnections.has(peerId)) {
      this.createPeerConnection(peerId, false);
    }
    // Process signals for a peer strictly in order: a candidate must not race its description
    const state = this.negotiation.get(peerId);
    state.queue = state.queue.then(() => this.processSignal(peerId, signal));
    return state.queue;
  }

  async processSignal(peerId, signal) {
    const pc = this.peerConnections.get(peerId);
    const state = this.negotiation.get(peerId);
    if (!pc || !state) return; // peer left while signals were queued

    try {
      if (signal.sdp) {
        const offerCollision =
          signal.sdp.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
        state.ignoreOffer = !state.polite && offerCollision;
        if (state.ignoreOffer) return;

        // Which of the peer's m-lines is its shared sound (peers before 1.12.0 do not say)
        if ('screenAudioMid' in signal) state.remoteScreenAudioMid = signal.screenAudioMid || null;
        const sdp = MediaEngine.tuneRemoteSdp(signal.sdp.sdp, this.screenAudioMid(pc));
        await pc.setRemoteDescription({ type: signal.sdp.type, sdp });
        this.sortRemoteAudio(peerId, pc, state.remoteScreenAudioMid);
        if (signal.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.onSendSignal(peerId, { sdp: pc.localDescription, screenAudioMid: this.screenAudioMid(pc) });
        }
      } else if (signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          // Candidates for an offer we deliberately ignored are expected to fail
          if (!state.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error(`Signaling error with peer ${peerId}:`, err);
    }
  }

  removePeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    this.negotiation.delete(peerId);
    this.remoteStreams.delete(peerId);
    this.unwatchPeerAudio(peerId);
    if (this.remoteScreenAudio.has(peerId)) this.setRemoteScreenAudio(peerId, null);
  }

  destroy() {
    this.generation++;
    if (this.levelInterval) clearInterval(this.levelInterval);
    this.levelInterval = null;
    this.peerDetectors.clear();
    if (this.localDetector) this.onAudioLevel(0, false);
    this.localDetector = null;
    this.noiseSuppressor = null; // released with the AudioContext below
    if (this.audioContext) this.audioContext.close();
    this.audioContext = null;
    this.audioContextReady = null;
    this.micStarting = null;
    if (this.rawAudioTrack) this.rawAudioTrack.stop();
    this.rawAudioTrack = null;
    this.micSource = null;
    this.micInput = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    if (this.screenAudioTrack) this.screenAudioTrack.stop();
    this.screenAudioTrack = null;
    this.screenAudioSenders = new WeakMap();
    for (const peerId of [...this.remoteScreenAudio.keys()]) this.setRemoteScreenAudio(peerId, null);
    for (const pc of this.peerConnections.values()) {
      pc.close();
    }
    this.peerConnections.clear();
    this.negotiation.clear();
    this.remoteStreams.clear();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaEngine;
}
