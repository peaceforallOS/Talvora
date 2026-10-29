# Talvora

Private, self-hosted video calls for Windows and Linux. You run the server; only people you invite can join.

- **Encrypted:** HTTPS/WSS for everything between app and server (Let's Encrypt or the server's own pinned CA), WebRTC (DTLS-SRTP) for audio and video
- **Personal invite links:** each link only works for the name it was made for; links can be revoked
- **In the call:** voice, video, screen sharing, public / direct / group chat, music everyone hears in sync
- **Management panel:** live permissions (audio, video, chat, music, invite), kick and remove, network and port diagnostics
- **Server calculator** (on the app's join screen): enter people, cameras, video quality, screen sharing, networks, music and hours per month; get the CPU, RAM, port speed and monthly traffic to rent, based on measured load tests
- **Updates:** apps and servers notice new [releases](https://github.com/peaceforallOS/Talvora/releases) by themselves; every release is signed and checked before it is installed

## Download

Get the files from the [latest release](https://github.com/peaceforallOS/Talvora/releases/latest):

| File | For |
|---|---|
| `VideoCall-Setup.exe` | Windows 10/11 (64-bit): installer, for one user (no admin rights) or all users |
| `VideoCall.AppImage` | Any 64-bit Linux: double-click to run; missing system libraries are installed on first start |
| `videocall-server.tar.gz` | The server (Linux) |

## Install the server

```bash
tar xzf videocall-server.tar.gz && cd videocall-server && sudo ./install-server.sh
```

The installer sets up Node.js if needed, HTTPS, the firewall, router port forwarding (UPnP) and a system service, then prints the management panel address and your admin join link. Update an installed server with:

```bash
sudo videocall-server update
```

The management panel shows when a new version is available.

## Develop

```bash
cd server && npm install && npm test
cd client && npm install && npm test && npm start
```

Without HTTPS the server only listens on this computer (`http://localhost:8080`), which is how development and the tests run. See [docs/architecture.md](docs/architecture.md) for the design, protocol, security model and release process.

## Releases

1. Give `client/package.json` and `server/package.json` the same new `version`.
2. Build the Windows installer on Windows: `cd client && npx electron-builder --win nsis --x64`, then copy it to `dist/windows/`.
3. On Linux or WSL: `scripts/package-deliverables.sh` builds the AppImage and the server package and signs all three into `dist/release/` with the release key.
4. `GITHUB_TOKEN=… node scripts/publish-release.js` publishes them as release `vX.Y.Z`.

The release key's private half never goes into the repository (`~/.videocall/release-key.pem`; keep a backup). Without it, no new release can be signed, and installed apps and servers would not accept one.
