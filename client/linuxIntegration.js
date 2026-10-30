/**
 * Linux Desktop Integration — makes the AppImage show its icon everywhere
 *
 * GNOME and other desktops take an app's icon from an installed .desktop entry, and file managers
 * show every AppImage with a generic icon. On launch from an AppImage this installs, for the
 * current user only (no root needed):
 *  - the icon set into ~/.local/share/icons/hicolor
 *  - a "Talvora" menu entry pointing at the AppImage, matched to the running window
 *  - the camera icon on the AppImage file itself (file manager)
 * Everything is refreshed on each launch, so moving the AppImage keeps it working.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const APP_ID = 'videocall'; // = package.json desktopName without ".desktop" (the Wayland app id)
// X11/XWayland window class, from package.json "name". GNOME uses it to link the running window to
// this menu entry (and its icon). Renaming the package would move the app's saved data.
const WINDOW_CLASS = 'videocall-client';
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

// Writes only when the content changed, so launches do not touch files needlessly
function writeIfChanged(file, data) {
  try {
    if (fs.readFileSync(file).equals(Buffer.from(data))) return false;
  } catch (e) {
    // missing: create it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return true;
}

// Desktop Entry Exec quoting: wrap in quotes, escape \ " ` $ and double any %
function quoteExec(file) {
  return `"${file.replace(/[\\"`$]/g, m => `\\${m}`).replace(/%/g, '%%')}"`;
}

function integrateAppImage(appRoot) {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage) return;

  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const iconTheme = path.join(dataHome, 'icons', 'hicolor');
  for (const size of ICON_SIZES) {
    const icon = fs.readFileSync(path.join(appRoot, 'icons', `${size}x${size}.png`));
    writeIfChanged(path.join(iconTheme, `${size}x${size}`, 'apps', `${APP_ID}.png`), icon);
  }

  const desktopFile = path.join(dataHome, 'applications', `${APP_ID}.desktop`);
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Talvora',
    'Comment=Secure voice, video & chat calls',
    `Exec=${quoteExec(appImage)} %U`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=Network;InstantMessaging;VideoConference;',
    'Keywords=talvora;video;call;meeting;chat;',
    `StartupWMClass=${WINDOW_CLASS}`,
    ''
  ].join('\n');
  if (writeIfChanged(desktopFile, entry)) {
    execFile('update-desktop-database', [path.dirname(desktopFile)], () => {});
  }

  // File managers (GNOME Files, Nemo, ...) show this instead of the generic executable icon
  const fileIcon = pathToFileURL(path.join(iconTheme, '512x512', 'apps', `${APP_ID}.png`)).href;
  execFile('gio', ['set', appImage, 'metadata::custom-icon', fileIcon], () => {});
}

module.exports = { integrateAppImage };
