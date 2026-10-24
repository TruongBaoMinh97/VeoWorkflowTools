import { z } from 'zod';
import { promptRewriteService } from './promptRewrite.service.js';
export async function registerPromptRewriteRoutes(app) {
    const base='/api/gen-normal/projects/:projectId/prompt-rewrite';
    const params=req=>z.object({projectId:z.string().min(1),id:z.string().optional()}).parse(req.params);
    app.post(base,async req=>promptRewriteService.start(params(req).projectId));
    app.get(base+'/:id',async req=>{const p=params(req);return promptRewriteService.get(p.projectId,p.id);});
    app.post(base+'/:id/apply',async req=>{
        const p=params(req);
        const body=z.object({prompts:z.array(z.object({id:z.string(),prompt:z.string().trim().min(1).max(30000)})).min(1).max(500)}).parse(req.body);
        return promptRewriteService.apply(p.projectId,p.id,body.prompts);
    });
    app.delete(base+'/:id',async req=>{const p=params(req);return promptRewriteService.discard(p.projectId,p.id);});
}
