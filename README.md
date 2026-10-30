# Talvora

Private, self-hosted video calls for Windows and Linux. You run the server; only people you invite can join.

- **Encrypted:** HTTPS/WSS for everything between app and server (Let's Encrypt or the server's own pinned CA), WebRTC (DTLS-SRTP) for audio and video
- **Personal invite links:** each link only works for the name it was made for; links can be revoked
- **In the call:** voice, video, screen sharing (viewable full screen), public / direct / group chat, a volume control per person, and music everyone hears in sync, with pause, resume and seek for the DJ
- **Management panel:** live permissions (audio, video, chat, music, invite), kick and remove, network and port diagnostics
- **Server calculator** (on the app's join screen): enter how many people join a call and see the CPU, RAM, port speed and traffic to rent, based on measured load tests
- **Updates:** apps and servers notice new releases by themselves; every release is signed and checked before it is installed

## Download and install

**Nothing needs to be built.** Download the ready-made files from the **[latest release](https://github.com/peaceforallOS/Talvora/releases/latest)** (under "Assets"):

| File | For | How |
|---|---|---|
| `Talvora-Setup.exe` | Windows 10/11 (64-bit) | Double-click and follow the steps: only for you (no admin password) or all users, folder, shortcuts |
| `Talvora.AppImage` | Any 64-bit Linux | Make it executable (right-click → Properties → Permissions, or `chmod +x Talvora.AppImage`) and double-click. Missing system libraries are installed on first start, after asking |
| `videocall-server.tar.gz` | The server (Linux) | See below |

Windows may say "Windows protected your PC" because the app is not code-signed: click **More info → Run anyway**.

### The server

On the Linux computer that will host your calls:

```bash
tar xzf videocall-server.tar.gz && cd videocall-server && sudo ./install-server.sh
```

The installer sets up Node.js if needed, HTTPS, the firewall, router port forwarding (UPnP) and a system service, then prints the management panel address and your admin join link.

### Updates

- **Apps** check for new versions by themselves and show an **Install** button; one click updates and restarts them.
- **Servers** show new versions in the management panel. Install one with:

```bash
sudo videocall-server update
```

## For developers

Only needed if you want to change Talvora itself:

```bash
cd server && npm install && npm test
cd client && npm install && npm test && npm start
```

Without HTTPS the server only listens on this computer (`http://localhost:8080`), which is how development and the tests run. See [docs/architecture.md](docs/architecture.md) for the design, protocol and security model, and [docs/RELEASING.md](docs/RELEASING.md) for how new versions are built and published (for maintainers).
