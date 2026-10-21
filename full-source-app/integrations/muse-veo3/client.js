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
  if (button.textContent.startsWith('Chạy prompt')) {
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }
}, true);
document.addEventListener('keydown', event => {
  if (active()?.mode === 'text-to-image' && active()?.imageProvider === 'veo3' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }
}, true);
window.__MUSE_RETRY_VEO3__ = (projectId, jobId) => {
  const job = store()?.projects[projectId]?.jobs.find(j=>j.id===jobId);
  if (job?.imageProvider !== 'veo3') return false;
  invoke({action:'retry',projectId:job.veo3ProjectId,jobId:job.veo3JobId}).then(() => {
    store().updateJob(projectId,jobId,{status:'running',error:null,url:null,completedAt:null,startedAt:Date.now()});
    batches.set(job.veo3ProjectId,projectId);
  }).catch(error=>message(error.message));
  return true;
};
function message(text) { if (panel) panel.querySelector('[data-message]').textContent = text; }

function mount() {
  const project = active();
  const composer = document.querySelector('[data-muse-multiref-bar]');
  if (!composer || project?.mode !== 'text-to-image') { panel?.remove(); panel = null; return; }
  if (panel?.isConnected) {
    if (panel.dataset.project !== project.id) sync(project);
    return;
  }
  panel = document.createElement('section');
  panel.style.cssText = 'padding:12px;margin:8px 0;border:1px solid #365270;border-radius:8px;color:#cbd5e1;background:#101a2d';
  panel.innerHTML = `<label>Bộ tạo ảnh <select data-provider><option value="muse">Muse</option><option value="veo3">Veo3 Gen · VeoWorkflow</option></select></label>
    <div data-veo hidden style="margin-top:8px"><select data-project aria-label="Dự án VeoWorkflow"><option value="">Chọn dự án lấy cấu hình/profile</option></select>
    <button type="button" data-refresh>Tải danh sách dự án</button>
    <button type="button" data-run>Tạo ảnh bằng Veo3</button>
    <button type="button" data-cancel>Dừng job Veo3</button>
    <p style="font-size:11px;margin-top:6px">Dùng profile và model của dự án đã chọn. Kết quả xuất hiện trong bảng job bên dưới. Mỗi lần gửi tạo một batch riêng tại VeoWorkflow.</p></div>
    <div data-message role="status" style="font-size:12px;margin-top:6px"></div>`;
  for (const el of panel.querySelectorAll('select,button')) el.style.cssText = 'background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:5px;padding:6px;margin-right:8px';
  composer.before(panel);
  panel.querySelector('[data-provider]').onchange = event => {
    store().patchProject(active().id, { imageProvider: event.target.value });
    panel.querySelector('[data-veo]').hidden = event.target.value !== 'veo3';
    message(event.target.value === 'veo3' ? 'Bấm “Tạo ảnh bằng Veo3” để gửi prompt hiện tại.' : 'Dùng nút tạo ảnh Muse hiện có.');
  };
  panel.querySelector('[data-project]').onchange = event => store().patchProject(active().id, { veo3SourceProjectId: event.target.value });
  panel.querySelector('[data-refresh]').onclick = async () => {
    try {
      message('Đang kết nối VeoWorkflow…'); projects = await invoke({action:'projects'});
      fillProjects(); message(`Đã tải ${projects.length} dự án. Chọn dự án có profile đã đăng nhập.`);
    } catch (error) { message(error.message); }
  };
  panel.querySelector('[data-run]').onclick = () => void submit();
  panel.querySelector('[data-cancel]').onclick = async () => {
    const jobs = active()?.jobs.filter(j=>j.imageProvider==='veo3' && ['running','pending'].includes(j.status)) || [];
    try { for (const job of jobs) await invoke({action:'cancel',jobId:job.veo3JobId}); message(`Đã gửi yêu cầu dừng ${jobs.length} job Veo3.`); void poll(); }
    catch(error) { message(error.message); }
  };
  sync(project); fillProjects();
}
function sync(project) {
  panel.dataset.project = project.id;
  panel.querySelector('[data-provider]').value = project.imageProvider || 'muse';
  panel.querySelector('[data-veo]').hidden = project.imageProvider !== 'veo3';
  panel.querySelector('[data-project]').value = project.veo3SourceProjectId || '';
}
function fillProjects() {
  if (!panel?.isConnected) return;
  const select = panel.querySelector('[data-project]');
  select.replaceChildren(new Option('Chọn dự án lấy cấu hình/profile', ''));
  for (const p of projects) select.add(new Option(`${p.name} (${p.profiles.length} profile)`, p.id));
  select.value = active()?.veo3SourceProjectId || '';
}
async function submit() {
  if (busy) return;
  const p = active();
  const textarea = [...document.querySelectorAll('#muse-root textarea')].find(t => !t.closest('[role="dialog"]') && !t.dataset.musePoolSource);
  const prompts = (textarea?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!p?.veo3SourceProjectId || !prompts.length) { message('Chọn dự án Veo3 và nhập prompt trước.'); return; }
  const references = p.refs || [];
  const referenceIndices = prompts.map((text,index) => resolvePromptRefIds(p,index,text).map(id => references.findIndex(r => r.id === id)));
  if (referenceIndices.some(ids => ids.length > 10)) { message('Veo3 hỗ trợ tối đa 10 ảnh tham chiếu cho mỗi prompt. Dùng [#1,2] để chọn ảnh.'); return; }
  busy = true; panel.querySelector('[data-run]').disabled = true;
  message('Đang chuẩn bị batch và upload ảnh tham chiếu sang Veo3…');
  try {
    const result = await invoke({ action:'submit', museProjectId:p.id, sourceProjectId:p.veo3SourceProjectId,
      name:p.name, prompts:prompts.map(stripRefTag), ratio:p.ratio === 'portrait' ? '9:16' : p.ratio === 'landscape' ? '16:9' : p.ratio, concurrency:p.concurrency,
      references:references.map(r => ({dataBase64:r.dataBase64})), referenceIndices });
    result.jobs.forEach((remote,index) => {
      const now = Date.now();
      store().addJob(p.id, { id:crypto.randomUUID(), prompt:prompts[index], mode:'text-to-image', ratio:p.ratio,
        refIds:referenceIndices[index].map(i=>references[i].id), status:'running', createdAt:now, updatedAt:now,
        startedAt:now, attempts:1, runToken:1, messages:[], url:null, error:null,
        imageProvider:'veo3', veo3ProjectId:result.projectId, veo3JobId:remote.id,
        providerProfile:remote.profileName || remote.profileId });
    });
    batches.set(result.projectId, p.id);
    message(`Đã gửi ${result.jobs.length} job sang Veo3.`);
    void poll();
  } catch (error) { message(error.message); }
  finally { busy = false; if (panel) panel.querySelector('[data-run]').disabled = false; }
}
async function poll() {
  if (polling || !store()) return;
  polling = true;
  try {
    for (const p of Object.values(store().projects)) {
      for (const j of p.jobs || []) if (j.imageProvider === 'veo3' && ['running','pending'].includes(j.status)) batches.set(j.veo3ProjectId,p.id);
    }
    for (const [remoteProjectId, projectId] of batches) {
      try {
        const result = await invoke({action:'poll',projectId:remoteProjectId});
        const local = store().projects[projectId]?.jobs || [];
        for (const remote of result.jobs) {
          const job = local.find(j => j.veo3JobId === remote.id);
          if (!job) continue;
          const status = remote.status === 'COMPLETED' ? 'done' : ['FAILED','CANCELLED','CANCELED'].includes(remote.status) ? 'error' : 'running';
          store().updateJob(projectId,job.id,{status,url:remote.url || null,mime:'image/png',
            error:status==='error' ? remote.error || 'Job đã bị hủy.' : null,
            providerProfile:remote.profileName || remote.profileId,
            ...(status!=='running' && !job.completedAt ? {completedAt:Date.now()} : {})});
        }
        if (!store().projects[projectId]?.jobs.some(j => j.veo3ProjectId===remoteProjectId && ['running','pending'].includes(j.status))) batches.delete(remoteProjectId);
      } catch (error) { message(error.message + ' Sẽ tự kết nối lại.'); }
    }
  } finally { polling = false; }
}
let scheduled = false;
// Reconcile persisted remote jobs once, including jobs Muse marked interrupted on exit.
let restored = false;
const restoreTimer = setInterval(() => {
  if (restored || !store()) return;
  restored = true; clearInterval(restoreTimer);
  for (const p of Object.values(store().projects)) for (const j of p.jobs || []) {
    if (j.imageProvider === 'veo3' && j.veo3ProjectId) batches.set(j.veo3ProjectId,p.id);
  }
  void poll();
},1000);
new MutationObserver(() => {
  if (scheduled) return; scheduled = true;
  requestAnimationFrame(() => { scheduled = false; mount(); });
}).observe(document.documentElement,{childList:true,subtree:true});
setInterval(() => void poll(),4000);
mount();
