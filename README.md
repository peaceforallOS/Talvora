# Talvora

Private, self-hosted video calls for Windows and Linux. You run the server; only people you invite can join.

- **Encrypted:** HTTPS/WSS for everything between app and server (Let's Encrypt or the server's own pinned CA), WebRTC (DTLS-SRTP) for audio and video
- **Personal invite links:** each link only works for the name it was made for; links can be revoked
- **In the call:** voice, video, screen sharing (viewable full screen) with the computer's sound, sharp and smooth with quality that adapts to each person's connection, the sound lowered automatically while someone speaks, public and direct chat with saved history (kept across restarts and updates; a Copy button on each message and a right-click menu), a volume control per person, and a microphone that follows a headset plugged in or out during the call. Everyone joins muted with the camera off; the camera is only opened while it is on. Invited people can use voice, video and screen sharing once the admin allows it for them in the management panel (the admin always can)
- **A stage:** invited people join the audience, which sees and hears the stage. The admin brings someone on stage with a checkmark in the People list, or by accepting their raised hand; on stage, the permissions the admin gave them apply
- **The admin opens the room:** invited people can only join while the admin is in the call. If the admin leaves, everyone else is removed after 10 seconds unless the admin comes back in time; the admin's app reconnects by itself after a dropped connection
- **Graphics card chosen automatically:** with a dedicated card (NVIDIA, AMD Radeon, Intel Arc) Talvora draws and decodes video on it; with only integrated graphics it draws without the GPU and stays light on memory: about 65 MB on the join screen and 120-250 MB in a call
- **Management panel:** live permissions (audio, video, screen sharing, chat, invite; invited people start without audio, video and screen sharing), separate lists for people on stage and in the audience, kick and remove, clearing the chat history, network and port diagnostics
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
- **Servers** show new versions in the management panel (checked every hour and whenever the panel is opened, or with **Check now**). Install one with the panel's **Update now** button, or on the server with:

```bash
sudo videocall-server update
```

Either way your settings, data and certificates are kept and the server restarts on the new version by itself, whether it runs as the system service or was started by hand with `videocall-server`; the command ends by confirming which version is running, and the panel reconnects and says so.

## For developers

Only needed if you want to change Talvora itself:

```bash
cd server && npm install && npm test
cd client && npm install && npm test && npm start
```

Without HTTPS the server only listens on this computer (`http://localhost:8080`), which is how development and the tests run. See [docs/architecture.md](docs/architecture.md) for the design, protocol and security model, and [docs/RELEASING.md](docs/RELEASING.md) for how new versions are built and published (for maintainers).
