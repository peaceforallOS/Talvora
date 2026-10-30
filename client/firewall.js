/**
 * Local Firewall — finds out whether this computer's firewall blocks Talvora, and (with the
 * user's permission, via the system's administrator prompt) allows it.
 *
 *  - Windows: Windows Firewall rules for this program (incoming: direct, faster calls; outgoing:
 *    in case outgoing traffic is restricted). Added through a UAC prompt.
 *  - Linux: ufw configured to block outgoing traffic is the case that stops calls; a rule for
 *    exactly the server's address and ports is added through a pkexec password prompt.
 * Other systems allow the connections Talvora makes by default.
 */

const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const { execFile, spawn } = require('child_process');

const RULE_NAME = 'Talvora';
const OLD_RULE_NAME = 'VideoCall'; // the app's earlier name; its rule points at an executable that no longer exists
const HELPER_IDLE_MS = 2 * 60 * 1000;

function run(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 120000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// --- Windows ---

async function windowsStatus(exe) {
  const state = await run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']);
  if (state.code === 0 && !/\bON\b/i.test(state.stdout)) return { firewall: 'Windows Firewall', blocking: false };
  const rules = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`, 'verbose']);
  const allowed = rules.code === 0 && rules.stdout.toLowerCase().includes(exe.toLowerCase());
  return { firewall: 'Windows Firewall', blocking: !allowed, canFix: true };
}

// One elevated command (one UAC prompt) replaces any old rule and allows this program both ways
function windowsAllowCommand(exe) {
  const program = exe.replace(/"/g, '');
  const netsh = args => `netsh advfirewall firewall ${args}`;
  return [
    netsh(`delete rule name="${OLD_RULE_NAME}"`),
    netsh(`delete rule name="${RULE_NAME}"`),
    netsh(`add rule name="${RULE_NAME}" dir=in action=allow program="${program}" enable=yes profile=any`),
    netsh(`add rule name="${RULE_NAME}" dir=out action=allow program="${program}" enable=yes profile=any`)
  ].join(' & ');
}

// The administrator prompt is opened through PowerShell, which takes 1-3 s just to start. So one is
// started in advance (idle, not elevated) as soon as the firewall turns out to block Talvora; when
// the user clicks "Allow" the prompt then appears at once. Unused helpers are closed after a while.
let helper = null;

function startPowerShell() {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.exited = new Promise(resolve => {
    child.on('exit', code => resolve(typeof code === 'number' ? code : 1));
    child.on('error', () => resolve(1));
  });
  // PowerShell runs each line as it arrives: this one answers once it has finished starting
  child.ready = new Promise(resolve => {
    child.stdout.once('data', () => resolve(true));
    child.exited.then(() => resolve(false));
  });
  child.stdout.resume();
  child.stdin.on('error', () => { /* exited early; reported through `exited` */ });
  child.stdin.write("[Console]::Out.WriteLine('ready')\n");
  return child;
}

// Resolves once the helper is ready to open the prompt
function prepareElevation() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (!helper || helper.exitCode !== null) {
    const child = startPowerShell();
    child.exited.then(() => { if (helper === child) helper = null; });
    helper = child;
  }
  clearTimeout(helper.idleTimer);
  helper.idleTimer = setTimeout(() => releaseElevation(), HELPER_IDLE_MS);
  helper.idleTimer.unref?.();
  return helper.ready;
}

function releaseElevation() {
  if (!helper) return;
  clearTimeout(helper.idleTimer);
  helper.kill();
  helper = null;
}

// Runs a PowerShell script on the prepared helper (or a new one); resolves with its exit code
function runPowerShell(script) {
  const ps = helper && helper.exitCode === null ? helper : startPowerShell();
  if (ps === helper) {
    clearTimeout(helper.idleTimer);
    helper = null;
  }
  ps.stdin.end(`${script}\n`);
  return ps.exited;
}

async function windowsAllow(exe) {
  const command = windowsAllowCommand(exe).replace(/'/g, "''"); // inside a PowerShell single-quoted string
  // Start-Process throws when the user declines the administrator prompt
  const code = await runPowerShell(
    `try { Start-Process -FilePath cmd.exe -ArgumentList '/c ${command}' -Verb RunAs -Wait -WindowStyle Hidden; exit 0 } catch { exit 1 }`);
  return code === 0;
}

// --- Linux (ufw) ---

function readConfig(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function linuxStatus(read = readConfig) {
  const enabled = /^\s*ENABLED\s*=\s*yes/im.test(read('/etc/ufw/ufw.conf'));
  const outgoing = /^\s*DEFAULT_OUTPUT_POLICY\s*=\s*"?(\w+)/im.exec(read('/etc/default/ufw'));
  const blocksOutgoing = enabled && !!outgoing && outgoing[1].toUpperCase() !== 'ACCEPT';
  return { firewall: enabled ? 'ufw' : null, blocking: blocksOutgoing, canFix: blocksOutgoing };
}

async function linuxAllow(host, ports) {
  const address = net.isIP(host) ? host : (await dns.lookup(host)).address;
  // Only an IP address, port numbers and fixed words ever reach the shell
  const valid = net.isIP(address) &&
    ports.every(({ protocol, port }) => /^(tcp|udp)$/i.test(protocol) && /^\d{1,5}(-\d{1,5})?$/.test(String(port)));
  if (!valid) return false;
  const rules = ports.map(({ protocol, port }) =>
    `ufw allow out to ${address} port ${String(port).replace('-', ':')} proto ${protocol.toLowerCase()}`);
  // One password prompt for all rules
  const result = await run('pkexec', ['sh', '-c', rules.join(' && ')]);
  return result.code === 0;
}

// --- public API ---

/**
 * @returns {Promise<{firewall: string|null, blocking: boolean, canFix?: boolean}>}
 */
async function status() {
  if (process.platform === 'win32') {
    const result = await windowsStatus(process.execPath);
    // The app is about to offer "Allow": have the administrator prompt ready
    if (result.blocking) prepareElevation();
    return result;
  }
  if (process.platform === 'linux') return linuxStatus();
  return { firewall: null, blocking: false };
}

/**
 * Ask the system for permission and allow Talvora. Resolves true when allowed.
 * @param {{host: string, ports: {protocol: string, port: number|string}[]}} server
 */
async function allow(server) {
  if (process.platform === 'win32') return windowsAllow(process.execPath);
  if (process.platform === 'linux') return linuxAllow(server.host, server.ports);
  return false;
}

module.exports = { status, allow, windowsAllowCommand, linuxStatus, prepareElevation, releaseElevation, runPowerShell };
