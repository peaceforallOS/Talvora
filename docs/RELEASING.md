# Publishing a new version (maintainers)

Users never need this: they download the files from the [releases page](https://github.com/peaceforallOS/Talvora/releases), and installed apps and servers update themselves. This is how those files are made.

1. Give `client/package.json` and `server/package.json` the same new `version` (apps and servers only install newer versions; the tests check both match).
2. On Windows, build the installer and put it in `dist/windows/`:
   ```bash
   cd client && node node_modules/electron-builder/cli.js --win nsis --x64
   ```
   Then copy `client/release/Talvora-Setup.exe` to `dist/windows/`. (The Windows installer must be built on Windows.)
3. On Linux or WSL, with `dist/windows/Talvora-Setup.exe` present and `VIDEOCALL_RELEASE_KEY` pointing at the private release key:
   ```bash
   scripts/package-deliverables.sh
   ```
   This builds the AppImage and the server package and signs all three into `dist/release/` (`manifest.json` + `manifest.sig`).
4. Publish them as release `vX.Y.Z`:
   ```bash
   node scripts/publish-release.js --notes-file notes.md
   ```
   It signs in with the GitHub login git uses (or `GITHUB_TOKEN`), uploads everything to a draft, and publishes it only when all files are there.

## The release key

Every release is signed with an Ed25519 release key. Its private half lives only on the release machine (`~/.videocall/release-key.pem`, or the path in `VIDEOCALL_RELEASE_KEY`) and must never be committed; keep a private backup. The public half is in `client/release-key.pub.pem` and `shared/release-key.pub.pem`. Without the private key no new release can be signed, and installed apps and servers would not accept one.
