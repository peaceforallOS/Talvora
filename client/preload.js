/**
 * Preload — the native capabilities the page gets: trusting a server's own HTTPS certificate
 * authority (fingerprint from its invite link), the local firewall check and updates (see main.js).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videocallNative', {
  trustServerCertificate: (origin, fingerprint) => ipcRenderer.invoke('trust-server-certificate', origin, fingerprint),
  // This computer's firewall: check it, and (after an administrator prompt) allow Talvora
  firewallStatus: () => ipcRenderer.invoke('firewall-status'),
  firewallAllow: origin => ipcRenderer.invoke('firewall-allow', origin),
  // Linux: keep other programs' sound out of the microphone during a call (see linuxEchoCancel.js)
  echoCancelStart: micLabel => ipcRenderer.invoke('echo-cancel-start', micLabel),
  echoCancelStop: () => ipcRenderer.invoke('echo-cancel-stop'),
  // Updates from GitHub releases: checked, downloaded and verified by the app itself (see updater.js)
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateProgress: callback => ipcRenderer.on('update-progress', (_event, fraction) => callback(fraction))
});
