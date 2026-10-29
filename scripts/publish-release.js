#!/usr/bin/env node
/**
 * Publishes dist/release (made by package-deliverables.sh: both clients, the server package and the
 * signed manifest) as a GitHub release of the Talvora repository. Installed apps and servers check
 * the latest release and offer it as an update.
 *
 *   node scripts/publish-release.js [--notes-file notes.md] [--dir dist/release]
 *
 * Signs in to GitHub with GITHUB_TOKEN if set (needs "Contents: read and write" on the repository),
 * otherwise with the GitHub login git already uses for pushing (`git credential fill`, e.g. Git
 * Credential Manager). The token stays inside this process: never printed or written anywhere.
 * Push the release's commit first: the release tag is created on the repository's default branch.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = 'peaceforallOS/Talvora';
const API = `https://api.github.com/repos/${REPO}`;
const ASSETS = ['VideoCall-Setup.exe', 'VideoCall.AppImage', 'videocall-server.tar.gz', 'manifest.json', 'manifest.sig'];

const args = process.argv.slice(2);
const option = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
const dir = path.resolve(option('--dir') || path.join(__dirname, '..', 'dist', 'release'));

// The login git uses for github.com (may open the browser sign-in once)
function gitCredentialToken() {
  const result = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  const line = result.status === 0 && result.stdout.split('\n').find(l => l.startsWith('password='));
  return line ? line.slice('password='.length).trim() : null;
}

const token = process.env.GITHUB_TOKEN || gitCredentialToken();

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function github(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Talvora-release', ...init.headers }
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, body };
}

async function main() {
  if (!token) fail('No GitHub login found: sign in with `git push` once, or set GITHUB_TOKEN (see the top of this file).');
  for (const name of ASSETS) {
    if (!fs.existsSync(path.join(dir, name))) fail(`Missing ${name} in ${dir}: run scripts/package-deliverables.sh first.`);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tag = `v${version}`;
  const notesFile = option('--notes-file');
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8') : `Talvora ${version}\n\n- Windows: VideoCall-Setup.exe\n- Linux: VideoCall.AppImage\n- Server: videocall-server.tar.gz (or \`sudo videocall-server update\` on an installed server)\n\nInstalled apps offer this update by themselves.`;

  const existing = await github(`${API}/releases/tags/${tag}`);
  if (existing.res.ok) fail(`Release ${tag} already exists: ${existing.body.html_url}. Raise the version for a new release.`);
  if (existing.res.status === 401 || existing.res.status === 403) fail('GitHub refused the login (it must be allowed to write to the repository).');

  const created = await github(`${API}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Talvora ${version}`, body: notes, draft: true })
  });
  if (!created.res.ok) fail(`Could not create the release: ${created.res.status} ${JSON.stringify(created.body)}`);
  const release = created.body;

  // Uploaded as a draft and published only when every file is there, so nobody sees half a release
  for (const name of ASSETS) {
    const file = path.join(dir, name);
    process.stdout.write(`Uploading ${name} (${Math.ceil(fs.statSync(file).size / 1048576)} MB)... `);
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`;
    const up = await github(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
    if (!up.res.ok) {
      console.log('failed');
      await github(`${API}/releases/${release.id}`, { method: 'DELETE' });
      fail(`Upload of ${name} failed (${up.res.status}); the draft release was removed. Nothing was published.`);
    }
    console.log('done');
  }
  const published = await github(`${API}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false, make_latest: 'true' })
  });
  if (!published.res.ok) fail(`The files are uploaded, but publishing failed (${published.res.status}); publish the draft on GitHub.`);
  console.log(`\nPublished ${tag}: ${published.body.html_url}`);
  console.log('Apps offer it within 6 hours (or at their next start); servers show it in the management panel.');
}

main().catch(err => fail(`Publishing failed: ${err.message}`));
