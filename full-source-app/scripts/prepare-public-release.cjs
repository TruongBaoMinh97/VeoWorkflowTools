const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const asar = require(path.join(root, 'desktop-app/node_modules/@electron/asar'));
const source = path.join(root, 'full-source-app');
const serverBuild = path.join(source, 'apps/server/dist');
const rendererBuild = path.join(source, 'apps/renderer/dist');
const version = require(path.join(source, 'package.json')).version;
const output = path.join(root, 'dist-releases', version);
const app = path.join(output, 'app');
const stage = path.join(output, 'asar-stage');
const original = path.join(root, 'full-release/Veo Workflow Tools-win32-x64');
const sourceNodeModules = path.join(source, 'node_modules');
const expectedTlsVersion = require(path.join(source, 'apps/server/package.json')).dependencies['node-tls-client'];
const installedTlsVersion = require(path.join(sourceNodeModules, 'node-tls-client/package.json')).version;
function syncTlsRuntime(nodeModules) {
    if (!nodeModules.startsWith(output + path.sep)) throw new Error('Invalid release node_modules destination');
    for (const name of ['node-tls-client', 'koffi']) {
        const from = path.join(sourceNodeModules, name);
        if (!fs.existsSync(path.join(from, 'package.json'))) throw new Error(`Missing source runtime dependency: ${name}`);
        const to = path.join(nodeModules, name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
    }
    const stagedVersion = require(path.join(nodeModules, 'node-tls-client/package.json')).version;
    if (stagedVersion !== expectedTlsVersion) throw new Error(`Wrong staged node-tls-client: ${stagedVersion}`);
}
function excluded(file) {
    const rel = path.relative(original, file).split(path.sep);
    if (rel.includes('node_modules')) return false;
    return rel.some(p => ['logs', 'user-data', 'uploads', 'tts-output', 'research', '.git'].includes(p))
        || /\.(db|sqlite|db-wal|db-shm|log)$/i.test(file) && path.basename(file) !== 'template.db'
        || /^\.env(?:\.|$)/.test(path.basename(file));
}
(async () => {
    if (installedTlsVersion !== expectedTlsVersion) throw new Error(`Source node-tls-client ${installedTlsVersion} does not match ${expectedTlsVersion}`);
    const tlsRuntime = require(path.join(sourceNodeModules, 'node-tls-client'));
    if (!tlsRuntime.ClientIdentifier.chrome_152_psk) throw new Error('Source node-tls-client lacks chrome_152_psk');
    await tlsRuntime.initTLS();
    const nativeName = `tls-client-${expectedTlsVersion}-windows-amd64.dll`;
    const nativeFrom = path.join(os.tmpdir(), nativeName);
    if (!fs.existsSync(nativeFrom) || fs.statSync(nativeFrom).size < 1_000_000) throw new Error(`Validated native TLS library missing: ${nativeFrom}`);
    const resume = process.argv.includes('--resume');
    if (!resume && (fs.existsSync(app) || fs.existsSync(stage))) throw new Error('Release staging already exists; inspect before reusing');
    fs.mkdirSync(output, { recursive: true });
    if (!resume) fs.cpSync(original, app, { recursive: true, filter: file => !excluded(file) });
    if (!fs.existsSync(path.join(serverBuild, 'index.js')) || !fs.existsSync(path.join(rendererBuild, 'index.html'))) {
        throw new Error('Build the server and renderer from source before staging a release');
    }
    syncTlsRuntime(path.join(app, 'resources/server/node_modules'));
    const nativeTo = path.join(app, 'resources/server/binaries/tls-client', nativeName);
    fs.mkdirSync(path.dirname(nativeTo), { recursive: true });
    fs.copyFileSync(nativeFrom, nativeTo);
    const stagedServerBuild = path.join(app, 'resources/server/dist');
    if (!stagedServerBuild.startsWith(output + path.sep)) throw new Error('Invalid release server destination');
    fs.rmSync(stagedServerBuild, { recursive: true, force: true });
    fs.cpSync(serverBuild, stagedServerBuild, { recursive: true });
    const archive = path.join(app, 'resources/app.asar');
    if (!resume || !fs.existsSync(path.join(stage, 'package.json'))) asar.extractAll(archive, stage);
    let removed = 0;
    function clean(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.name === 'node_modules') continue;
            if (['logs', 'user-data', 'uploads', 'tts-output', 'research', '.git'].includes(entry.name)
                || /\.(db|sqlite|db-wal|db-shm|log)$/i.test(entry.name) && entry.name !== 'template.db'
                || /^\.env(?:\.|$)/.test(entry.name)) {
                fs.rmSync(file, { recursive: entry.isDirectory(), force: true }); removed++;
            } else if (entry.isDirectory()) clean(file);
        }
    }
    clean(stage);
    syncTlsRuntime(path.join(stage, 'apps/server/node_modules'));
    fs.copyFileSync(path.join(source, 'package.json'), path.join(stage, 'package.json'));
    fs.cpSync(path.join(source, 'apps/electron/dist'), path.join(stage, 'apps/electron/dist'), { recursive: true });
    fs.cpSync(rendererBuild, path.join(stage, 'apps/renderer/dist'), { recursive: true, force: true });
    await asar.createPackage(stage, archive);
    asar.uncache(archive);
    const archivedTls = JSON.parse(asar.extractFile(archive, path.join('apps', 'server', 'node_modules', 'node-tls-client', 'package.json')).toString()).version;
    if (archivedTls !== expectedTlsVersion) throw new Error(`Wrong archived node-tls-client: ${archivedTls}`);
    const feed = asar.extractFile(archive, path.join('apps', 'electron', 'dist', 'main', 'privateUpdateAuth.js')).toString();
    if (!feed.includes('TruongBaoMinh97')) throw new Error('Wrong update feed');
    const unsafe = asar.listPackage(archive).filter(p => !p.includes('node_modules') && /\.(db|sqlite|log|db-wal|db-shm)$/.test(p) && !p.endsWith('template.db'));
    if (unsafe.length) throw new Error('Development data remains in archive');
    fs.writeFileSync(path.join(app, 'resources/app-update.yml'), 'provider: github\nowner: TruongBaoMinh97\nrepo: VeoWorkflowTools\nprivate: false\nupdaterCacheDirName: veo-workflow-tools-updater\n');
    const config = {
        appId: 'com.truongbaominh.veoworkflowtools', electronVersion: '33.2.0', productName: 'Veo Workflow Tools',
        extraMetadata: { version, name: 'veo-workflow-tools-full' },
        artifactName: 'Veo-Workflow-Tools-Setup-${version}-${arch}.${ext}',
        directories: { output: path.join(output, 'installer') },
        publish: [{ provider: 'github', owner: 'TruongBaoMinh97', repo: 'VeoWorkflowTools', private: false }],
        win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(root, 'desktop-app/assets/icon.ico'), signAndEditExecutable: false },
        nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, runAfterFinish: true, createDesktopShortcut: true, shortcutName: 'Veo Workflow Tools' },
    };
    fs.writeFileSync(path.join(output, 'builder.json'), JSON.stringify(config, null, 2));
    console.log(JSON.stringify({ version, app, removed, config: path.join(output, 'builder.json') }));
})().catch(error => { console.error(error); process.exitCode = 1; });
