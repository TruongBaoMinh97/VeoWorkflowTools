import path from 'node:path';
import { mkdir, readFile, writeFile, rename, stat, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizePromptWorkflow, mergePromptPatch } from '../workflow/lib/promptStory.js';
import { previewStory } from '../workflow/lib/storyScenes.js';
import { getElectronUserDataPath } from '../../lib/electronPaths.js';

export const MANGA_ROOT=path.join(getElectronUserDataPath(),'manga-story');
export async function assertMangaDrafts(project,jobs,imageModelKey,root=MANGA_ROOT) {
    const manga=jobs.filter(j=>j.prompt.startsWith('Manga run '));if(!manga.length)return;
    const state=JSON.parse(await readFile(path.join(root,hash(project.id),'state.json'),'utf8'));
    for(const job of manga){const run=state.runs.find(r=>r.rows.some(row=>row.prompt===job.prompt));if(!run)throw Error('Không tìm thấy snapshot bộ ảnh. Chuẩn bị lại cảnh trước khi chạy.');
        if(run.model!==(imageModelKey||project.imageModelKey||'GEM_PIX_2')||run.aspectRatio!==project.aspectRatio||JSON.stringify([...run.profileIds].sort())!==JSON.stringify(project.profiles.map(p=>p.profileId).sort()))throw Error('Model/profile/tỷ lệ khác snapshot Manga. Khôi phục cấu hình của lượt hoặc chuẩn bị lượt mới.');
    }
}

export const MANGA_STYLE = 'Colored Japanese slice-of-life manga for a mature audience. 2D hand-drawn illustration, clean soft linework, restrained cel shading, natural adult proportions, believable age and subtle wrinkles according to each character description. Warm muted cream, natural wood and sage colors, soft window light, everyday Japanese interiors. Understated expressive faces. No chibi, no 3D, no text, no speech bubbles, no watermark.';
const characterSchema = z.object({ id:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/), name:z.string().max(100), description:z.string().max(4000), outfit:z.string().max(2000).default(''), asset:z.string().max(100).default('') });
export const mangaConfigSchema = z.object({ schema:z.literal(1).default(1), style:z.string().trim().min(1).max(8000), styleAsset:z.string().max(100).default(''), text:z.string().max(1000000), maxReferences:z.number().int().min(1).max(8).default(3), characters:z.array(characterSchema).max(50) });
export const defaultMangaConfig = () => ({schema:1,style:MANGA_STYLE,styleAsset:'',text:'',maxReferences:3,characters:[]});
export function buildCharacterSheetPrompt(character,style,aspectRatio,hasStyleReference=false) {
    const styleSlot=character.asset?2:1;
    return [
        style,
        character.asset?'Reference image 1 defines the existing character identity. Preserve this exact person, age, face, hair and body proportions across all five views. If it is already a multi-view sheet, all its views depict that same single identity. Use the outfit description below for the requested outfit variant.':'',
        hasStyleReference?`Reference image ${styleSlot} is STYLE ONLY. Borrow rendering style, not its people, clothing or objects.`:'',
        'Create ONE unified five-view character reference sheet of ONE AND THE SAME character, repeated in five panels. This is a character design sheet, not five different people and not a narrative scene.',
        'Layout: the left two-thirds contain two tall, equally scaled full-body views side by side: front view on the far left and back view in the middle. Both show the complete body from the top of the head to the soles of the feet, with comfortable margins and no cropped head or feet.',
        'The right third contains three vertically stacked portrait panels: top = front-facing head-and-shoulders close-up; middle = true side-profile head-and-shoulders view facing left; bottom = three-quarter head-and-shoulders portrait turned toward the left. Keep the full hairstyle and chin visible in every portrait.',
        'Use a plain white background with subtle white spacing between panels. Neutral relaxed standing pose, arms resting naturally at the sides, calm neutral expression, even soft lighting. No props, scenery, dramatic perspective, labels, letters, numbers, captions, speech bubbles, logos or watermark.',
        'All five views must share exactly the same facial structure, eye color, hairstyle, hair color, age, body proportions, clothing colors, clothing construction and accessories. The back view must show the same outfit and hairstyle from behind. Render in the selected style above; do not switch to photography when the selected style is manga or illustration.',
        `Character: ${character.name||character.id}. Fixed appearance: ${character.description}. Outfit: ${character.outfit}.`,
        `Canvas aspect ratio: ${aspectRatio}. Exactly five views, with two full-body panels and three portrait panels, all depicting the same identity.`
    ].filter(Boolean).join('\n');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const assetId = /^[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/;

export class MangaStoryStore {
    constructor({root,repository,service,download}) { this.root=root; this.repository=repository; this.service=service; this.download=download; this.locks=new Set(); this.tasks=new Set(); }
    dir(id) { return path.join(this.root,hash(id)); }
    assetPath(id,asset) { if(!assetId.test(asset)) throw Error('Ảnh tham chiếu không hợp lệ.'); return path.join(this.dir(id),'assets',asset); }
    async project(id) { const p=await this.repository.getProject(id); if(!p) throw Error('Project không còn tồn tại.'); return p; }
    async read(id) { await this.project(id); try{return JSON.parse(await readFile(path.join(this.dir(id),'state.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {revision:0,config:defaultMangaConfig(),runs:[],approved:{}};} }
    async write(id,state) { await mkdir(this.dir(id),{recursive:true});const file=path.join(this.dir(id),'state.json');const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(state,null,2));await rename(tmp,file); }
    async exclusive(id,fn) { if(this.locks.has(id))throw Error('Đang xử lý bộ ảnh này. Chờ hoàn thành rồi thử lại.');this.locks.add(id);try{return await fn();}finally{this.locks.delete(id);} }
    async save(id,config,revision) { return this.exclusive(id,async()=>{const state=await this.read(id);if(state.revision!==revision)throw Error('Cấu hình đã thay đổi ở cửa sổ khác. Tải lại trước khi lưu.');const parsed=mangaConfigSchema.parse(config);if(new Set(parsed.characters.map(c=>c.id)).size!==parsed.characters.length)throw Error('Trùng mã nhân vật.');for(const asset of [parsed.styleAsset,...parsed.characters.map(c=>c.asset)].filter(Boolean))await stat(this.assetPath(id,asset));state.config=parsed;state.revision++;await this.write(id,state);return state;}); }
    async patchPrompts(id,{revision,config,patchText,allowAppend=false}) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id);
            if(state.revision!==revision)throw Error('Cấu hình đã thay đổi ở cửa sổ khác. Tải lại trước khi vá lỗi.');
            const baseConfig=config?mangaConfigSchema.parse(config):state.config;
            if(new Set(baseConfig.characters.map(c=>c.id)).size!==baseConfig.characters.length)throw Error('Trùng mã nhân vật.');
            for(const asset of [baseConfig.styleAsset,...baseConfig.characters.map(c=>c.asset)].filter(Boolean))await stat(this.assetPath(id,asset));
            const merged=mergePromptPatch(baseConfig.text,patchText,{allowAppend});
            const nextConfig=mangaConfigSchema.parse({...baseConfig,text:merged.text});
            state.config=nextConfig;
            state.revision++;
            await this.write(id,state);
            const preview=await this.preview(id,state.config);
            return {revision:state.revision,config:state.config,patchedSceneIds:merged.patchedSceneIds,notes:merged.notes,count:merged.count,rows:preview.rows};
        });
    }
    async importAsset(id,file) {
        await this.project(id);if(!path.isAbsolute(file))throw Error('Chọn đường dẫn ảnh tuyệt đối.');
        const ext=path.extname(file).toLowerCase();if(!/^\.(png|jpg|jpeg|webp)$/.test(ext))throw Error('Chọn ảnh PNG, JPG hoặc WebP.');
        const info=await stat(file);if(!info.isFile()||info.size>30*1024*1024)throw Error('Ảnh không hợp lệ hoặc vượt 30 MB.');
        const bytes=await readFile(file);const valid=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');if(!valid)throw Error('Tệp không chứa ảnh PNG, JPEG hoặc WebP.');
        const actualExt=bytes[0]===137?'.png':bytes[0]===255?'.jpg':'.webp';
        const asset=hash(bytes)+actualExt;await mkdir(path.join(this.dir(id),'assets'),{recursive:true});await writeFile(this.assetPath(id,asset),bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});return {asset};
    }
    async preview(id,config) {
        const project=await this.project(id);config=mangaConfigSchema.parse(config);
        if(new Set(config.characters.map(c=>c.id)).size!==config.characters.length)throw Error('Trùng mã nhân vật.');
        const library={};const characters=config.characters.map(c=>{if(c.asset)library['CHAR_'+c.id]={path:this.assetPath(id,c.asset),reviewStatus:'approved'};return {character_id:c.id,display_name:c.name||c.id,reference_key:'CHAR_'+c.id,identity_description_en:c.description,outfits:[{outfit_id:c.id+'_DEFAULT',description_en:c.outfit}]};});
        if(config.styleAsset)library.STYLE_SHARED={path:this.assetPath(id,config.styleAsset),reviewStatus:'approved'};
        const def=normalizePromptWorkflow({nodes:[{type:'story-input',data:{promptText:config.text,aspectRatio:project.aspectRatio}},{type:'story-references',data:{characters,sharedStyle:config.style}}]});
        const document=def.nodes[0].data.document;
        const preview=await previewStory(document,library,{maxReferences:config.maxReferences});
        for(const row of preview.rows)if(row.ready){
            row.prompt+='\nCharacter references may be multi-view character sheets. Each sheet represents ONE person shown from several angles, not a group. Use the relevant angle to preserve identity. Render only the people explicitly present in this scene, each once. Output ONE continuous scene, never a character sheet, collage, split screen or multiple panels. Do not copy the white reference background into the scene.';
        }
        return preview;
    }
    async context(id) {
        const state=await this.read(id),project=await this.project(id);
        // Reconcile interrupted preparation by its immutable per-run prompt markers.
        let changed=false;
        if(!this.locks.has(id)&&!this.tasks.has(id))for(const run of state.runs.filter(r=>r.status==='PREPARING')){
            const matches=project.jobs.filter(j=>j.prompt.startsWith(`Manga run ${run.id} / `));
            run.status=matches.length===run.rows.length?'READY':'FAILED';run.error=run.status==='FAILED'?'Lượt chuẩn bị bị gián đoạn. Kiểm tra job trước khi tạo lượt mới.':null;changed=true;
        }
        if(changed)await this.exclusive(id,async()=>{const latest=await this.read(id);for(const recovered of state.runs){const target=latest.runs.find(r=>r.id===recovered.id);if(target?.status==='PREPARING'){target.status=recovered.status;target.error=recovered.error;}}await this.write(id,latest);});
        return {...state,runs:state.runs.map(run=>({...run,rows:run.rows.map(row=>{const job=project.jobs.find(j=>j.prompt===row.prompt);return {...row,job:job?{id:job.id,status:job.status,resultUrl:job.resultUrl,error:job.error}:null};})})),project:{name:project.name,aspectRatio:project.aspectRatio,imageModelKey:project.imageModelKey,profiles:project.profiles.map(p=>({id:p.profileId,name:p.profile?.name})),outputDir:project.outputDir},preset:MANGA_STYLE};
    }
    async history(id) {
        const current=await this.read(id),projects=this.repository.listProjects?await this.repository.listProjects('normal'):[await this.project(id)];
        const runs=[];
        for(const summary of projects){
            let state;try{state=JSON.parse(await readFile(path.join(this.dir(summary.id),'state.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
            if(!state.runs?.length)continue;
            const project=await this.project(summary.id);
            for(const run of state.runs){
                const isCharRun = !!(run.characterId || (Array.isArray(run.characterIds) && run.characterIds.length));
                const snapshot=isCharRun?run.config?.characters?.find(c=>c.id===run.characterId||run.characterIds?.includes(c.id)):null;
                const canonical=snapshot?.name||run.characterId;
                const target=isCharRun?current.config.characters.find(c=>c.id===run.characterId||run.characterIds?.includes(c.id))||current.config.characters.find(c=>c.id===canonical)||current.config.characters.find(c=>c.name===canonical):null;
                runs.push({id:run.id,requestId:run.requestId,characterId:run.characterId,characterIds:run.characterIds,status:run.status,error:run.error,createdAt:run.createdAt,sourceProjectId:summary.id,sourceProjectName:summary.name||summary.id,targetCharacterId:target?.id||null,rows:run.rows.map(row=>{const job=project.jobs.find(j=>j.prompt===row.prompt);return {...row,job:job?{id:job.id,status:job.status,resultUrl:job.resultUrl,error:job.error}:null};})});
            }
        }
        runs.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
        return {runs};
    }
    async adopt(id,{sourceProjectId,jobId,targetCharacterId}) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id),target=state.config.characters.find(c=>c.id===targetCharacterId);
            if(!target)throw Error('Không tìm thấy nhân vật đích trong project hiện tại.');
            const sourceState=await this.read(sourceProjectId),sourceProject=await this.project(sourceProjectId);
            const run=sourceState.runs.find(r=>r.rows.some(row=>sourceProject.jobs.some(j=>j.id===jobId&&j.prompt===row.prompt)));
            const job=sourceProject.jobs.find(j=>j.id===jobId);
            const isCharRun = !!(run?.characterId || (Array.isArray(run?.characterIds)&&run.characterIds.length) || run?.rows?.some(r=>r.sceneId.startsWith('CHAR_')));
            if(!run||!isCharRun||job?.status!=='COMPLETED'||!job.resultUrl)throw Error('Ảnh nguồn chưa hoàn thành hoặc không thuộc lượt nhân vật.');
            const dest=path.join(this.dir(id),'approved',randomUUID()+'.png');await mkdir(path.dirname(dest),{recursive:true});
            if(/^(https?:\/\/|file:\/\/)/.test(job.resultUrl))await this.download(job.resultUrl,dest);else await copyFile(job.resultUrl,dest);
            const {asset}=await this.importAsset(id,dest);target.asset=asset;state.revision++;await this.write(id,state);return {asset,revision:state.revision,targetCharacterId};
        });
    }
    async submit(id,{revision,sceneIds=[],requestId,characterId=null,characterIds=null,verified=false}) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id);const old=state.runs.find(r=>r.requestId===requestId);if(old)return old;
            if(state.revision!==revision)throw Error('Lưu và kiểm tra cấu hình mới nhất trước khi tạo.');
            const project=await this.project(id);if(!project.profiles.length)throw Error('Chọn profile cho project trong Gen trước.');
            if(this.tasks.has(id))throw Error('Lượt trước đang chuẩn bị.');
            const targetCharIds = Array.isArray(characterIds) && characterIds.length ? characterIds : (characterId ? [characterId] : []);
            if(!targetCharIds.length&&sceneIds.length>4&&!verified)throw Error('Xác nhận đã kiểm tra nhân vật và ảnh tham chiếu trước khi chuẩn bị hơn 4 cảnh.');
            if(project.jobs.some(j=>['PROCESSING','QUEUED'].includes(j.status)))throw Error('Chờ hoặc dừng lượt Gen đang chạy trước khi thêm bộ ảnh.');
            let rows;
            if(targetCharIds.length){
                rows = targetCharIds.map(charId => {
                    const c=state.config.characters.find(item=>item.id===charId);
                    if(!c) throw Error(`Không tìm thấy nhân vật ${charId}.`);
                    if(!c?.description.trim())throw Error(`Nhập mô tả cho nhân vật ${c.name||c.id} trước.`);
                    const images=[];if(c.asset)images.push({path:this.assetPath(id,c.asset),role:'character'});if(state.config.styleAsset)images.push({path:this.assetPath(id,state.config.styleAsset),role:'style'});
                    if(images.length>state.config.maxReferences)throw Error(`Nhân vật ${c.name||c.id} vượt số ảnh tham chiếu đã chọn.`);
                    return {scene:{scene_id:'CHAR_'+c.id},images,prompt:buildCharacterSheetPrompt(c,state.config.style,project.aspectRatio,!!state.config.styleAsset)};
                });
            }else{
                const preview=await this.preview(id,state.config);rows=preview.rows.filter(r=>sceneIds.includes(r.scene.scene_id));
                if(!rows.length||rows.length!==sceneIds.length||rows.some(r=>!r.ready||r.error))throw Error('Cảnh được chọn thiếu ảnh hoặc không hợp lệ. Kiểm tra lại trước.');
            }
            for(const row of rows)for(const img of row.images)await stat(img.path);
            const runId=randomUUID();const run={id:runId,requestId,characterId:targetCharIds.length===1?targetCharIds[0]:null,characterIds:targetCharIds.length>0?targetCharIds:undefined,status:'PREPARING',createdAt:new Date().toISOString(),config:structuredClone(state.config),model:project.imageModelKey||'GEM_PIX_2',profileIds:project.profiles.map(p=>p.profileId),aspectRatio:project.aspectRatio,rows:rows.map(r=>({sceneId:r.scene.scene_id,prompt:`Manga run ${runId} / ${r.scene.scene_id}. Do not render this identifier as text.\n${r.prompt}`,images:r.images}))};
            state.runs.push(run);await this.write(id,state);
            // Keep lock across uploads and submission; return promptly to the UI.
            this.tasks.add(id);
            setTimeout(()=>{void this.prepare(id,runId).catch(()=>{}).finally(()=>this.tasks.delete(id));},0);
            return run;
        });
    }
    async prepare(id,runId) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id),run=state.runs.find(r=>r.id===runId);
            try{
                await this.service.ensureVeo3Projects(id);let project=await this.project(id);
                if(project.profiles.some(p=>!p.veo3ProjectId))throw Error('Profile chưa sẵn sàng trong Flow. Kiểm tra đăng nhập.');
                const references=[],cache=new Map();
                for(const row of run.rows){const slots=[];for(const image of row.images){const slot={};for(const profileId of run.profileIds){const key=profileId+'|'+image.path;if(!cache.has(key)){const uploaded=await this.service.uploadImageAndGetMediaId(image.path,profileId,run.aspectRatio,id);if(!uploaded.mediaId)throw Error('Upload ảnh không trả media ID.');cache.set(key,uploaded.mediaId);}slot[profileId]=cache.get(key);}slots.push(slot);}references.push(slots);}
                project=await this.project(id);
                if(JSON.stringify(project.profiles.map(p=>p.profileId))!==JSON.stringify(run.profileIds)||(project.imageModelKey||'GEM_PIX_2')!==run.model||project.aspectRatio!==run.aspectRatio)throw Error('Profile/model/tỷ lệ đã thay đổi trong khi chuẩn bị. Tạo lượt mới.');
                if(project.jobs.some(j=>j.prompt.startsWith(`Manga run ${run.id} / `)))throw Error('Đã có job của lượt này. Tải lại để kiểm tra.');
                await this.service.submitStoryboardImageBatch(id,run.rows.map(r=>r.prompt),run.aspectRatio,references,true,1);
                run.status='READY';
            }catch(error){run.status='FAILED';run.error=error.message;}
            await this.write(id,state);
        });
    }
    async approve(id,jobId,characterId) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id),project=await this.project(id);const run=state.runs.find(r=>r.rows.some(row=>project.jobs.some(j=>j.id===jobId&&j.prompt===row.prompt)));
            const job=project.jobs.find(j=>j.id===jobId);if(!run||job?.status!=='COMPLETED'||!job.resultUrl)throw Error('Ảnh chưa hoàn thành hoặc không thuộc bộ này.');
            const row=run.rows.find(r=>r.prompt===job.prompt);
            let characterTarget=null;
            if(characterId){
                const isCharMatch = run.characterId===characterId || (Array.isArray(run.characterIds)&&run.characterIds.includes(characterId)) || row?.sceneId==='CHAR_'+characterId;
                if(!isCharMatch)throw Error('Ảnh không thuộc nhân vật được chọn.');
                characterTarget=state.config.characters.find(c=>c.id===characterId);
                if(!characterTarget){
                    const snapshot=run.config?.characters?.find(c=>c.id===characterId);
                    characterTarget=state.config.characters.find(c=>c.id===snapshot?.name);
                }
                if(!characterTarget)throw Error('Ảnh không thuộc nhân vật được chọn.');
            }
            const dest=path.join(this.dir(id),'approved',randomUUID()+'.png');await mkdir(path.dirname(dest),{recursive:true});
            if(/^(https?:\/\/|file:\/\/)/.test(job.resultUrl))await this.download(job.resultUrl,dest);else await copyFile(job.resultUrl,dest);
            const {asset}=await this.importAsset(id,dest);
            if(characterTarget){characterTarget.asset=asset;state.revision++;}else state.approved[row.sceneId]={jobId,asset,runId:run.id};
            await this.write(id,state);return {asset,revision:state.revision};
        });
    }
    async start(id,runId) {
        return this.exclusive(id,async()=>{
            const state=await this.read(id),project=await this.project(id),run=state.runs.find(r=>r.id===runId);
            if(!run||run.status!=='READY')throw Error('Lượt chưa sẵn sàng.');
            if(project.jobs.some(j=>j.status==='DRAFT'&&!run.rows.some(r=>r.prompt===j.prompt)))throw Error('Gen còn job chờ khác. Chạy/xử lý chúng ở danh sách Gen trước để không chạy nhầm.');
            if(!project.jobs.some(j=>j.status==='DRAFT'&&run.rows.some(r=>r.prompt===j.prompt)))throw Error('Lượt này đã chạy hoặc không còn job chờ.');
            if((project.imageModelKey||'GEM_PIX_2')!==run.model||project.aspectRatio!==run.aspectRatio||JSON.stringify(project.profiles.map(p=>p.profileId))!==JSON.stringify(run.profileIds))throw Error('Cấu hình Gen đã đổi. Khôi phục model/profile/tỷ lệ của lượt hoặc chuẩn bị lượt mới.');
            await this.service.startGeneration(id,project.concurrency,project.delaySeconds,project.videoModelKey,project.batchSize,run.model);
            return {started:true};
        });
    }
}
