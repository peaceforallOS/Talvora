/**
 * Electron Desktop Main Process
 * Cross-platform desktop runtime for Windows & Linux
 */

const { app, BrowserWindow, shell, session, desktopCapturer, ipcMain, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const { X509Certificate } = require('crypto');
const { integrateAppImage } = require('./linuxIntegration');
const firewall = require('./firewall');
const updater = require('./updater');
const net = require('net');

let mainWindow = null;

// Chromium's sandbox needs unprivileged user namespaces (blocked by AppArmor on Ubuntu 23.10+)
// or a root-owned setuid chrome-sandbox helper, which an AppImage can never provide.
// Without either, Electron refuses to start, so fall back to running without it.
function readSysctl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function linuxSandboxUnavailable() {
  try {
    const restricted =
      readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' || // Ubuntu 23.10+
      readSysctl('/proc/sys/kernel/unprivileged_userns_clone') === '0' || // Debian hardening
      readSysctl('/proc/sys/user/max_user_namespaces') === '0';
    if (!restricted) return false;
    if (process.env.APPIMAGE) return true;
    const helper = fs.statSync(path.join(path.dirname(process.execPath), 'chrome-sandbox'));
    return !(helper.uid === 0 && (helper.mode & 0o4000));
  } catch (e) {
    return false;
  }
}

if (process.platform === 'linux' && linuxSandboxUnavailable()) {
  app.commandLine.appendSwitch('no-sandbox');
}

// Expose real LAN addresses as ICE candidates instead of random .local mDNS names:
// Linux machines without avahi cannot resolve Windows' mDNS names (and vice versa),
// which leaves peers on the same network unable to connect.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// A join link may be passed on the command line, e.g. run-linux.sh "http://host:8080/join?..."
function findJoinLink(argv) {
  return argv.find(arg => /^(https?|videocall):\/\//i.test(arg) && arg.includes('token=')) || null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#07090f',
    title: 'VideoCall',
    icon: path.join(__dirname, 'src/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const indexPath = path.join(__dirname, 'src/index.html');
  const joinLink = findJoinLink(process.argv.slice(1));
  mainWindow.loadFile(indexPath, joinLink ? { query: { link: joinLink } } : undefined);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only hand web links to the OS; never open arbitrary protocols from page content
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The window only ever shows the bundled app: no navigating (or dropping links) to other pages,
  // which would otherwise get the preload bridge
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Servers using their own certificate authority (no domain / no public IP) ---
// Their invite links carry the CA's SHA-256 fingerprint ("ca=..."). A certificate the system does not
// trust is accepted only if it is currently valid, issued for that server's address, and signed by a
// CA with exactly that fingerprint.
const pinnedCas = new Map(); // "host:port" -> CA fingerprint (hex)

function isAppUrl(url) {
  try {
    return new URL(url).protocol === 'file:';
  } catch (e) {
    return false;
  }
}

function isLoopbackUrl(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// First pin for a server wins for the rest of the session: a later link cannot swap in another CA
ipcMain.handle('trust-server-certificate', (event, origin, fingerprint) => {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return 'denied';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || !/^[0-9a-f]{64}$/.test(fingerprint)) return 'invalid';
    const existing = pinnedCas.get(url.host);
    if (existing && existing !== fingerprint) return 'conflict';
    pinnedCas.set(url.host, fingerprint);
    return 'ok';
  } catch (e) {
    return 'invalid';
  }
});

// --- This computer's firewall (see firewall.js) ---
ipcMain.handle('firewall-status', event => {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return null;
  return firewall.status();
});

// The ports VideoCall uses to reach a server: its web port and the media relay (TURN) ports
ipcMain.handle('firewall-allow', (event, origin) => {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return false;
  try {
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol)) return false;
    const webPort = url.port || (url.protocol === 'https:' ? 443 : 80);
    return firewall.allow({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      ports: [{ protocol: 'tcp', port: webPort }, { protocol: 'udp', port: 3478 }, { protocol: 'udp', port: '49152-49452' }]
    });
  } catch (e) {
    return false;
  }
});

// --- Updates from the project's GitHub releases (see updater.js). Checked, downloaded and
// verified here; the page only shows the offer and the progress.
let offeredUpdate = null;

ipcMain.handle('update-check', async event => {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url) || !app.isPackaged) return null;
  try {
    offeredUpdate = await updater.checkForUpdate({ currentVersion: app.getVersion(), fetchImpl: electronNet.fetch });
  } catch (e) {
    offeredUpdate = null; // offline, GitHub unreachable, or not validly signed: check again later
  }
  return offeredUpdate && { version: offeredUpdate.version, size: offeredUpdate.size, releaseUrl: offeredUpdate.releaseUrl };
});

ipcMain.handle('update-install', async event => {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url) || !offeredUpdate) return { ok: false, error: 'No update is available.' };
  try {
    const bytes = await updater.download(offeredUpdate, fraction => event.sender.send('update-progress', fraction), electronNet.fetch);
    updater.launchUpdate(bytes, offeredUpdate);
    setTimeout(() => app.quit(), 300); // let the page show "restarting"
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function trustedByPinnedCa(url, certificate) {
  try {
    const { host, hostname } = new URL(url);
    const pin = pinnedCas.get(host);
    if (!pin || !certificate.issuerCert) return false;
    const leaf = new X509Certificate(certificate.data);
    const ca = new X509Certificate(certificate.issuerCert.data);
    const now = Date.now();
    const address = hostname.replace(/^\[|\]$/g, '');
    return ca.fingerprint256.replace(/:/g, '').toLowerCase() === pin &&
      ca.ca &&
      leaf.checkIssued(ca) &&
      leaf.verify(ca.publicKey) &&
      now >= Date.parse(leaf.validFrom) && now <= Date.parse(leaf.validTo) &&
      !!(net.isIP(address) ? leaf.checkIP(address) : leaf.checkHost(address));
  } catch (e) {
    return false;
  }
}

app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
  // Only "issuer not trusted" can be overridden; every other check (name, expiry, ...) still applies
  if (error === 'net::ERR_CERT_AUTHORITY_INVALID' && trustedByPinnedCa(url, certificate)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Groups the taskbar entry under the app's own name and icon on Windows
if (process.platform === 'win32') {
  app.setAppUserModelId('com.videocall.client');
}

app.whenReady().then(() => {
  // Linux AppImage: icon in the app menu, dock and file manager (never blocks starting the app)
  try {
    integrateAppImage(__dirname);
  } catch (e) {
    console.warn('Desktop integration skipped:', e.message);
  }

  // Nothing leaves this computer unencrypted: plain http:// and ws:// only reach a local server
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'ws://*/*'] }, (details, callback) => {
    callback({ cancel: !isLoopbackUrl(details.url) });
  });

  // Camera, microphone, screen and clipboard only for the bundled app itself
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl));
  });

  // Electron rejects getDisplayMedia() unless a handler is set; share the primary screen
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => callback(sources.length ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });

  createWindow();
  updater.removeOldDownloads();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// The PowerShell kept ready for the firewall's administrator prompt (see firewall.js)
app.on('will-quit', () => firewall.releaseElevation());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
