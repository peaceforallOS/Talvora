/**
 * Release Tests — the server notices a newer, validly signed release on GitHub and tells the admin
 * once; forged or older releases are ignored; app, server and release tooling agree on key, version
 * and repository
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const releases = require('../src/releases');

const ROOT = path.join(__dirname, '../..');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const tarball = Buffer.from('pretend this is videocall-server.tar.gz');
const entry = { name: 'videocall-server.tar.gz', size: tarball.length, sha256: crypto.createHash('sha256').update(tarball).digest('hex') };
const manifestFor = version => JSON.stringify({ version, files: { server: entry } });
const sign = (text, key = privateKey) => crypto.sign(null, Buffer.from(text), key).toString('base64');

// GitHub's direct release downloads: /latest/download/<file> and /download/v<version>/<file>
// (never the API, which is rate limited); `files` are the latest release's, published as v9.0.0
const RELEASES = 'https://github.example/releases';
const requested = [];
function fakeGitHub(files, status = 200) {
  return async url => {
    requested.push(url);
    if (status !== 200) return new Response('', { status });
    const m = url.match(/^https:\/\/github\.example\/releases\/(?:latest\/download|download\/v9\.0\.0)\/([^/]+)$/);
    return m && m[1] in files ? new Response(files[m[1]]) : new Response('Not Found', { status: 404 });
  };
}

async function runReleaseTests() {
  console.log('--- Starting Release Tests ---');
  const check = (files, currentVersion = '1.2.0', status) =>
    releases.latestServerRelease({ currentVersion, publicKey, fetchImpl: fakeGitHub(files, status), releasesUrl: RELEASES });

  // 1. A newer signed server release is found; same/older versions and missing releases are not
  const v9 = manifestFor('9.0.0');
  const files = { 'manifest.json': v9, 'manifest.sig': sign(v9), 'videocall-server.tar.gz': tarball };
  const found = await check(files);
  assert.strictEqual(found.version, '9.0.0');
  assert.strictEqual(found.sha256, entry.sha256);
  assert.strictEqual(found.releaseUrl, `${RELEASES}/tag/v9.0.0`);
  assert.strictEqual(found.downloadUrl, `${RELEASES}/download/v9.0.0/videocall-server.tar.gz`, 'The package comes from the release the manifest names');
  assert.strictEqual(await check(files, '9.0.0'), null, 'Already up to date');
  assert.strictEqual(await check(files, '9.1.0'), null, 'Never offer an older version');
  assert.strictEqual(await check({}, '1.2.0'), null, 'Nothing published yet');
  await assert.rejects(check(files, '1.2.0', 403), /GitHub answered 403/);
  assert.ok(requested.every(url => !url.includes('api.github')), 'Release checks must not use the rate-limited GitHub API');
  console.log('✓ Test 1 Passed: Newer signed server release detected');

  // 2. Forged signatures are refused
  const foreign = crypto.generateKeyPairSync('ed25519').privateKey;
  await assert.rejects(check({ ...files, 'manifest.sig': sign(v9, foreign) }), /not signed/);
  await assert.rejects(check({ ...files, 'manifest.json': v9.replace('9.0.0', '9.9.9') }), /not signed/);
  console.log('✓ Test 2 Passed: Forged or altered releases refused');

  // 3. The admin is told once per new version; failures keep the last answer
  const logs = [];
  let answer = { version: '9.0.0', releaseUrl: 'https://example/r' };
  const watcher = new releases.ReleaseWatcher({ check: async () => { if (answer instanceof Error) throw answer; return answer; }, log: m => logs.push(m) });
  let state = await watcher.checkNow();
  assert.ok(state.available && state.latest === '9.0.0' && state.command === 'sudo videocall-server update');
  await watcher.checkNow();
  assert.strictEqual(logs.length, 1, 'The same version must be announced only once');
  assert.ok(logs[0].includes('sudo videocall-server update'));
  answer = new Error('offline');
  state = await watcher.checkNow();
  assert.ok(state.available && state.error === 'offline', 'Being offline must not hide a known update');
  answer = null;
  state = await watcher.checkNow();
  assert.ok(!state.available, 'Cleared once nothing newer is published');
  console.log('✓ Test 3 Passed: Admin notified once per version, offline handled');

  // 4. App, server and release tools agree
  const key = file => crypto.createPublicKey(fs.readFileSync(path.join(ROOT, file))).export({ type: 'spki', format: 'der' });
  assert.ok(key('client/release-key.pub.pem').equals(key('shared/release-key.pub.pem')), 'App and server must trust the same release key');
  const clientVersion = require(path.join(ROOT, 'client/package.json')).version;
  assert.strictEqual(releases.CURRENT_VERSION, clientVersion, 'Client and server versions must match (one release = one version)');
  for (const file of ['client/updater.js', 'scripts/publish-release.js']) {
    if (file !== 'scripts/publish-release.js') {
      assert.ok(!fs.readFileSync(path.join(ROOT, file), 'utf8').includes('api.github.com'), `${file} must not use the rate-limited GitHub API`);
    }
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(`'${releases.RELEASES_REPO}'`), `${file} must use ${releases.RELEASES_REPO}`);
  }
  console.log('✓ Test 4 Passed: App, server and release tools use the same key, version and repository');

  console.log('\n========================================');
  console.log(' ALL RELEASE TESTS PASSED!              ');
  console.log('========================================\n');
}

runReleaseTests().catch(err => {
  console.error('Release test failure:', err);
  process.exit(1);
});
