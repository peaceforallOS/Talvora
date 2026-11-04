/**
 * Linux echo cancellation: the helper starts only where it can work, cleans the chosen microphone,
 * does not inherit the AppImage's libraries, and stops with the call.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CLEAN_MIC_LABEL, parseVersion, supportsMonitorMode, systemEnv, findMicNode, makeConfig, createEchoCancel } = require('../linuxEchoCancel');

console.log('--- Starting Linux Echo Cancellation Tests ---');

// 1. Which PipeWire can do it
assert.deepStrictEqual(parseVersion('pipewire\nCompiled with libpipewire 1.6.1\nLinked with libpipewire 1.6.2\n'), [1, 6, 2], 'The running library counts');
assert.strictEqual(parseVersion('command output without a version'), null);
assert.strictEqual(supportsMonitorMode([1, 0, 5]), true, 'Ubuntu 24.04');
assert.strictEqual(supportsMonitorMode([0, 3, 66]), true);
assert.strictEqual(supportsMonitorMode([0, 3, 48]), false, 'Ubuntu 22.04 has no monitor mode');
assert.strictEqual(supportsMonitorMode(null), false);
console.log('✓ Test 1 Passed: Only a PipeWire with monitor mode is used');

// 2. The system's PipeWire must not load the AppImage's libraries
assert.strictEqual(systemEnv({ APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib:/opt/own' }).LD_LIBRARY_PATH, '/opt/own');
assert.ok(!('LD_LIBRARY_PATH' in systemEnv({ APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' })));
assert.strictEqual(systemEnv({ LD_LIBRARY_PATH: '/opt/own' }).LD_LIBRARY_PATH, '/opt/own', 'Not an AppImage: left alone');
console.log('✓ Test 2 Passed: The helper runs with the system\'s libraries');

// 3. The chosen microphone
const dump = JSON.stringify([
  { info: { props: { 'media.class': 'Audio/Sink', 'node.description': 'USB Headset', 'node.name': 'usb_out' } } },
  { info: { props: { 'media.class': 'Audio/Source', 'node.description': 'USB Headset', 'node.name': 'usb_in' } } },
  { type: 'no props here' }
]);
assert.strictEqual(findMicNode(dump, 'USB Headset'), 'usb_in', 'An input, not the output of the same name');
assert.strictEqual(findMicNode(dump, 'Other'), null);
assert.strictEqual(findMicNode('not json', 'USB Headset'), null);
assert.strictEqual(findMicNode(dump, null), null);
const chosenConfig = makeConfig('usb_in');
assert.ok(chosenConfig.includes('monitor.mode = true'), 'No rerouting: the reference is the speakers\' monitor');
assert.ok(chosenConfig.includes('target.object = "usb_in"'), 'The chosen microphone is the one cleaned');
assert.ok(!makeConfig(null).includes('target.object'), 'Otherwise the default microphone, following it when it changes');
assert.ok(makeConfig(null).includes(`node.description = "${CLEAN_MIC_LABEL}"`));
const page = fs.readFileSync(path.join(__dirname, '../src/mediaEngine.js'), 'utf8');
assert.ok(page.includes(`const CLEAN_MIC_LABEL = '${CLEAN_MIC_LABEL}'`), 'The page looks for the device by this name');
console.log('✓ Test 3 Passed: The chosen microphone is cleaned, on a device the page can find');

// 4. Starting and stopping
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talvora-echo-test-'));
function fakeHelper() {
  const spawned = [];
  const engine = createEchoCancel({
    platform: 'linux',
    env: { APPDIR: '/app', LD_LIBRARY_PATH: '/app/lib' },
    spawnSync: cmd => (cmd === 'pw-dump' ? { status: 0, stdout: dump } : { status: 0, stdout: 'Linked with libpipewire 1.6.2\n' }),
    spawn: (cmd, args, options) => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.ended = false;
      child.stdin.end = () => { child.stdin.ended = true; };
      Object.assign(child, { cmd, args, options });
      spawned.push(child);
      return child;
    }
  });
  return { engine, spawned };
}

let { engine, spawned } = fakeHelper();
assert.strictEqual(engine.start(dir, null), true);
assert.strictEqual(spawned.length, 1);
assert.ok(!('LD_LIBRARY_PATH' in spawned[0].options.env), 'Started without the AppImage\'s libraries');
assert.ok(spawned[0].args[1].includes('cat > /dev/null'), 'The helper ends when Talvora does (its stdin closes)');
assert.strictEqual(spawned[0].args[2], path.join(dir, 'echo-cancel.conf'));
assert.ok(!fs.readFileSync(spawned[0].args[2], 'utf8').includes('target.object'));

assert.strictEqual(engine.start(dir, null), true, 'Opening the microphone again');
assert.strictEqual(spawned.length, 1, 'keeps the helper already running');

assert.strictEqual(engine.start(dir, 'USB Headset'), true, 'Another microphone');
assert.strictEqual(spawned.length, 2, 'needs a new helper');
assert.ok(spawned[0].stdin.ended, 'and ends the old one');
assert.ok(fs.readFileSync(spawned[1].args[2], 'utf8').includes('target.object = "usb_in"'));

engine.stop();
assert.ok(spawned[1].stdin.ended, 'Leaving the call ends the helper');
engine.stop(); // already stopped: nothing to do

assert.strictEqual(engine.start(dir, null), true, 'The next call');
assert.strictEqual(spawned.length, 3, 'starts it again');
spawned[2].emit('exit', 1);
assert.strictEqual(engine.start(dir, null), true, 'A helper that died');
assert.strictEqual(spawned.length, 4, 'is replaced, not assumed to be running');
engine.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log('✓ Test 4 Passed: One helper per call, following the chosen microphone');

// 5. Where nothing may start
const never = () => { throw new Error('Must not start anything'); };
assert.strictEqual(createEchoCancel({ platform: 'win32', spawn: never, spawnSync: never }).start(dir, null), false, 'Windows has its own echo cancellation');
const old = createEchoCancel({ platform: 'linux', spawn: never, spawnSync: () => ({ status: 0, stdout: 'Linked with libpipewire 0.3.48\n' }) });
assert.strictEqual(old.start(dir, null), false, 'PipeWire too old');
const none = createEchoCancel({ platform: 'linux', spawn: never, spawnSync: () => ({ status: null, error: new Error('ENOENT'), stdout: null }) });
assert.strictEqual(none.start(dir, null), false, 'No PipeWire at all (PulseAudio)');
console.log('✓ Test 5 Passed: Nothing starts where it cannot work');

console.log('\n========================================');
console.log(' ALL LINUX ECHO CANCELLATION TESTS PASSED!');
console.log('========================================');
