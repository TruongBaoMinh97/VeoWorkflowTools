import { resolvePromptRefIds, stripRefTag } from '/muse-runtime-patch.mjs';

const store = () => window.__MUSE_STORE__?.getState();
const active = () => { const s = store(); return s?.projects[s.activeProjectId]; };
const invoke = payload => {
  if (!window.museDesktop?.invoke) throw new Error('Veo3 hiện dùng trong ứng dụng Muse desktop.');
  return window.museDesktop.invoke({ cmd: 'muse_veo3', ...payload });
};
let panel, busy = false, polling = false;
let projects = [];
const batches = new Map();

// Route the existing composer button and shortcut through the chosen provider.
document.addEventListener('click', event => {
  const button = event.target.closest?.('button');
  if (active()?.mode !== 'text-to-image' || active()?.imageProvider !== 'veo3' || !button) return;
  const text = (button.textContent || '').trim();
  if (/^(Chạy|Tạo)\b/.test(text) && (text.includes('prompt') || text.includes('job'))) {
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }
}, true);

document.addEventListener('keydown', event => {
  if (active()?.mode === 'text-to-image' && active()?.imageProvider === 'veo3' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }
}, true);

window.__MUSE_RETRY_VEO3__ = (projectId, jobId) => {
  const job = store()?.projects[projectId]?.jobs.find(j => j.id === jobId);
  if (job?.imageProvider !== 'veo3') return false;
  invoke({ action: 'retry', projectId: job.veo3ProjectId, jobId: job.veo3JobId }).then(() => {
    store().updateJob(projectId, jobId, { status: 'running', error: null, url: null, completedAt: null, startedAt: Date.now() });
    batches.set(job.veo3ProjectId, projectId);
  }).catch(error => message(error.message, 'error'));
  return true;
};

function message(text, tone = 'info') {
  if (!panel) return;
  const msgEl = panel.querySelector('[data-message]');
  if (!msgEl) return;
  msgEl.textContent = text || '';
  msgEl.dataset.tone = tone;
}

function updateMainRunButtonLabel(project) {
  const root = document.querySelector('#muse-root');
  if (!root) return;
  for (const btn of root.querySelectorAll('button')) {
    const txt = (btn.textContent || '').trim();
    if (!txt.includes('(Ctrl+↵)')) continue;
    const badge = btn.querySelector('[data-veo3-btn-tag]');
    const isVeo3 = project?.mode === 'text-to-image' && project?.imageProvider === 'veo3';
    if (isVeo3 && !badge) {
      const span = document.createElement('span');
      span.dataset.veo3BtnTag = 'true';
      span.className = 'muse-veo3-btn-tag';
      span.textContent = 'Veo3';
      btn.insertBefore(span, btn.lastElementChild || null);
    } else if (!isVeo3 && badge) {
      badge.remove();
    }
  }
}

function mount() {
  const project = active();
  const composer = document.querySelector('[data-muse-multiref-bar]');
  updateMainRunButtonLabel(project);
  if (!composer || project?.mode !== 'text-to-image') {
    panel?.remove();
    panel = null;
    return;
  }
  if (panel?.isConnected) {
    panel.hidden = Boolean(composer.hidden);
    if (panel.dataset.project !== project.id) sync(project);
    return;
  }
  panel = document.createElement('section');
  panel.className = 'muse-veo3-bar';
  panel.innerHTML = `
    <div class="muse-veo3-row">
      <div class="muse-veo3-brand">
        <span class="muse-veo3-dot"></span>
        <span>Engine tạo ảnh:</span>
      </div>
      <div class="muse-veo3-Segmented" data-provider-group>
        <button type="button" class="muse-veo3-seg-btn" data-provider-btn="muse">Muse AI</button>
        <button type="button" class="muse-veo3-seg-btn" data-provider-btn="veo3">⚡ Veo3 Gen (VeoWorkflow)</button>
      </div>
      <select data-provider hidden aria-hidden="true">
        <option value="muse">Muse</option>
        <option value="veo3">Veo3 Gen · VeoWorkflow</option>
      </select>

      <div class="muse-veo3-controls" data-veo hidden>
        <select data-project class="muse-veo3-select" aria-label="Dự án VeoWorkflow">
          <option value="">Chọn dự án lấy Profile…</option>
        </select>
        <button type="button" class="muse-veo3-btn" data-refresh title="Làm mới danh sách dự án từ VeoWorkflow (cổng 4000)">↻ Tải dự án</button>
        <button type="button" class="muse-veo3-btn is-primary" data-run title="Gửi toàn bộ prompt hiện tại sang Veo3 Gen">⚡ Tạo ảnh Veo3</button>
        <button type="button" class="muse-veo3-btn is-danger" data-cancel title="Dừng các job Veo3 đang chạy">■ Dừng</button>
        <span class="muse-veo3-spec" title="Cấu hình mặc định: Nano Banana 2 Lite · 5 luồng/profile · nghỉ 10s · burst 4 ảnh · upscale 1 luồng">Nano Banana 2 Lite · 5 luồng</span>
      </div>

      <div class="muse-veo3-status" data-message role="status"></div>
    </div>
  `;
  composer.before(panel);

  const setProvider = (val) => {
    const cur = active();
    if (!cur) return;
    store().patchProject(cur.id, { imageProvider: val });
    sync(active());
    updateMainRunButtonLabel(active());
    message(
      val === 'veo3'
        ? 'Sẵn sàng: Bấm “⚡ Tạo ảnh Veo3” hoặc nút “Chạy N job (Ctrl+↵)” bên dưới.'
        : 'Đang dùng máy chủ Muse AI mặc định.',
      'info'
    );
  };

  for (const btn of panel.querySelectorAll('[data-provider-btn]')) {
    btn.onclick = () => setProvider(btn.dataset.providerBtn);
  }
  panel.querySelector('[data-provider]').onchange = event => setProvider(event.target.value);
  panel.querySelector('[data-project]').onchange = event => {
    store().patchProject(active().id, { veo3SourceProjectId: event.target.value });
  };
  panel.querySelector('[data-refresh]').onclick = async () => {
    try {
      message('⏳ Đang kết nối VeoWorkflow…', 'info');
      projects = await invoke({ action: 'projects' });
      fillProjects();
      message(`✔ Đã kết nối (${projects.length} dự án)`, 'ok');
    } catch (error) {
      message(error.message, 'error');
    }
  };
  panel.querySelector('[data-run]').onclick = () => void submit();
  panel.querySelector('[data-cancel]').onclick = async () => {
    const jobs = active()?.jobs.filter(j => j.imageProvider === 'veo3' && ['running', 'pending'].includes(j.status)) || [];
    try {
      for (const job of jobs) await invoke({ action: 'cancel', jobId: job.veo3JobId });
      message(`Đã dừng ${jobs.length} job Veo3.`, 'info');
      void poll();
    } catch (error) {
      message(error.message, 'error');
    }
  };
  sync(project);
  void (async () => {
    try {
      projects = await invoke({ action: 'projects' });
      fillProjects();
      if (projects.length && !active()?.veo3SourceProjectId) {
        store().patchProject(active().id, { veo3SourceProjectId: projects[0].id });
        fillProjects();
      }
      if (active()?.imageProvider === 'veo3') {
        message(`✔ Sẵn sàng (${projects.length} dự án VeoWorkflow)`, 'ok');
      }
    } catch {
      fillProjects();
    }
  })();
}

function sync(project) {
  if (!panel || !project) return;
  panel.dataset.project = project.id;
  const prov = project.imageProvider || 'muse';
  panel.querySelector('[data-provider]').value = prov;
  for (const btn of panel.querySelectorAll('[data-provider-btn]')) {
    btn.classList.toggle('is-active', btn.dataset.providerBtn === prov);
  }
  panel.querySelector('[data-veo]').hidden = prov !== 'veo3';
  panel.querySelector('[data-project]').value = project.veo3SourceProjectId || '';
}

function fillProjects() {
  if (!panel?.isConnected) return;
  const select = panel.querySelector('[data-project]');
  select.replaceChildren(new Option('Chọn dự án lấy Profile…', ''));
  for (const p of projects) {
    select.add(new Option(`${p.name} (${p.profiles.length} profile)`, p.id));
  }
  select.value = active()?.veo3SourceProjectId || '';
}

async function submit() {
  if (busy) return;
  const p = active();
  const textarea = [...document.querySelectorAll('#muse-root textarea')].find(t => !t.closest('[role="dialog"]') && !t.dataset.musePoolSource);
  const prompts = (textarea?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!p?.veo3SourceProjectId || !prompts.length) {
    message('⚠ Hãy chọn dự án Veo3 và nhập ít nhất 1 dòng prompt.', 'error');
    return;
  }
  const references = p.refs || [];
  const referenceIndices = prompts.map((text, index) =>
    resolvePromptRefIds(p, index, text)
      .map(id => references.findIndex(r => r.id === id))
      .filter(idx => idx >= 0)
  );
  if (referenceIndices.some(ids => ids.length > 10)) {
    message('⚠ Veo3 hỗ trợ tối đa 10 ảnh tham chiếu/prompt. Dùng [#1,2] để chọn ảnh.', 'error');
    return;
  }
  busy = true;
  if (panel) panel.querySelector('[data-run]').disabled = true;
  message(`⏳ Đang gửi ${prompts.length} prompt & ảnh tham chiếu sang Veo3…`, 'info');
  try {
    const result = await invoke({
      action: 'submit',
      museProjectId: p.id,
      sourceProjectId: p.veo3SourceProjectId,
      name: p.name,
      prompts: prompts.map(stripRefTag),
      ratio: p.ratio === 'portrait' ? '9:16' : p.ratio === 'landscape' ? '16:9' : p.ratio,
      concurrency: p.concurrency,
      references: references.map(r => ({ dataBase64: r.dataBase64 })),
      referenceIndices,
    });
    result.jobs.forEach((remote, index) => {
      const now = Date.now();
      store().addJob(p.id, {
        id: crypto.randomUUID(),
        prompt: prompts[index],
        mode: 'text-to-image',
        ratio: p.ratio,
        refIds: referenceIndices[index].map(i => references[i].id),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attempts: 1,
        runToken: 1,
        messages: [],
        url: null,
        error: null,
        imageProvider: 'veo3',
        veo3ProjectId: result.projectId,
        veo3JobId: remote.id,
        providerProfile: remote.profileName || remote.profileId,
      });
    });
    batches.set(result.projectId, p.id);
    message(`✔ Đã gửi ${result.jobs.length} job sang Veo3 Gen!`, 'ok');
    void poll();
  } catch (error) {
    message(error.message, 'error');
  } finally {
    busy = false;
    if (panel) panel.querySelector('[data-run]').disabled = false;
  }
}

async function poll() {
  if (polling || !store()) return;
  polling = true;
  try {
    for (const p of Object.values(store().projects)) {
      for (const j of p.jobs || []) {
        if (j.imageProvider === 'veo3' && ['running', 'pending'].includes(j.status)) {
          batches.set(j.veo3ProjectId, p.id);
        }
      }
    }
    for (const [remoteProjectId, projectId] of batches) {
      try {
        const result = await invoke({ action: 'poll', projectId: remoteProjectId });
        const local = store().projects[projectId]?.jobs || [];
        for (const remote of result.jobs) {
          const job = local.find(j => j.veo3JobId === remote.id);
          if (!job) continue;
          const status = remote.status === 'COMPLETED' ? 'done' : ['FAILED', 'CANCELLED', 'CANCELED'].includes(remote.status) ? 'error' : 'running';
          store().updateJob(projectId, job.id, {
            status,
            url: remote.url || null,
            mime: 'image/png',
            error: status === 'error' ? remote.error || 'Job đã bị hủy.' : null,
            providerProfile: remote.profileName || remote.profileId,
            ...(status !== 'running' && !job.completedAt ? { completedAt: Date.now() } : {}),
          });
        }
        if (!store().projects[projectId]?.jobs.some(j => j.veo3ProjectId === remoteProjectId && ['running', 'pending'].includes(j.status))) {
          batches.delete(remoteProjectId);
        }
      } catch (error) {
        message(error.message + ' (Đang tự kết nối lại…)', 'error');
      }
    }
  } finally {
    polling = false;
  }
}

let scheduled = false;
let restored = false;
const restoreTimer = setInterval(() => {
  if (restored || !store()) return;
  restored = true;
  clearInterval(restoreTimer);
  for (const p of Object.values(store().projects)) {
    for (const j of p.jobs || []) {
      if (j.imageProvider === 'veo3' && j.veo3ProjectId) batches.set(j.veo3ProjectId, p.id);
    }
  }
  void poll();
}, 1000);

new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    mount();
  });
}).observe(document.documentElement, { childList: true, subtree: true });

setInterval(() => void poll(), 4000);
mount();
