/**
 * Update Tests — only manifests signed by the release key, naming a newer version for this system,
 * are accepted; downloads must match the manifest; the release tooling refuses a mismatched key;
 * on Linux the AppImage is replaced in place
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const updater = require('../updater');

console.log('--- Starting Update Tests ---');

// A stand-in release key; the real one never leaves the release machine
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pkg = Buffer.from('pretend this is VideoCall-Setup.exe');
const entry = { name: 'VideoCall-Setup.exe', size: pkg.length, sha256: crypto.createHash('sha256').update(pkg).digest('hex') };
const manifestFor = (version, files = { win32: entry, linux: { ...entry, name: 'VideoCall.AppImage' } }) =>
  JSON.stringify({ version, released: '2026-10-29T00:00:00Z', files }, null, 2);
const signed = text => crypto.sign(null, Buffer.from(text), privateKey).toString('base64');
const check = (text, signature, currentVersion = '1.1.0', platform = 'win32') =>
  updater.verifyManifest(text, signature, { currentVersion, platform, publicKey });

// 1. Versions compare as numbers
assert.ok(updater.isNewer('1.10.0', '1.9.9'));
assert.ok(updater.isNewer('2.0.0', '1.99.99'));
assert.ok(!updater.isNewer('1.1.0', '1.1.0'), 'Same version is not an update');
assert.ok(!updater.isNewer('1.0.9', '1.1.0'), 'Older version is never installed');
assert.ok(!updater.isNewer('9.9.9-beta', '1.1.0') && !updater.isNewer(undefined, '1.1.0'));
console.log('✓ Test 1 Passed: Only strictly newer x.y.z versions count');

// 2. A validly signed, newer manifest yields the package for this system
const v2 = manifestFor('1.2.0');
assert.deepStrictEqual(check(v2, signed(v2)), { version: '1.2.0', name: 'VideoCall-Setup.exe', size: entry.size, sha256: entry.sha256 });
assert.strictEqual(check(v2, signed(v2), '1.1.0', 'linux').name, 'VideoCall.AppImage');
assert.strictEqual(check(v2, signed(v2), '1.2.0'), null, 'Already up to date');
assert.strictEqual(check(manifestFor('1.2.0', { linux: entry }), signed(manifestFor('1.2.0', { linux: entry }))), null,
  'No package for this system');
console.log('✓ Test 2 Passed: Signed newer manifest accepted for the right system');

// 3. Anything not signed by the release key is refused: tampered, foreign key, garbage
const tampered = v2.replace(entry.sha256, 'a'.repeat(64));
assert.throws(() => check(tampered, signed(v2)), /not signed/);
const foreign = crypto.generateKeyPairSync('ed25519').privateKey;
assert.throws(() => check(v2, crypto.sign(null, Buffer.from(v2), foreign).toString('base64')), /not signed/);
assert.throws(() => check(v2, ''), /not signed/);
assert.throws(() => check(undefined, signed(v2)), /not signed/);
// A signed but malformed entry (e.g. a path in the file name) is refused too
const evil = manifestFor('1.2.0', { win32: { ...entry, name: '..\\..\\evil.exe' } });
assert.throws(() => check(evil, signed(evil)), /malformed/);
console.log('✓ Test 3 Passed: Unsigned, tampered or malformed manifests refused');

// 4. The download must match the manifest exactly
const update = check(v2, signed(v2));
updater.verifyPackage(pkg, update);
assert.throws(() => updater.verifyPackage(pkg.subarray(1), update), /incomplete/);
assert.throws(() => updater.verifyPackage(Buffer.from(pkg).fill(0x41, 0, 1), update), /does not match/);
console.log('✓ Test 4 Passed: Downloads verified by size and SHA-256');

// 4b. GitHub: the latest release's signed manifest is checked, its file found and downloaded with progress
function fakeGitHub(files, status = 200) {
  const base = 'https://github.example/download/';
  const release = {
    html_url: 'https://github.com/peaceforallOS/Talvora/releases/tag/v1.2.0',
    assets: Object.keys(files).map(name => ({ name, browser_download_url: base + name }))
  };
  return async url => {
    if (url.startsWith('https://api.github')) return new Response(status === 200 ? JSON.stringify(release) : '{}', { status });
    const name = url.slice(base.length);
    return name in files ? new Response(files[name]) : new Response('missing', { status: 404 });
  };
}
(async () => {
  const github = fakeGitHub({ 'manifest.json': v2, 'manifest.sig': signed(v2), 'VideoCall-Setup.exe': pkg });
  const found = await updater.checkForUpdate({ currentVersion: '1.1.0', platform: 'win32', fetchImpl: github, publicKey });
  assert.strictEqual(found.version, '1.2.0');
  assert.strictEqual(found.downloadUrl, 'https://github.example/download/VideoCall-Setup.exe');
  assert.ok(found.releaseUrl.endsWith('/v1.2.0'));
  const progress = [];
  const bytes = await updater.download(found, f => progress.push(f), github);
  updater.verifyPackage(bytes, found);
  assert.strictEqual(progress[progress.length - 1], 1, 'Progress must reach 100%');

  assert.strictEqual(await updater.checkForUpdate({ currentVersion: '1.2.0', platform: 'win32', fetchImpl: github, publicKey }), null, 'Up to date');
  assert.strictEqual(await updater.checkForUpdate({ currentVersion: '1.1.0', platform: 'win32', fetchImpl: fakeGitHub({}, 404), publicKey }), null,
    'No release published yet');
  const forged = fakeGitHub({ 'manifest.json': v2, 'manifest.sig': crypto.sign(null, Buffer.from(v2), foreign).toString('base64'), 'VideoCall-Setup.exe': pkg });
  await assert.rejects(updater.checkForUpdate({ currentVersion: '1.1.0', platform: 'win32', fetchImpl: forged, publicKey }), /not signed/);
  const bigger = fakeGitHub({ 'manifest.json': v2, 'manifest.sig': signed(v2), 'VideoCall-Setup.exe': Buffer.concat([pkg, pkg]) });
  await assert.rejects(updater.download(found, () => {}, bigger), /larger than announced/);
  assert.strictEqual(updater.RELEASES_REPO, 'peaceforallOS/Talvora');
  console.log('✓ Test 4b Passed: GitHub release checked, downloaded with progress, forgeries refused');
  runRest();
})().catch(err => {
  console.error('Update test failure:', err);
  process.exit(1);
});

function runRest() {
// 5. The release tool refuses a key that does not match the one built into the app
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videocall-updates-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
fs.writeFileSync(path.join(dir, 'VideoCall-Setup.exe'), pkg);
fs.writeFileSync(path.join(dir, 'wrong-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
const tool = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/sign-updates.js'), dir], {
  env: { ...process.env, VIDEOCALL_RELEASE_KEY: path.join(dir, 'wrong-key.pem') }, encoding: 'utf8'
});
assert.notStrictEqual(tool.status, 0, 'Signing with a mismatched key must fail');
assert.ok(/does not match/.test(tool.stderr), tool.stderr);
assert.ok(!fs.existsSync(path.join(dir, 'manifest.sig')), 'No signature written for a mismatched key');
console.log('✓ Test 5 Passed: Release tool refuses a mismatched key');

// 5b. Installers left in the temp folder by earlier updates are removed on the next start
fs.writeFileSync(path.join(dir, 'VideoCall-Setup-1.1.1.exe'), 'old installer');
fs.writeFileSync(path.join(dir, 'VideoCall-Setup-notes.txt'), 'not ours');
updater.removeOldDownloads(dir);
assert.ok(!fs.existsSync(path.join(dir, 'VideoCall-Setup-1.1.1.exe')), 'Old update installer kept');
assert.ok(fs.existsSync(path.join(dir, 'VideoCall-Setup-notes.txt')), 'Unrelated file removed');
console.log('✓ Test 5b Passed: Downloaded update installers cleaned up');

// 6. Linux: the AppImage the app runs from is replaced by the verified download, then started
if (process.platform === 'linux') {
  const appImage = path.join(dir, 'VideoCall.AppImage');
  fs.writeFileSync(appImage, 'old version', { mode: 0o755 });
  const marker = path.join(dir, 'started');
  const newApp = Buffer.from(`#!/bin/sh\ntouch "${marker}"\n`);
  const linuxUpdate = { version: '1.2.0', name: 'VideoCall.AppImage', size: newApp.length, sha256: crypto.createHash('sha256').update(newApp).digest('hex') };
  updater.launchUpdate(newApp, linuxUpdate, { platform: 'linux', appImage });
  assert.strictEqual(fs.readFileSync(appImage, 'utf8'), newApp.toString(), 'AppImage not replaced');
  assert.ok(fs.statSync(appImage).mode & 0o111, 'New AppImage is not executable');
  assert.ok(!fs.existsSync(`${appImage}.update`), 'Temporary file left behind');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  assert.ok(fs.existsSync(marker), 'New version was not started');
  assert.throws(() => updater.launchUpdate(newApp, linuxUpdate, { platform: 'linux', appImage: undefined }), /not started from an AppImage/);
  assert.throws(() => updater.launchUpdate(newApp, { ...linuxUpdate, sha256: 'b'.repeat(64) }, { platform: 'linux', appImage }), /does not match/);
  console.log('✓ Test 6 Passed: Linux AppImage replaced and restarted');
}

console.log('\n========================================');
console.log(' ALL UPDATE TESTS PASSED!               ');
console.log('========================================\n');
}
