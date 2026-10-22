import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MangaStoryStore, mangaConfigSchema, MANGA_ROOT } from './mangaStory.js';
import { genNormalRepository } from './genNormal.repository.js';
import { genNormalService } from './genNormal.service.js';
import { getElectronUserDataPath } from '../../lib/electronPaths.js';
import { downloadFile } from '../../utils/fileDownloader.js';
export const mangaStoryStore=new MangaStoryStore({root:MANGA_ROOT,repository:genNormalRepository,service:genNormalService,download:downloadFile});
export async function registerMangaStoryRoutes(app,options={}) {
    const store=options.store||mangaStoryStore;
    const base='/api/gen-normal/projects/:projectId/manga-story';
    const handle=fn=>async(req,reply)=>{try{return await fn(req,reply);}catch(e){return reply.code(400).send({success:false,message:e.message});}};
    app.get(base,handle(req=>store.context(req.params.projectId)));
    app.get(base+'/history',handle(req=>store.history(req.params.projectId)));
    app.put(base,handle(req=>{const b=z.object({revision:z.number().int().min(0),config:mangaConfigSchema}).parse(req.body);return store.save(req.params.projectId,b.config,b.revision);}));
    app.post(base+'/patch',handle(req=>{const b=z.object({revision:z.number().int().min(0),config:mangaConfigSchema.optional(),patchText:z.string().min(1).max(1000000),allowAppend:z.boolean().optional().default(false)}).parse(req.body);return store.patchPrompts(req.params.projectId,b);}));
    app.post(base+'/preview',handle(req=>store.preview(req.params.projectId,mangaConfigSchema.parse(req.body))));
    app.post(base+'/assets',handle(req=>store.importAsset(req.params.projectId,z.object({path:z.string().min(1)}).parse(req.body).path)));
    app.get(base+'/assets/:asset',handle(async(req)=>{await store.project(req.params.projectId);const bytes=await readFile(store.assetPath(req.params.projectId,req.params.asset));const mime=req.params.asset.endsWith('webp')?'image/webp':/\.jpe?g$/.test(req.params.asset)?'image/jpeg':'image/png';return {dataUrl:`data:${mime};base64,${bytes.toString('base64')}`};}));
    app.post(base+'/submit',handle(req=>store.submit(req.params.projectId,z.object({revision:z.number().int(),requestId:z.string().uuid(),sceneIds:z.array(z.string()).max(500).default([]),characterId:z.string().optional(),characterIds:z.array(z.string()).max(100).optional(),verified:z.boolean().default(false)}).parse(req.body))));
    app.post(base+'/approve',handle(req=>{const b=z.object({jobId:z.string().min(1),characterId:z.string().optional()}).parse(req.body);return store.approve(req.params.projectId,b.jobId,b.characterId);}));
    app.post(base+'/adopt',handle(req=>{const b=z.object({sourceProjectId:z.string().min(1),jobId:z.string().min(1),targetCharacterId:z.string().min(1)}).parse(req.body);return store.adopt(req.params.projectId,b);}));
    app.post(base+'/start',handle(req=>store.start(req.params.projectId,z.object({runId:z.string().uuid()}).parse(req.body).runId)));
}
