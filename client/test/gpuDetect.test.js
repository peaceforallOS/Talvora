/**
 * GPU Detection Tests — a dedicated card (NVIDIA, AMD Radeon RX/Pro, Intel Arc A/B) turns drawing
 * on the GPU on, and on Linux laptops sends it to that card; integrated graphics alone keep it off.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectGpu, isDedicated } = require('../gpuDetect');

console.log('--- Starting GPU Detection Tests ---');

// Windows: what `reg query <display class> /s /v <value>` prints for the given adapters
const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
function fakeReg(adapters) {
  return (cmd, args) => {
    const value = args[args.indexOf('/v') + 1];
    const lines = [''];
    adapters.forEach((a, i) => {
      const sub = `${KEY}\\000${i}`;
      const data = { DriverDesc: ['REG_SZ', a.name], MatchingDeviceId: ['REG_SZ', a.id], 'HardwareInformation.qwMemorySize': a.memory ? ['REG_QWORD', a.memory] : null }[value];
      if (data) lines.push(sub, `    ${value}    ${data[0]}    ${data[1]}`, '');
    });
    lines.push('End of search: 1 match(es) found.');
    return { status: 0, stdout: lines.join('\r\n') };
  };
}
const win = adapters => detectGpu({ platform: 'win32', env: {}, run: fakeReg(adapters) });
const INTEL = { name: 'Intel(R) UHD Graphics', id: 'PCI\\VEN_8086&DEV_9A78&SUBSYS_15CC1043' };

// 1. Windows
assert.strictEqual(win([INTEL]).useGpu, false, 'Integrated Intel graphics alone: no GPU');
const hybrid = win([INTEL, { name: 'NVIDIA GeForce RTX 3050 Laptop GPU', id: 'PCI\\VEN_10DE&DEV_25A2&SUBSYS_15CC1043' }]);
assert.ok(hybrid.useGpu && hybrid.adapter.vendor === 'nvidia', 'Laptop with an NVIDIA card: use it');
assert.strictEqual(win([{ name: 'AMD Radeon(TM) Graphics', id: 'PCI\\VEN_1002&DEV_1638', memory: '0x20000000' }]).useGpu, false, 'Ryzen integrated graphics: no GPU');
assert.strictEqual(win([{ name: 'AMD Radeon 780M Graphics', id: 'PCI\\VEN_1002&DEV_15BF', memory: '0x80000000' }]).useGpu, false, 'Radeon 780M is integrated');
assert.ok(win([{ name: 'AMD Radeon RX 6600', id: 'PCI\\VEN_1002&DEV_73FF', memory: '0x200000000' }]).useGpu, 'Radeon RX card: use it');
assert.ok(win([INTEL, { name: 'Intel(R) Arc(TM) A770 Graphics', id: 'PCI\\VEN_8086&DEV_56A0' }]).useGpu, 'Intel Arc card: use it');
assert.strictEqual(win([{ name: 'Intel(R) Arc(TM) Graphics', id: 'PCI\\VEN_8086&DEV_7D55' }]).useGpu, false, 'Integrated "Arc Graphics" is not a card');
assert.strictEqual(win([{ name: 'Microsoft Basic Display Adapter', id: 'ROOT\\BasicDisplay' }]).useGpu, false, 'Basic display driver: no GPU');
assert.strictEqual(detectGpu({ platform: 'win32', env: {}, run: () => ({ status: 1, stdout: '' }) }).useGpu, false, 'Registry unreadable: no GPU');
assert.strictEqual(detectGpu({ platform: 'win32', env: {}, run: () => { throw new Error('reg missing'); } }).useGpu, false, 'reg failing: no GPU');
assert.deepStrictEqual(hybrid.env, {}, 'Windows needs no environment (Chromium picks the high-performance GPU)');
console.log('✓ Test 1 Passed: Windows: dedicated NVIDIA/AMD/Arc cards used, integrated graphics not');

// Linux: a fake /sys/class/drm
function fakeSys(cards) {
  const files = {};
  const links = {};
  cards.forEach((c, i) => {
    const dev = `/sys/class/drm/card${i}/device`;
    files[`${dev}/vendor`] = c.vendor;
    if (c.vram) files[`${dev}/mem_info_vram_total`] = String(c.vram);
    files[`${dev}/boot_vga`] = c.screen ? '1' : '0';
    if (c.driver) links[`${dev}/driver`] = `../../../bus/pci/drivers/${c.driver}`;
  });
  const norm = p => p.replace(/\\/g, '/');
  return {
    readdirSync: () => cards.map((_, i) => `card${i}`).concat(['card0-eDP-1', 'renderD128', 'version']),
    readFileSync: p => {
      if (!(norm(p) in files)) throw new Error('ENOENT');
      return files[norm(p)];
    },
    readlinkSync: p => {
      if (!(norm(p) in links)) throw new Error('ENOENT');
      return links[norm(p)];
    }
  };
}
const linux = (cards, env = {}) => detectGpu({ platform: 'linux', env, sysRoot: '/sys/class/drm', fsImpl: fakeSys(cards) });
const INTEL_LINUX = { vendor: '0x8086', driver: 'i915', screen: true };

// 2. Linux
assert.strictEqual(linux([INTEL_LINUX]).useGpu, false, 'Intel alone: no GPU');
assert.strictEqual(linux([{ vendor: '0x1002', driver: 'amdgpu', vram: 512 * 2 ** 20, screen: true }]).useGpu, false, 'AMD integrated (small video memory): no GPU');
const nvLaptop = linux([INTEL_LINUX, { vendor: '0x10de', driver: 'nvidia' }]);
assert.ok(nvLaptop.useGpu);
assert.deepStrictEqual(nvLaptop.env, { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' }, 'NVIDIA laptop: render offload');
assert.deepStrictEqual(linux([INTEL_LINUX, { vendor: '0x1002', driver: 'amdgpu', vram: 8 * 2 ** 30 }]).env, { DRI_PRIME: '1' }, 'AMD card in a laptop: DRI_PRIME');
assert.deepStrictEqual(linux([INTEL_LINUX, { vendor: '0x10de', driver: 'nouveau' }]).env, { DRI_PRIME: '1' }, 'nouveau: DRI_PRIME');
const desktop = linux([{ vendor: '0x10de', driver: 'nvidia', screen: true }]);
assert.ok(desktop.useGpu && Object.keys(desktop.env).length === 0, 'A card that drives the screen needs no offload');
assert.deepStrictEqual(linux([INTEL_LINUX, { vendor: '0x10de', driver: 'nvidia' }], { __NV_PRIME_RENDER_OFFLOAD: '0' }).env.__NV_PRIME_RENDER_OFFLOAD, undefined, 'The user\'s own settings are kept');
assert.strictEqual(detectGpu({ platform: 'linux', env: {}, fsImpl: { readdirSync: () => { throw new Error('no /sys'); } } }).useGpu, false, 'No /sys/class/drm: no GPU');
console.log('✓ Test 2 Passed: Linux: dedicated cards used, laptops render on them (PRIME)');

// 3. VIDEOCALL_GPU overrides the detection
assert.strictEqual(detectGpu({ platform: 'win32', env: { VIDEOCALL_GPU: 'on' }, run: fakeReg([INTEL]) }).useGpu, true);
assert.strictEqual(detectGpu({ platform: 'win32', env: { VIDEOCALL_GPU: 'off' }, run: fakeReg([INTEL, { name: 'NVIDIA GeForce GTX 1650', id: 'PCI\\VEN_10DE&DEV_1F99' }]) }).useGpu, false);
assert.ok(isDedicated({ vendor: 'nvidia' }) && !isDedicated({ vendor: 'qualcomm', name: 'Adreno' }));
console.log('✓ Test 3 Passed: VIDEOCALL_GPU=on|off overrides the detection');

// 4. Every local module the main process loads is packaged into the app
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const packaged = require('../package.json').build.files;
for (const [, mod] of main.matchAll(/require\('\.\/([\w-]+)'\)/g)) {
  assert.ok(packaged.includes(`${mod}.js`), `${mod}.js is loaded by main.js but not packaged (build.files)`);
}
console.log('✓ Test 4 Passed: Every module the main process loads is packaged');

if (process.platform === 'win32' || process.platform === 'linux') {
  const here = detectGpu({ env: {} });
  console.log(`  (this computer: ${here.adapters.map(a => `${a.vendor}${a.name ? ' ' + a.name : ''}`).join(', ') || 'no adapters found'} -> ${here.useGpu ? 'GPU' : 'no GPU'})`);
}

console.log('\n========================================');
console.log(' ALL GPU DETECTION TESTS PASSED!        ');
console.log('========================================');
