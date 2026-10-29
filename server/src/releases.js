/**
 * Server updates from the project's GitHub releases.
 *
 *  - ReleaseWatcher: checks the latest release at start and every 6 hours; when a newer, validly
 *    signed server package is published, the management panel shows it and the log says so.
 *  - selfUpdate (`videocall-server update`): downloads that package, checks it against the signed
 *    manifest (release key: shared/release-key.pub.pem, see scripts/sign-updates.js), unpacks it and
 *    runs its install-server.sh, which keeps this server's settings, data and certificates.
 *
 * The server never updates itself unattended: it runs as an unprivileged user that cannot replace
 * its own program, and an administrator decides when the call service restarts.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RELEASES_REPO = 'peaceforallOS/Talvora';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HEADERS = { 'User-Agent': 'Talvora-server', Accept: 'application/vnd.github+json' };
const UPDATE_COMMAND = 'sudo videocall-server update';

const KEY_FILE = [path.join(__dirname, '../../shared/release-key.pub.pem'), path.join(__dirname, '../shared/release-key.pub.pem')]
  .find(file => fs.existsSync(file));
const PUBLIC_KEY = KEY_FILE ? crypto.createPublicKey(fs.readFileSync(KEY_FILE)) : null;
const CURRENT_VERSION = require('../package.json').version;

function isNewer(candidate, current) {
  const parse = v => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The server package of the latest release if it is newer and validly signed, else null.
 * @returns {Promise<{version, name, size, sha256, downloadUrl, releaseUrl} | null>}
 */
async function latestServerRelease({ currentVersion = CURRENT_VERSION, publicKey = PUBLIC_KEY, fetchImpl = fetch, url = LATEST_RELEASE_URL } = {}) {
  if (!publicKey) throw new Error('release key missing (shared/release-key.pub.pem)');
  const res = await fetchImpl(url, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const assets = Object.fromEntries((release.assets || []).map(a => [a.name, a.browser_download_url]));
  if (!assets['manifest.json'] || !assets['manifest.sig']) return null;
  const text = async asset => {
    const r = await fetchImpl(asset, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.text();
  };
  const [manifest, signature] = await Promise.all([text(assets['manifest.json']), text(assets['manifest.sig'])]);
  if (!crypto.verify(null, Buffer.from(manifest), publicKey, Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('the latest release is not signed by the release key');
  }
  const parsed = JSON.parse(manifest);
  const entry = parsed.files && parsed.files.server;
  if (!entry || !isNewer(parsed.version, currentVersion) || !assets[entry.name]) return null;
  if (!/^[\w.-]+$/.test(entry.name) || !Number.isInteger(entry.size) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error('the release manifest is malformed');
  }
  return { version: parsed.version, ...entry, downloadUrl: assets[entry.name], releaseUrl: release.html_url };
}

class ReleaseWatcher {
  constructor({ check = latestServerRelease, log = console.log, intervalMs = CHECK_INTERVAL_MS } = {}) {
    this.check = check;
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.announced = null;
    this.state = { current: CURRENT_VERSION, latest: null, available: false, releaseUrl: null, command: UPDATE_COMMAND, checkedAt: null, error: null };
  }

  async checkNow() {
    try {
      const release = await this.check();
      this.state = { ...this.state, latest: release ? release.version : null, available: !!release, releaseUrl: release ? release.releaseUrl : null, error: null };
      if (release && this.announced !== release.version) {
        this.announced = release.version;
        this.log(`UPDATE: Talvora server ${release.version} is available (running ${CURRENT_VERSION}). Install it with: ${UPDATE_COMMAND}  (${release.releaseUrl})`);
      }
    } catch (err) {
      this.state = { ...this.state, error: err.message }; // offline or GitHub unreachable: keep the last answer
    }
    this.state.checkedAt = new Date().toISOString();
    return this.state;
  }

  start() {
    this.stop();
    setTimeout(() => this.checkNow(), 10000).unref();
    this.timer = setInterval(() => this.checkNow(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * `videocall-server update`: download, verify, unpack and install the latest server release.
 * Returns the process exit code.
 */
async function selfUpdate({ installDir = path.join(__dirname, '..'), out = console.log } = {}) {
  let release;
  try {
    release = await latestServerRelease();
  } catch (err) {
    out(`Could not check for updates: ${err.message}`);
    return 1;
  }
  if (!release) {
    out(`Talvora server ${CURRENT_VERSION} is the latest version.`);
    return 0;
  }
  // A system install (/opt, owned by root) can only be replaced by root
  if (process.getuid && process.getuid() !== 0 && fs.statSync(installDir).uid === 0) {
    out(`Talvora server ${release.version} is available. Run: ${UPDATE_COMMAND}`);
    return 1;
  }
  out(`Downloading Talvora server ${release.version} (${Math.round(release.size / 1048576)} MB)...`);
  const res = await fetch(release.downloadUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok || bytes.length !== release.size || crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
    out('The download does not match the signed release; nothing was changed.');
    return 1;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'talvora-update-'));
  try {
    fs.writeFileSync(path.join(work, release.name), bytes);
    const unpack = spawnSync('tar', ['-xzf', release.name], { cwd: work, stdio: 'inherit' });
    const installer = path.join(work, 'videocall-server', 'install-server.sh');
    if (unpack.status !== 0 || !fs.existsSync(installer)) {
      out('The downloaded package could not be unpacked; nothing was changed.');
      return 1;
    }
    out(`Installing Talvora server ${release.version} (your settings, data and certificates are kept)...`);
    return spawnSync('bash', [installer], { cwd: path.dirname(installer), stdio: 'inherit' }).status ?? 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { RELEASES_REPO, CURRENT_VERSION, UPDATE_COMMAND, isNewer, latestServerRelease, ReleaseWatcher, selfUpdate };

if (require.main === module && process.argv[2] === 'update') {
  selfUpdate().then(code => process.exit(code));
}
