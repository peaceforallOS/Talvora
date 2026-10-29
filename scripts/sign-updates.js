#!/usr/bin/env node
/**
 * Signs a release. Apps and servers check the project's GitHub releases and install an update only
 * when its manifest carries a valid signature from the release key, so whoever controls a download
 * (or even the GitHub account) cannot push their own programs to users.
 *
 *   node scripts/sign-updates.js --generate-key
 *       creates the release key (private: ~/.videocall/release-key.pem, keep it safe and backed up;
 *       public: client/release-key.pub.pem + shared/release-key.pub.pem, built into app and server)
 *   node scripts/sign-updates.js <release-dir> [--version x.y.z]
 *       writes manifest.json + manifest.sig for VideoCall-Setup.exe / VideoCall.AppImage /
 *       videocall-server.tar.gz found in <release-dir>; the version defaults to client/package.json's
 *
 * VIDEOCALL_RELEASE_KEY overrides the private key's path.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_KEY_FILE = path.join(ROOT, 'client', 'release-key.pub.pem');
const SHARED_KEY_FILE = path.join(ROOT, 'shared', 'release-key.pub.pem'); // the server's copy
const PRIVATE_KEY_FILE = process.env.VIDEOCALL_RELEASE_KEY || path.join(os.homedir(), '.videocall', 'release-key.pem');
const PACKAGES = { win32: 'VideoCall-Setup.exe', linux: 'VideoCall.AppImage', server: 'videocall-server.tar.gz' };

function generateKey() {
  if (fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`A release key already exists at ${PRIVATE_KEY_FILE}; refusing to replace it.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(PRIVATE_KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(SHARED_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Release key created.\n  private (keep secret, back it up): ${PRIVATE_KEY_FILE}\n  public (built into app and server): ${PUBLIC_KEY_FILE}, ${SHARED_KEY_FILE}`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sign(dir, version) {
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`No release key at ${PRIVATE_KEY_FILE} (create one with --generate-key, or set VIDEOCALL_RELEASE_KEY).`);
    process.exit(1);
  }
  const files = {};
  for (const [platform, name] of Object.entries(PACKAGES)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) files[platform] = { name, size: fs.statSync(file).size, sha256: sha256(file) };
  }
  if (!Object.keys(files).length) {
    console.error(`No client packages (${Object.values(PACKAGES).join(', ')}) in ${dir}`);
    process.exit(1);
  }
  const manifest = JSON.stringify({ version, released: new Date().toISOString(), files }, null, 2);
  const key = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE));
  // Check against the keys built into app and server, so a mismatch is noticed now and not by users
  const signer = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  for (const file of [PUBLIC_KEY_FILE, SHARED_KEY_FILE]) {
    if (!crypto.createPublicKey(fs.readFileSync(file)).export({ type: 'spki', format: 'der' }).equals(signer)) {
      console.error(`The release key does not match ${file}; apps and servers would reject this release.`);
      process.exit(1);
    }
  }
  const serverVersion = require(path.join(ROOT, 'server', 'package.json')).version;
  if (files.server && serverVersion !== version) {
    console.error(`server/package.json says ${serverVersion}, the release is ${version}: give both the same version.`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), crypto.sign(null, Buffer.from(manifest), key).toString('base64'));
  console.log(`Signed update ${version}: ${Object.values(files).map(f => f.name).join(', ')}`);
}

const args = process.argv.slice(2);
if (args[0] === '--generate-key') {
  generateKey();
} else if (args[0]) {
  const at = args.indexOf('--version');
  const version = at >= 0 ? args[at + 1] : require(path.join(ROOT, 'client', 'package.json')).version;
  sign(path.resolve(args[0]), version);
} else {
  console.error('Usage: node scripts/sign-updates.js --generate-key | <updates-dir> [--version x.y.z]');
  process.exit(1);
}
