// Shared resolver for Electron's per-OS userData directory. The packaged
// Electron app uses `app.getPath('userData')` which always points here
// (productName=Veo Workflow Tools). Dev mode Electron uses "Electron" as the dir
// name by default — rundev.sh works around this by pre-exporting any
// secrets the server needs, so the server hard-codes the production name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const APP_DIR_NAME = 'Veo Workflow Tools';
/** Electron's default userData name in dev, where productName is not applied. */
const DEV_APP_DIR_NAME = 'Electron';
function userDataRoot(appDirName) {
    const home = os.homedir();
    switch (process.platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', appDirName);
        case 'win32':
            return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), appDirName);
        default:
            return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), appDirName);
    }
}
export function getElectronUserDataPath() {
    return userDataRoot(APP_DIR_NAME);
}
// Server-side fallback when the Electron IPC bridge (127.0.0.1:9223) is
// unreachable. The Electron login flow writes a snapshot of the imported
// cookies to <userData>/profile-cookies/<id>.json so the server can still
// read the captured set even if the bridge is wedged (port conflict, AV,
// crashed main process). Snapshot is only as fresh as the last successful
// login — sufficient for the "click Test right after adding profile" UX
// that's been failing on some Windows machines.
export function getProfileCookiesSnapshotPath(profileId) {
    const packaged = path.join(getElectronUserDataPath(), 'profile-cookies', `${profileId}.json`);
    if (fs.existsSync(packaged))
        return packaged;
    // In dev, Electron writes under "Electron/" instead of the productName dir, so
    // the packaged path never exists and this fallback was silently dead.
    const dev = path.join(userDataRoot(DEV_APP_DIR_NAME), 'profile-cookies', `${profileId}.json`);
    return fs.existsSync(dev) ? dev : packaged;
}
