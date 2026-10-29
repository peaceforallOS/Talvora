/**
 * Forgotten panel password: clears it and creates a new one-time setup link.
 * Usage: videocall-server reset-password   (or: npm run reset-password)
 * Takes effect immediately, even while the server keeps running: open panels are signed out.
 */

const os = require('os');
const path = require('path');
const AuthService = require('./auth');

function networkIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) return config.address;
    }
  }
  return 'localhost';
}

const auth = new AuthService();
auth.clearAdminPassword();
let baseUrl = process.env.PUBLIC_URL || `http://${networkIp()}:${process.env.PORT || 8080}`;
try {
  // The running server records its real address (https://domain or IP)
  baseUrl = require(path.join(path.dirname(auth.configPath), 'connection-info.json')).publicBaseUrl || baseUrl;
} catch (e) {
  // server not started yet
}
console.log('The management panel password was cleared. Open this link to choose a new one:');
console.log(`  ${auth.getAdminCredentials(baseUrl).panelUrl}`);
