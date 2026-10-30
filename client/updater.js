/**
 * Updates — new versions are published as GitHub releases of the Talvora repository, each with a
 * manifest.json signed by the release key (see scripts/sign-updates.js). An update is installed only
 * if that signature matches the key built into this app (release-key.pub.pem), the version is newer,
 * and the downloaded file matches the manifest's size and SHA-256. Whoever controls the download
 * (GitHub, a proxy, even the GitHub account) can therefore not slip in other programs.
 *
 *  - Windows: runs the downloaded Talvora-Setup.exe silently as an update (same folder, same
 *    "only me / all users" choice, shortcuts kept), which then starts the new version.
 *  - Linux:   replaces the AppImage file the app was started from, then starts it again.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PUBLIC_KEY = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, 'release-key.pub.pem')));
const RELEASES_REPO = 'peaceforallOS/Talvora';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const HEADERS = { 'User-Agent': 'Talvora-updater', Accept: 'application/vnd.github+json' };

// "1.10.2" > "1.9.0"; anything that is not x.y.z is never newer
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
 * The update this app should install, or null. Throws when the manifest is not validly signed.
 * @returns {{version: string, name: string, size: number, sha256: string} | null}
 */
function verifyManifest(manifestText, signature, { currentVersion, platform = process.platform, publicKey = PUBLIC_KEY }) {
  const valid = typeof manifestText === 'string' && typeof signature === 'string' &&
    crypto.verify(null, Buffer.from(manifestText), publicKey, Buffer.from(signature, 'base64'));
  if (!valid) throw new Error('The update is not signed by the Talvora release key.');
  const manifest = JSON.parse(manifestText);
  const entry = manifest.files && manifest.files[platform];
  if (!entry || !isNewer(manifest.version, currentVersion)) return null;
  if (!/^[\w.-]+$/.test(entry.name) || !Number.isInteger(entry.size) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error('The update manifest is malformed.');
  }
  return { version: manifest.version, name: entry.name, size: entry.size, sha256: entry.sha256 };
}

/**
 * The latest GitHub release's signed manifest and the download address of each of its files,
 * or null when nothing is published yet.
 */
async function fetchLatestRelease(fetchImpl = fetch, url = LATEST_RELEASE_URL) {
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
  return { manifest, signature: signature.trim(), assets, releaseUrl: release.html_url };
}

/**
 * The update for this system from the latest release, or null. Throws when the release is not
 * validly signed (or GitHub cannot be reached).
 */
async function checkForUpdate({ currentVersion, platform = process.platform, fetchImpl = fetch, publicKey = PUBLIC_KEY, url = LATEST_RELEASE_URL }) {
  const release = await fetchLatestRelease(fetchImpl, url);
  if (!release) return null;
  const update = verifyManifest(release.manifest, release.signature, { currentVersion, platform, publicKey });
  if (!update || !release.assets[update.name]) return null;
  return { ...update, downloadUrl: release.assets[update.name], releaseUrl: release.releaseUrl };
}

// Downloads an update, reporting progress (0..1); never more than the manifest's size
async function download(update, onProgress = () => {}, fetchImpl = fetch) {
  const res = await fetchImpl(update.downloadUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok) throw new Error(`the download failed (${res.status})`);
  const bytes = Buffer.alloc(update.size);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > update.size) throw new Error('the download is larger than announced');
    bytes.set(value, received);
    received += value.length;
    onProgress(received / update.size);
  }
  if (received !== update.size) throw new Error('the download was interrupted');
  return bytes;
}

function verifyPackage(bytes, update) {
  if (bytes.length !== update.size) throw new Error('The downloaded update is incomplete.');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== update.sha256) throw new Error('The downloaded update does not match its signature.');
}

// Starts a program that outlives this app; a start failure must not take the app down with it
function start(file, args) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  child.on('error', err => console.error(`Could not start ${file}: ${err.message}`));
  child.unref();
}

/**
 * Installs a verified package and starts the new version; the caller quits the app afterwards.
 * `appImage` is the running AppImage's path on Linux (APPIMAGE).
 */
function launchUpdate(bytes, update, { platform = process.platform, appImage = process.env.APPIMAGE, tempDir = os.tmpdir() } = {}) {
  verifyPackage(bytes, update);
  if (platform === 'win32') {
    const installer = path.join(tempDir, `Talvora-Setup-${update.version}.exe`);
    fs.writeFileSync(installer, bytes);
    // --updated: same folder and install mode, shortcuts as the user left them; --force-run: start afterwards
    start(installer, ['/S', '--updated', '--force-run']);
    return installer;
  }
  if (platform === 'linux') {
    if (!appImage) throw new Error('This copy of Talvora was not started from an AppImage, so it cannot update itself.');
    const next = `${appImage}.update`;
    try {
      fs.writeFileSync(next, bytes, { mode: 0o755 });
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, appImage); // the running copy keeps working until it quits
    } catch (err) {
      fs.rmSync(next, { force: true });
      throw new Error(`Talvora cannot replace ${appImage} (${err.code || err.message}). Download the new version from https://github.com/${RELEASES_REPO}/releases instead.`);
    }
    start(appImage, []);
    return appImage;
  }
  throw new Error('Updates are not supported on this system.');
}

// Installers downloaded for earlier updates (the update has finished once the new version runs)
function removeOldDownloads(tempDir = os.tmpdir()) {
  try {
    for (const name of fs.readdirSync(tempDir)) {
      if (/^(Talvora|VideoCall)-Setup-\d+\.\d+\.\d+\.exe$/.test(name)) fs.rmSync(path.join(tempDir, name), { force: true });
    }
  } catch (e) {
    // nothing to clean, or still in use: tried again next start
  }
}

module.exports = {
  RELEASES_REPO, isNewer, verifyManifest, fetchLatestRelease, checkForUpdate, download, verifyPackage, launchUpdate, removeOldDownloads
};
