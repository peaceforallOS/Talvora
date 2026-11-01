/**
 * Server updates from the project's GitHub releases.
 *
 *  - ReleaseWatcher: checks the latest release at start, every hour and when the management panel
 *    is opened; when a newer, validly signed server package is published, the panel shows it and
 *    the log says so.
 *  - selfUpdate (`videocall-server update`, or the panel's Update button): downloads that package,
 *    checks it against the signed manifest (release key: shared/release-key.pub.pem, see
 *    scripts/sign-updates.js), unpacks it and runs its install-server.sh, which keeps this server's
 *    settings, data and certificates and restarts the server.
 *
 * The server never updates itself unattended: it runs as an unprivileged user that cannot replace
 * its own program. The panel's button only asks (data/update-request); a root service the installer
 * sets up (videocall-server-update.path) then runs the update, and only when an admin asked.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RELEASES_REPO = 'peaceforallOS/Talvora';
// Release files are downloaded directly, never through GitHub's API: that allows only 60 requests an
// hour per internet address, which servers sharing an address (a cloud provider) run out of
const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // plus whenever the management panel is opened
const HEADERS = { 'User-Agent': 'Talvora-server' };
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
async function latestServerRelease({ currentVersion = CURRENT_VERSION, publicKey = PUBLIC_KEY, fetchImpl = fetch, releasesUrl = RELEASES_URL } = {}) {
  if (!publicKey) throw new Error('release key missing (shared/release-key.pub.pem)');
  const text = async url => {
    const r = await fetchImpl(url, { headers: HEADERS });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.text();
  };
  const manifest = await text(`${releasesUrl}/latest/download/manifest.json`);
  if (manifest === null) return null; // nothing published yet
  let parsed;
  try {
    parsed = JSON.parse(manifest);
  } catch (e) {
    throw new Error('the release manifest is malformed');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(parsed.version))) throw new Error('the release manifest is malformed');
  // The signature and package come from the release the manifest names, so a release published meanwhile cannot mix in
  const tag = `${releasesUrl}/download/v${parsed.version}`;
  const signature = await text(`${tag}/manifest.sig`);
  if (signature === null || !crypto.verify(null, Buffer.from(manifest), publicKey, Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('the latest release is not signed by the release key');
  }
  const entry = parsed.files && parsed.files.server;
  if (!entry || !isNewer(parsed.version, currentVersion)) return null;
  if (!/^[\w.-]+$/.test(entry.name) || !Number.isInteger(entry.size) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error('the release manifest is malformed');
  }
  return { version: parsed.version, ...entry, downloadUrl: `${tag}/${entry.name}`, releaseUrl: `${releasesUrl}/tag/v${parsed.version}` };
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

  // One check at a time: the panel, the timer and the start-up check share it
  checkNow() {
    if (!this.pending) {
      this.pending = this.runCheck().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async runCheck() {
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

  // The panel was opened: look again unless the last check is recent (a release published since
  // shows up without waiting for the next hourly check)
  refreshIfOlderThan(maxAgeMs) {
    const last = this.state.checkedAt ? Date.parse(this.state.checkedAt) : 0;
    if (this.timer && Date.now() - last > maxAgeMs) this.checkNow();
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
 * How an update is going, for the management panel: data/update-status.json, { state: 'running' |
 * 'failed' | 'done', version, message, at }. Written by the server (request) and by the updater, which
 * may run as root: replaced through a new file, so either can write it whoever wrote it last.
 */
const UPDATE_STATUS_FILE = 'update-status.json';

function writeUpdateStatus(dataDir, status) {
  try {
    const file = path.join(dataDir, UPDATE_STATUS_FILE);
    fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify({ ...status, at: new Date().toISOString() }), { mode: 0o644 });
    fs.renameSync(`${file}.${process.pid}`, file);
  } catch (e) {
    // no data folder (development) or not writable: the panel just shows less detail
  }
}

function readUpdateStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, UPDATE_STATUS_FILE), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * `videocall-server update`: download, verify, unpack and install the latest server release, whose
 * installer also restarts the server. Returns the process exit code.
 */
async function selfUpdate({ installDir = path.join(__dirname, '..'), out = console.log } = {}) {
  const dataDir = path.join(installDir, 'data');
  const fail = (message, version) => {
    out(message);
    writeUpdateStatus(dataDir, { state: 'failed', version, message });
    return 1;
  };
  let release;
  try {
    release = await latestServerRelease();
  } catch (err) {
    return fail(`Could not check for updates: ${err.message}`);
  }
  if (!release) {
    out(`Talvora server ${CURRENT_VERSION} is the latest version.`);
    writeUpdateStatus(dataDir, { state: 'done', version: CURRENT_VERSION, message: `Talvora server ${CURRENT_VERSION} is the latest version.` });
    return 0;
  }
  // A system install (/opt, owned by root) can only be replaced by root
  if (process.getuid && process.getuid() !== 0 && fs.statSync(installDir).uid === 0) {
    out(`Talvora server ${release.version} is available. Run: ${UPDATE_COMMAND}`);
    return 1;
  }
  writeUpdateStatus(dataDir, { state: 'running', version: release.version, message: `Downloading Talvora server ${release.version}...` });
  out(`Downloading Talvora server ${release.version} (${Math.round(release.size / 1048576)} MB)...`);
  let res;
  let bytes;
  try {
    res = await fetch(release.downloadUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return fail(`The download failed (${err.message}); nothing was changed.`, release.version);
  }
  if (!res.ok || bytes.length !== release.size || crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
    return fail('The download does not match the signed release; nothing was changed.', release.version);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'talvora-update-'));
  try {
    fs.writeFileSync(path.join(work, release.name), bytes);
    const unpack = spawnSync('tar', ['-xzf', release.name], { cwd: work, stdio: 'inherit' });
    const installer = path.join(work, 'videocall-server', 'install-server.sh');
    if (unpack.status !== 0 || !fs.existsSync(installer)) {
      return fail('The downloaded package could not be unpacked; nothing was changed.', release.version);
    }
    writeUpdateStatus(dataDir, { state: 'running', version: release.version, message: `Installing Talvora server ${release.version}...` });
    out(`Installing Talvora server ${release.version} (your settings, data and certificates are kept)...`);
    const code = spawnSync('bash', [installer], { cwd: path.dirname(installer), stdio: 'inherit' }).status ?? 1;
    if (code !== 0) return fail(`Installing Talvora server ${release.version} failed (exit code ${code}).`, release.version);
    writeUpdateStatus(dataDir, { state: 'done', version: release.version, message: `Talvora server ${release.version} is installed.` });
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = {
  RELEASES_REPO, CURRENT_VERSION, UPDATE_COMMAND, isNewer, latestServerRelease, ReleaseWatcher, selfUpdate,
  writeUpdateStatus, readUpdateStatus
};

if (require.main === module && process.argv[2] === 'update') {
  selfUpdate().then(code => process.exit(code));
}
