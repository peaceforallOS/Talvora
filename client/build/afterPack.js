/**
 * electron-builder afterPack hook. On Linux the app starts through build/linux-launcher.sh, which
 * installs missing system libraries before Electron loads; the Electron binary becomes
 * "<executable>-bin". Windows needs nothing: the portable .exe carries everything it uses.
 */

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const executable = path.join(context.appOutDir, context.packager.executableName);
  fs.renameSync(executable, `${executable}-bin`);
  fs.copyFileSync(path.join(__dirname, 'linux-launcher.sh'), executable);
  fs.chmodSync(executable, 0o755);
};
