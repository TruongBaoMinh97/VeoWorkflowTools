const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const asar = require(path.join(root, 'desktop-app/node_modules/@electron/asar'));
const source = path.join(root, 'full-source-app');
const version = require(path.join(source, 'package.json')).version;
const output = path.join(root, 'dist-releases', version);
const app = path.join(output, 'app');
const stage = path.join(output, 'asar-stage');
const original = path.join(root, 'full-release/Veo Workflow Tools-win32-x64');
function excluded(file) {
    const rel = path.relative(original, file).split(path.sep);
    if (rel.includes('node_modules')) return false;
    return rel.some(p => ['logs', 'user-data', 'uploads', 'tts-output', 'research', '.git'].includes(p))
        || /\.(db|sqlite|db-wal|db-shm|log)$/i.test(file) && path.basename(file) !== 'template.db'
        || /^\.env(?:\.|$)/.test(path.basename(file));
}
(async () => {
    if (fs.existsSync(app) || fs.existsSync(stage)) throw new Error('Release staging already exists; inspect before reusing');
    fs.mkdirSync(output, { recursive: true });
    fs.cpSync(original, app, { recursive: true, filter: file => !excluded(file) });
    const archive = path.join(app, 'resources/app.asar');
    asar.extractAll(archive, stage);
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
    fs.copyFileSync(path.join(source, 'package.json'), path.join(stage, 'package.json'));
    fs.cpSync(path.join(source, 'apps/electron/dist'), path.join(stage, 'apps/electron/dist'), { recursive: true });
    await asar.createPackage(stage, archive);
    asar.uncache(archive);
    const feed = asar.extractFile(archive, 'apps/electron/dist/main/privateUpdateAuth.js').toString();
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
