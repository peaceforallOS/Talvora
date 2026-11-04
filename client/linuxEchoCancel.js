/**
 * Linux echo cancellation for the microphone (main process). Chromium on Linux only cancels what
 * Talvora itself plays, so other programs' sound reached people through the speakers and the
 * microphone. While a call uses the microphone, a helper process runs PipeWire's echo module in monitor
 * mode: its reference is whatever the default speakers play, so no sound is rerouted and no setting
 * changes. It only adds one input device, "Talvora clean microphone", which the page opens instead of
 * the microphone itself. In a simulated room: music -34 -> -90 dB, a voice unchanged within about 1 dB.
 * A larger buffer (node.latency) let more through, so the graph's own timing is kept.
 *
 * The helper ends with Talvora, even after a crash: it stops when its stdin closes. Without PipeWire
 * (or with one too old for monitor mode) nothing starts, and the page uses the microphone as before.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const CLEAN_MIC_LABEL = 'Talvora clean microphone';
const MIN_VERSION = [0, 3, 66]; // the first with monitor mode that Linux distributions ship
const CONFIG_FILE = 'echo-cancel.conf';
const STOP_WAIT_MS = 1500;
// Stops PipeWire's helper when stdin closes: however Talvora ends, the pipe does too
const HELPER_SCRIPT = 'pipewire -c "$0" & p=$!; cat > /dev/null; kill "$p" 2> /dev/null';

function parseVersion(text) {
  const match = /Linked with libpipewire (\d+)\.(\d+)\.(\d+)/.exec(text || '') || /libpipewire (\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return match ? match.slice(1, 4).map(Number) : null;
}

function supportsMonitorMode(version) {
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== MIN_VERSION[i]) return version[i] > MIN_VERSION[i];
  }
  return true;
}

// An AppImage points the library path at its own libraries, which the system's PipeWire must not load
function systemEnv(env = process.env) {
  const clean = { ...env };
  if (env.APPDIR && env.LD_LIBRARY_PATH) {
    const kept = env.LD_LIBRARY_PATH.split(':').filter(dir => dir && !dir.startsWith(env.APPDIR));
    if (kept.length) clean.LD_LIBRARY_PATH = kept.join(':');
    else delete clean.LD_LIBRARY_PATH;
  }
  return clean;
}

// The PipeWire name of the input device the page knows by its label (from `pw-dump`)
function findMicNode(dumpJson, label) {
  if (!label) return null;
  try {
    for (const object of JSON.parse(dumpJson)) {
      const props = object.info?.props;
      if (props && props['media.class']?.startsWith('Audio/Source') && props['node.description'] === label) return props['node.name'];
    }
  } catch (e) {
    // no usable answer: the default microphone
  }
  return null;
}

// micNode: the microphone to clean; without one, the default microphone
function makeConfig(micNode) {
  const target = micNode ? ` target.object = ${JSON.stringify(micNode)}` : '';
  return `context.properties = { log.level = 0 }
context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.*       = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-echo-cancel
    args = {
      library.name = aec/libspa-aec-webrtc
      monitor.mode = true
      audio.channels = 1
      audio.position = [ MONO ]
      aec.args = { webrtc.gain_control = false webrtc.noise_suppression = false webrtc.extended_filter = true webrtc.delay_agnostic = true }
      capture.props = { node.name = "talvora_ec_capture" node.passive = true${target} }
      source.props = { node.name = "talvora_ec_source" node.description = ${JSON.stringify(CLEAN_MIC_LABEL)} }
      sink.props = { node.name = "talvora_ec_sink" }
    }
  }
]
`;
}

function createEchoCancel({ platform = process.platform, spawn = childProcess.spawn, spawnSync = childProcess.spawnSync, env = process.env } = {}) {
  let helper = null;
  let helperMic = null;
  let supported = null;

  function isSupported() {
    if (platform !== 'linux') return false;
    if (supported === null) {
      const result = spawnSync('pipewire', ['--version'], { env: systemEnv(env), encoding: 'utf8', timeout: 3000 });
      supported = result.status === 0 && supportsMonitorMode(parseVersion(result.stdout));
    }
    return supported;
  }

  // Resolves once the helper has ended, so a new one's device cannot be confused with the old one's
  function stop() {
    if (!helper) return Promise.resolve();
    const child = helper;
    helper = null;
    helperMic = null;
    return new Promise(resolve => {
      const timer = setTimeout(resolve, STOP_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }

  // Resolves whether the helper runs. The device takes a moment to appear; the page looks for it.
  async function start(dir, micLabel) {
    if (!isSupported()) return false;
    const dump = micLabel ? spawnSync('pw-dump', [], { env: systemEnv(env), encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 }) : null;
    const micNode = dump ? findMicNode(dump.stdout, micLabel) : null;
    if (helper && helperMic === micNode) return true;
    await stop();
    try {
      const file = path.join(dir, CONFIG_FILE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, makeConfig(micNode));
      const child = spawn('sh', ['-c', HELPER_SCRIPT, file], { env: systemEnv(env), stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => { if (helper === child) { helper = null; helperMic = null; } });
      child.on('exit', () => { if (helper === child) { helper = null; helperMic = null; } });
      child.stdin.on('error', () => {}); // the helper already ended
      helper = child;
      helperMic = micNode;
      return true;
    } catch (e) {
      console.warn('Could not start echo cancellation:', e.message);
      return false;
    }
  }

  return { start, stop, isSupported };
}

module.exports = { CLEAN_MIC_LABEL, parseVersion, supportsMonitorMode, systemEnv, findMicNode, makeConfig, createEchoCancel };
