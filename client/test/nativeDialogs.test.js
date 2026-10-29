/**
 * Native Dialog Guard — the app never uses alert(), confirm() or prompt(). In Electron on Windows,
 * text fields stop receiving typing after one of them closes (until the window is refocused), which
 * made the invite name field unusable. Messages and confirmations are shown inside the app instead.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- Starting Native Dialog Guard ---');

const srcDir = path.join(__dirname, '../src');
const offenders = [];
for (const name of fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
  fs.readFileSync(path.join(srcDir, name), 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/.test(code)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
  });
}
assert.deepStrictEqual(offenders, [], `Native dialogs found:\n${offenders.join('\n')}`);
console.log('✓ Test 1 Passed: No alert(), confirm() or prompt() in the app');

const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
for (const id of ['invite-error', 'modal-leave', 'btn-cancel-leave', 'btn-confirm-leave']) {
  assert.ok(html.includes(`id="${id}"`), `Missing in-app element #${id}`);
}
console.log('✓ Test 2 Passed: In-app invite error and leave confirmation present');

console.log('\n========================================');
console.log(' ALL NATIVE DIALOG GUARD TESTS PASSED!  ');
console.log('========================================\n');
