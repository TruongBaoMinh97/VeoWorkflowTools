const BASE = 'http://127.0.0.1:4000';
export const IMAGE_DEFAULTS = Object.freeze({
  imageModelKey: 'HARBOR_SEAL', concurrency: 5, delaySeconds: 10,
  batchSize: 4, imageUpscaleConcurrency: 1,
});
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'CANCELED']);

export class MuseVeo3Bridge {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; this.busy = new Set(); }
  async api(path, body, method = body === undefined ? 'GET' : 'POST') {
    let response;
    try {
      response = await this.fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    } catch (error) {
      throw new Error(`Không kết nối được VeoWorkflow tại cổng 4000. Hãy mở VeoWorkflow rồi thử lại. ${error.name === 'TimeoutError' ? 'Yêu cầu đã hết thời gian chờ.' : ''}`);
    }
    const data = await response.json();
    if (!response.ok || data?.success === false || data?.error) {
      throw new Error(data?.message || (typeof data?.error === 'string' ? data.error : data?.error?.message) || `VeoWorkflow HTTP ${response.status}`);
    }
    return data;
  }
  async invoke(payload) {
    if (payload.action === 'projects') {
      const projects = await this.api('/api/gen-normal/projects');
      return projects.map(p => ({ id: p.id, name: p.name,
        profiles: (p.profiles || []).map(pp => ({ id: pp.profileId, name: pp.profile?.name || pp.profileId })),
        imageModelKey: p.imageModelKey }));
    }
    if (payload.action === 'poll') {
      const result = await this.api(`/api/gen-normal/projects/${encodeURIComponent(payload.projectId)}/jobs`);
      return { jobs: result.jobs.map(j => ({ id: j.id, status: j.status, url: j.resultUrl,
        error: j.error, profileName: j.profile?.name, profileId: j.profileId })) };
    }
    if (payload.action === 'cancel') return this.api(`/api/gen-normal/jobs/${encodeURIComponent(payload.jobId)}/cancel`, {});
    if (payload.action === 'retry') return this.api(`/api/gen-normal/projects/${encodeURIComponent(payload.projectId)}/jobs/${encodeURIComponent(payload.jobId)}/retry`, {});
    if (payload.action !== 'submit') throw new Error('Tác vụ Veo3 không hợp lệ.');
    const key = String(payload.museProjectId || '');
    if (!key || this.busy.has(key)) throw new Error('Dự án đang gửi batch Veo3, vui lòng chờ.');
    this.busy.add(key);
    try { return await this.submit(payload); } finally { this.busy.delete(key); }
  }
  async submit(payload) {
    const { prompts, references = [], referenceIndices = [], ratio, sourceProjectId } = payload;
    if (!Array.isArray(prompts) || !prompts.length || prompts.length > 500 || prompts.some(p => typeof p !== 'string' || !p.trim())) throw new Error('Cần 1–500 prompt.');
    if (!['16:9', '9:16', '1:1', '3:4', '4:3'].includes(ratio)) throw new Error('Tỉ lệ ảnh không được Veo3 hỗ trợ.');
    if (referenceIndices.length !== prompts.length || referenceIndices.some(indices => !Array.isArray(indices) || indices.length > 10 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= references.length))) throw new Error('Mỗi prompt hỗ trợ tối đa 10 ảnh tham chiếu hợp lệ.');
    const source = await this.api(`/api/gen-normal/projects/${encodeURIComponent(sourceProjectId)}`);
    const profiles = (source.profiles || []).map(pp => pp.profileId);
    if (!profiles.length) throw new Error('Dự án Veo3 chưa có profile.');
    // A dedicated backend project isolates start-generation from unrelated drafts.
    const project = await this.api('/api/gen-normal/projects', {
      name: `Muse · ${String(payload.name || 'Tạo ảnh').slice(0,80)} · ${new Date().toISOString()}`,
      profileIds: profiles, aspectRatio: ratio, inputMethod: 'TEXT',
    });
    const projectId = project.id;
    if (!projectId) throw new Error('VeoWorkflow không trả về mã dự án.');
    const path = `/api/gen-normal/projects/${encodeURIComponent(projectId)}`;
    try {
      await this.api(path, { ...IMAGE_DEFAULTS, aspectRatio: ratio, autoDownload: false }, 'PATCH');
      const uploaded = [];
      const needed = new Set(referenceIndices.flat());
      for (const index of needed) {
        const ref = references[index];
        if (typeof ref?.dataBase64 !== 'string' || !ref.dataBase64) throw new Error(`Ảnh tham chiếu #${index + 1} thiếu dữ liệu.`);
        const mapping = {};
        for (const profileId of profiles) {
          const result = await this.api('/api/gen-normal/upload-image', { imageBase64: ref.dataBase64, profileId, projectId, aspectRatio: ratio });
          if (!result.mediaId) throw new Error(`Không upload được ảnh #${index + 1}.`);
          mapping[profileId] = result.mediaId;
        }
        uploaded[index] = mapping;
      }
      await this.api(path + '/submit-storyboard-image-batch', { promptText: prompts, aspectRatio: ratio,
        perJobReferenceImageMediaIdsByProfile: referenceIndices.map(indices => indices.map(i => uploaded[i])), appendJobs: true });
      const { jobs } = await this.api(path + '/jobs');
      const ordered = [...jobs].sort((a,b) => a.jobIndex - b.jobIndex);
      if (ordered.length !== prompts.length) throw new Error('Số job Veo3 trả về không khớp số prompt.');
      const { imageUpscaleConcurrency, ...generationDefaults } = IMAGE_DEFAULTS;
      await this.api(path + '/start-generation', generationDefaults);
      return { projectId, jobs: ordered.map(j => ({ id: j.id, profileName: j.profile?.name, profileId: j.profileId })) };
    } catch (error) {
      throw new Error(`${error.message} (Dự án VeoWorkflow: ${projectId}; kiểm tra tại Veo3 Gen trước khi gửi lại.)`);
    }
  }
}
export const isTerminalVeo3Job = status => terminal.has(status);
