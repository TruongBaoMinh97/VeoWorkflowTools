import path from 'node:path';
import { mkdir, readFile, writeFile, rename, copyFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { saveMediaBundle } from './saveMedia.js';
import { storyId } from './storyScenes.js';

export async function saveStoryResults(story, results, runId) {
    storyId(story.sceneId);
    const base = path.join(story.root, 'scenes');
    const saved = await saveMediaBundle({ outputDir: base, productId: story.sceneId, results, prompts: [story.prompt], metadata: { story, runId, reviewStatus: 'pending' } });
    // Keep attempt history, but expose one flat folder for editing/export.
    const folder = path.join(story.root, 'images');
    await mkdir(folder, { recursive: true });
    const exports = [];
    for (const [index, result] of saved.entries()) {
        const name = story.sceneId + (saved.length > 1 ? `_${index + 1}` : '') + path.extname(result.savedPath);
        const destination = path.join(folder, name);
        const temporary = path.join(folder, randomUUID() + '.tmp');
        await copyFile(result.savedPath, temporary);
        await rename(temporary, destination);
        exports.push({ ...result, url: `file://${destination}`, savedPath: destination });
    }
    return exports;
}
export async function listStoryResults(root) {
    const snapshot = JSON.parse(await readFile(path.join(root, 'story-manifest.json'), 'utf8'));
    const rows = [];
    for (const scene of snapshot.document.scenes) {
        storyId(scene.scene_id);
        const folder = path.join(root, 'scenes', scene.scene_id);
        const attempts = [];
        for (const dir of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
            if (!dir.isDirectory()) continue;
            const manifest = JSON.parse(await readFile(path.join(folder, dir.name, 'manifest.json'), 'utf8').catch(() => 'null'));
            if (manifest) attempts.push({ id: dir.name, ...manifest });
        }
        const selection = JSON.parse(await readFile(path.join(root, 'selected', scene.scene_id + '.json'), 'utf8').catch(() => 'null'));
        rows.push({ scene, attempts, selection });
    }
    return rows;
}
export async function selectStoryResult(root, sceneId, attemptId, index) {
    storyId(sceneId); storyId(attemptId);
    const rows = await listStoryResults(root);
    const attempt = rows.find(r => r.scene.scene_id === sceneId)?.attempts.find(a => a.id === attemptId);
    const file = attempt?.results?.[index]?.savedPath;
    if (!file || !path.resolve(file).startsWith(path.resolve(root, 'scenes') + path.sep)) throw new Error('Không tìm thấy ảnh kết quả hợp lệ.');
    const folder = path.join(root, 'selected'); await mkdir(folder, { recursive: true });
    const destination = path.join(folder, sceneId + path.extname(file));
    const temp = path.join(folder, randomUUID() + path.extname(file));
    await copyFile(file, temp); await rename(temp, destination);
    const selection = { sceneId, attemptId, index, file: destination, reviewStatus: 'selected' };
    const metaTemp = path.join(folder, randomUUID() + '.json');
    await writeFile(metaTemp, JSON.stringify(selection, null, 2));
    await rename(metaTemp, path.join(folder, sceneId + '.json'));
    return selection;
}
