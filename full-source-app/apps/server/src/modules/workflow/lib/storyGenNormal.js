import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { compileScene } from './storyScenes.js';

// Only prepares Gen Normal jobs. Generation starts from its existing UI.
export function createStoryGenTransfer({ service, repository, profiles }) {
    const active = new Map();
    async function transfer(root, runId, requestedProfiles) {
        if (!path.isAbsolute(root || '')) throw Error('Thư mục lượt chạy không hợp lệ.');
        const state = JSON.parse(await readFile(path.join(root, 'audio-run.json'), 'utf8'));
        if (state.runId !== runId || (!state.batchId && state.status !== 'COMPLETED')) throw Error('Lượt audio chưa chuẩn bị xong.');
        const checked = await profiles(requestedProfiles || []);
        if (checked.missing.length || !checked.deduped.length) throw Error('Chọn profile hiện có trước khi chuyển sang Gen.');
        const ids = [...checked.deduped].sort();
        const snapshot = JSON.parse(await readFile(path.join(root, 'story-manifest.json'), 'utf8'));
        const scenes = snapshot.selectedSceneIds.map(id => snapshot.document.scenes.find(s => s.scene_id === id));
        const rows = scenes.map(scene => {
            const row = compileScene(snapshot.document, scene, snapshot.library, snapshot.options);
            if (!row.ready || !scene.frozen_prompt) throw Error('Cảnh chưa có prompt hoặc thiếu ảnh tham chiếu.');
            return { ...row, prompt: scene.frozen_prompt };
        });
        for (const row of rows) for (const image of row.images) {
            if (!(await stat(image.path)).isFile()) throw Error('Không đọc được ảnh tham chiếu.');
        }
        const marker = path.join(root, 'gen-normal-transfer.json');
        let saved;
        try { saved = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (saved && JSON.stringify(saved.profileIds) !== JSON.stringify(ids)) throw Error('Lượt này đã chuyển với bộ profile khác. Chuẩn bị lượt mới để đổi profile.');
        let project = saved ? await repository.getProject(saved.projectId) : null;
        if (saved && !project) throw Error('Project Gen đã bị xóa. Chuẩn bị lượt audio mới.');
        if (!project) {
            project = await service.createProject({ name: `Story · ${path.basename(root)}`, profileIds: ids, inputMethod: 'IMAGE_GENERATION', aspectRatio: snapshot.document.aspect_ratio || '16:9', outputDir: root, source: 'normal' });
            saved = { projectId: project.id, profileIds: ids, scenes: scenes.map(s => ({ sceneId: s.scene_id, audioFile: s.audio_file })), ready: false };
            await writeFile(marker, JSON.stringify(saved, null, 2));
        }
        if (saved.ready) return { projectId: project.id, count: rows.length };
        if (project.profiles.some(p => !p.veo3ProjectId)) {
            await service.ensureVeo3Projects(project.id);
            project = await repository.getProject(project.id);
            if (project.profiles.some(p => !p.veo3ProjectId)) throw Error('Có profile chưa tạo được project Flow. Đăng nhập lại rồi thử chuyển lại.');
        }
        if (project.jobs?.length) {
            if (project.jobs.length !== rows.length || project.jobs.some((j, i) => j.prompt !== rows[i].prompt)) throw Error('Project đã có nội dung khác; không ghi đè job.');
        } else {
            await service.updateProject(project.id, { concurrency: 8, batchSize: 4, delaySeconds: 2, imageModelKey: snapshot.options?.model || 'GEM_PIX_2', autoDownload: true });
            const uploads = new Map();
            const references = [];
            for (const row of rows) {
                const slots = [];
                for (const image of row.images) {
                    const slot = {};
                    for (const profileId of ids) {
                        const key = JSON.stringify([profileId, image.path]);
                        if (!uploads.has(key)) {
                            const result = await service.uploadImageAndGetMediaId(image.path, profileId, snapshot.document.aspect_ratio || '16:9', project.id);
                            if (!result.mediaId) throw Error('Upload ảnh tham chiếu không trả media ID.');
                            uploads.set(key, result.mediaId);
                        }
                        slot[profileId] = uploads.get(key);
                    }
                    slots.push(slot);
                }
                references.push(slots);
            }
            await service.submitStoryboardImageBatch(project.id, rows.map(r => r.prompt), snapshot.document.aspect_ratio || '16:9', references, false, 4);
        }
        saved.ready = true;
        await writeFile(marker, JSON.stringify(saved, null, 2));
        return { projectId: project.id, count: rows.length };
    }
    return (root, runId, ids) => {
        const key = path.resolve(root || '.');
        if (active.has(key)) return active.get(key);
        const task = transfer(root, runId, ids).finally(() => active.delete(key));
        active.set(key, task);
        return task;
    };
}
