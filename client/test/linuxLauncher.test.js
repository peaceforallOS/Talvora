/**
 * Linux Launcher Tests — missing system libraries are found, mapped to the right packages for each
 * package manager, and the app starts with its arguments once nothing is missing
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('Linux launcher tests skipped (they need Linux; run them in WSL or on Linux).');
  process.exit(0);
}

// The launcher next to a stand-in for the Electron binary, as afterPack.js arranges them
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videocall-launcher-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const launcher = path.join(dir, 'videocall');
fs.copyFileSync(path.join(__dirname, '../build/linux-launcher.sh'), launcher);
fs.chmodSync(launcher, 0o755);
fs.writeFileSync(path.join(dir, 'videocall-bin'), '#!/bin/sh\necho "STARTED $*"\n', { mode: 0o755 });

function run(env, args = []) {
  const result = spawnSync('bash', [launcher, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 30000
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

function dryRun(pm, missing) {
  const { code, out } = run({ VIDEOCALL_PREREQS_DRY_RUN: '1', VIDEOCALL_PREREQS_PM: pm, VIDEOCALL_PREREQS_MISSING: missing });
  assert.strictEqual(code, 0, out);
  assert.ok(!out.includes('STARTED'), 'App started during a dry run');
  const field = name => (out.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1] || '';
  return { packages: field('packages').split(' ').filter(Boolean), unknown: field('unknown'), command: field('command') };
}

console.log('--- Starting Linux Launcher Tests ---');

// 1. Nothing missing: the app starts at once with its arguments (e.g. a join link)
const started = run({ VIDEOCALL_PREREQS_MISSING: '' }, ['https://example.com/join?token=a b']);
assert.strictEqual(started.code, 0, started.out);
assert.ok(started.out.includes('STARTED https://example.com/join?token=a b'), `Arguments not passed on: ${started.out}`);
console.log('✓ Test 1 Passed: App starts with its arguments when nothing is missing');

// 2. Debian/Ubuntu: the packages this release offers (t64 names on Ubuntu 24.04+/Debian 13)
const apt = dryRun('apt', 'libnss3.so libnssutil3.so libnspr4.so libasound.so.2');
const hasApt = spawnSync('sh', ['-c', 'command -v apt-cache'], { encoding: 'utf8' }).status === 0;
assert.ok(apt.packages.includes('libnss3') && apt.packages.includes('libnspr4'), apt.packages.join(' '));
assert.ok(apt.packages.some(p => /^libasound2(t64)?$/.test(p)), apt.packages.join(' '));
if (hasApt) {
  const t64 = spawnSync('sh', ['-c', "apt-cache policy libasound2t64 | grep -q 'Candidate: [^(]'"]).status === 0;
  assert.ok(apt.packages.includes(t64 ? 'libasound2t64' : 'libasound2'), `Wrong ALSA package: ${apt.packages}`);
}
assert.strictEqual(apt.packages.filter(p => p === 'libnss3').length, 1, 'Package listed twice');
assert.ok(apt.command.startsWith('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y '), apt.command);
console.log('✓ Test 2 Passed: Debian/Ubuntu packages chosen for this release');

// 3. Fedora/openSUSE install by library name; Arch by package name
const dnf = dryRun('dnf', 'libnss3.so libgbm.so.1');
assert.deepStrictEqual(dnf.packages.sort(), ['libgbm.so.1()(64bit)', 'libnss3.so()(64bit)']);
assert.ok(dnf.command.startsWith('dnf install -y '), dnf.command);
assert.ok(dryRun('zypper', 'libnss3.so').command.startsWith('zypper --non-interactive install '));
const pacman = dryRun('pacman', 'libnss3.so libasound.so.2 libgtk-3.so.0');
assert.deepStrictEqual(pacman.packages.sort(), ['alsa-lib', 'gtk3', 'nss']);
assert.ok(pacman.command.startsWith('pacman -S --noconfirm --needed '), pacman.command);
console.log('✓ Test 3 Passed: Fedora, openSUSE and Arch install commands built');

// 4. A library without a known package is reported, not silently dropped
const odd = dryRun('apt', 'libnss3.so libunknown.so.7');
assert.strictEqual(odd.unknown, 'libunknown.so.7');
assert.deepStrictEqual(odd.packages, ['libnss3']);
console.log('✓ Test 4 Passed: Unknown libraries reported');

// 5. Every library the real Electron binary needs from the system has a package
const needed = [
  'libglib-2.0.so.0', 'libgobject-2.0.so.0', 'libgio-2.0.so.0', 'libnss3.so', 'libnssutil3.so', 'libsmime3.so',
  'libnspr4.so', 'libdbus-1.so.3', 'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libcups.so.2', 'libdrm.so.2',
  'libgtk-3.so.0', 'libpango-1.0.so.0', 'libcairo.so.2', 'libX11.so.6', 'libXcomposite.so.1', 'libXdamage.so.1',
  'libXext.so.6', 'libXfixes.so.3', 'libXrandr.so.2', 'libgbm.so.1', 'libexpat.so.1', 'libxcb.so.1',
  'libxkbcommon.so.0', 'libudev.so.1', 'libasound.so.2', 'libatspi.so.0'
].join(' ');
for (const pm of ['apt', 'pacman']) {
  assert.strictEqual(dryRun(pm, needed).unknown, '', `${pm}: libraries without a package`);
}
console.log('✓ Test 5 Passed: Every system library Electron needs maps to a package');

// 6. Skipping the check starts the app even with libraries "missing"
const skipped = run({ VIDEOCALL_SKIP_PREREQS: '1', VIDEOCALL_PREREQS_MISSING: 'libnss3.so' });
assert.ok(skipped.out.includes('STARTED'), skipped.out);
console.log('✓ Test 6 Passed: VIDEOCALL_SKIP_PREREQS starts without checking');

console.log('\n========================================');
console.log(' ALL LINUX LAUNCHER TESTS PASSED!       ');
console.log('========================================\n');
