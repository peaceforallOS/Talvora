/**
 * Graphics card detection (main process, before the app is ready). Talvora draws with the GPU only
 * when the computer has a dedicated one (NVIDIA, AMD Radeon RX/Pro, Intel Arc A/B) and then runs on
 * that card; with only integrated graphics it draws without the GPU, which saves 100-150 MB of memory.
 *
 *  - Windows: the display adapters' name, PCI vendor and memory from the registry (about 0.1 s).
 *  - Linux:   /sys/class/drm (vendor, kernel driver, video memory, which card drives the screen).
 *
 * VIDEOCALL_GPU=on | off overrides the detection (support and testing).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIB = 1024 * 1024 * 1024;
const VENDORS = { '10de': 'nvidia', '1002': 'amd', '8086': 'intel' };
const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

/**
 * Is this adapter a dedicated card? AMD's integrated graphics (Ryzen) are called "... Graphics"
 * ("AMD Radeon(TM) Graphics", "Radeon 780M Graphics"); its cards are "Radeon RX ...", "Radeon Pro ...".
 * Intel's cards are "Arc A770" / "Arc B580" (its integrated "Arc Graphics" is not one).
 */
function isDedicated({ vendor, name = '', memoryBytes = 0 }) {
  if (vendor === 'nvidia') return true;
  if (vendor === 'amd') {
    if (/\bRX\b|\bPro\b|FirePro|Radeon VII/i.test(name)) return true;
    if (name) return !/Graphics\s*$/i.test(name) || memoryBytes >= 4 * GIB;
    return memoryBytes >= 3 * GIB; // no name (Linux): an integrated GPU reserves less video memory
  }
  if (vendor === 'intel') return /\bArc(?:\(TM\))?\s+[AB]\d{3}/i.test(name);
  return false;
}

// --- Windows ---

function regQuery(value, run) {
  const r = run('reg', ['query', DISPLAY_CLASS_KEY, '/s', '/v', value], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  return r && r.status === 0 ? r.stdout : '';
}

// "HKEY...\0000" lines start a block; "    Name    REG_TYPE    data" lines belong to it
function parseRegValues(output) {
  const values = new Map(); // adapter subkey -> data
  let key = null;
  for (const line of String(output).split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      key = line.trim();
      continue;
    }
    const m = line.match(/^\s+\S+\s+(REG_\w+)\s+(.*)$/);
    if (key && m) values.set(key, { type: m[1], data: m[2].trim() });
  }
  return values;
}

function windowsAdapters(run = spawnSync) {
  const names = parseRegValues(regQuery('DriverDesc', run));
  const ids = parseRegValues(regQuery('MatchingDeviceId', run));
  const adapters = [];
  for (const [key, id] of ids) {
    const vendorId = (id.data.match(/VEN_([0-9a-f]{4})/i) || [])[1];
    if (!vendorId) continue; // not a PCI adapter (e.g. the basic display driver)
    adapters.push({ key, vendor: VENDORS[vendorId.toLowerCase()] || vendorId.toLowerCase(), name: names.get(key)?.data || '', memoryBytes: 0 });
  }
  // Video memory only decides for AMD adapters named like integrated graphics
  if (adapters.some(a => a.vendor === 'amd')) {
    const memory = parseRegValues(regQuery('HardwareInformation.qwMemorySize', run));
    for (const a of adapters) {
      const m = memory.get(a.key);
      if (m && /^0x[0-9a-f]+$/i.test(m.data)) a.memoryBytes = Number(BigInt(m.data));
    }
  }
  return adapters.map(({ key, ...rest }) => rest);
}

// --- Linux ---

function linuxAdapters(root = '/sys/class/drm', fsImpl = fs) {
  const read = file => {
    try {
      return fsImpl.readFileSync(file, 'utf8').trim();
    } catch (e) {
      return '';
    }
  };
  let cards = [];
  try {
    cards = fsImpl.readdirSync(root).filter(name => /^card\d+$/.test(name));
  } catch (e) {
    return [];
  }
  return cards.map(card => {
    const device = path.join(root, card, 'device');
    let driver = '';
    try {
      driver = path.basename(fsImpl.readlinkSync(path.join(device, 'driver')));
    } catch (e) {
      // no driver bound
    }
    const vendorId = read(path.join(device, 'vendor')).replace(/^0x/i, '').toLowerCase();
    return {
      vendor: VENDORS[vendorId] || vendorId,
      driver,
      memoryBytes: Number(read(path.join(device, 'mem_info_vram_total'))) || 0,
      drivesScreen: read(path.join(device, 'boot_vga')) === '1'
    };
  }).filter(a => a.vendor);
}

/**
 * Environment that sends rendering to the dedicated card on a Linux laptop with two GPUs (PRIME
 * render offload); nothing when that card already drives the screen. Applied to the main process
 * before the app is ready, so the GPU process inherits it.
 */
function linuxOffloadEnv(adapters, dedicated) {
  if (!dedicated || dedicated.drivesScreen || !adapters.some(a => a !== dedicated && a.drivesScreen)) return {};
  if (dedicated.driver === 'nvidia') {
    return { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' };
  }
  return { DRI_PRIME: '1' }; // Mesa drivers (amdgpu, nouveau)
}

/**
 * { useGpu, adapter, env }: whether to draw with the GPU, the dedicated adapter found (or null),
 * and environment variables to set before the app is ready.
 */
function detectGpu({ platform = process.platform, env = process.env, run = spawnSync, sysRoot, fsImpl } = {}) {
  const override = String(env.VIDEOCALL_GPU || '').toLowerCase();
  let adapters = [];
  try {
    if (platform === 'win32') adapters = windowsAdapters(run);
    else if (platform === 'linux') adapters = linuxAdapters(sysRoot, fsImpl);
  } catch (e) {
    adapters = [];
  }
  const adapter = adapters.find(isDedicated) || null;
  const useGpu = override === 'on' ? true : override === 'off' ? false : !!adapter;
  const extraEnv = useGpu && platform === 'linux' ? linuxOffloadEnv(adapters, adapter) : {};
  return { useGpu, adapter, adapters, env: Object.fromEntries(Object.entries(extraEnv).filter(([k]) => env[k] === undefined)) };
}

module.exports = { detectGpu, isDedicated, parseRegValues, windowsAdapters, linuxAdapters, linuxOffloadEnv };
