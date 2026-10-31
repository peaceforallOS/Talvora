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
const ASSETS = ['Talvora-Setup.exe', 'Talvora.AppImage', 'videocall-server.tar.gz', 'manifest.json', 'manifest.sig'];

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

// Uploads one file, trying again after a dropped connection; returns null, or why it failed
async function uploadAsset(release, name, file) {
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`;
  let problem = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const up = await github(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
      if (up.res.ok) return null;
      problem = `GitHub answered ${up.res.status}`;
      if (up.res.status !== 422 && up.res.status < 500) return problem;
    } catch (err) {
      problem = err.message;
    }
    // An interrupted upload can leave a broken file of that name behind: remove it before trying again
    const assets = await github(`${API}/releases/${release.id}/assets?per_page=100`).catch(() => null);
    const broken = assets?.res.ok && assets.body.find(a => a.name === name);
    if (broken) await github(`${API}/releases/assets/${broken.id}`, { method: 'DELETE' }).catch(() => {});
    if (attempt < 3) process.stdout.write(`retrying... `);
  }
  return problem;
}

async function main() {
  if (!token) fail('No GitHub login found: sign in with `git push` once, or set GITHUB_TOKEN (see the top of this file).');
  for (const name of ASSETS) {
    if (!fs.existsSync(path.join(dir, name))) fail(`Missing ${name} in ${dir}: run scripts/package-deliverables.sh first.`);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tag = `v${version}`;
  const notesFile = option('--notes-file');
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8') : `Talvora ${version}\n\n- Windows: Talvora-Setup.exe\n- Linux: Talvora.AppImage\n- Server: videocall-server.tar.gz (or \`sudo videocall-server update\` on an installed server)\n\nInstalled apps offer this update by themselves.`;

  const existing = await github(`${API}/releases/tags/${tag}`);
  if (existing.res.ok) fail(`Release ${tag} already exists: ${existing.body.html_url}. Raise the version for a new release.`);
  if (existing.res.status === 401 || existing.res.status === 403) fail('GitHub refused the login (it must be allowed to write to the repository).');

  // A draft of this version left by an interrupted run (never visible to users) is replaced
  const listed = await github(`${API}/releases?per_page=30`);
  for (const old of (listed.res.ok && Array.isArray(listed.body) ? listed.body : [])) {
    if (old.draft && old.tag_name === tag) await github(`${API}/releases/${old.id}`, { method: 'DELETE' });
  }

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
    const problem = await uploadAsset(release, name, file);
    if (problem) {
      console.log('failed');
      await github(`${API}/releases/${release.id}`, { method: 'DELETE' }).catch(() => {});
      fail(`Upload of ${name} failed (${problem}); the draft release was removed. Nothing was published.`);
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
