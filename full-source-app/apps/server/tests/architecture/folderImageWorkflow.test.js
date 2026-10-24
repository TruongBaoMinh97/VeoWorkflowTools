import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanImageFolder } from '../../src/modules/workflow/lib/folderInputs.js';
import { imageDataUrl, imagePaths } from '../../src/modules/workflow/lib/imageInputs.js';
import { saveMediaBundle } from '../../src/modules/workflow/lib/saveMedia.js';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
import { aiPromptExecutor } from '../../src/modules/workflow/nodes/aiPromptExecutor.js';
import { createDefaultNodeExecutorRegistry } from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';
import { beeknoeePromptClient, BeeknoeePromptClient } from '../../src/integrations/ai/BeeknoeePromptClient.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const folders = [];
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-folder-test-')); folders.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('folder image workflow', () => {
    it('groups files and subfolders deterministically without mixing products', async () => {
        const dir = await temp();
        await writeFile(path.join(dir, '10.png'), png); await writeFile(path.join(dir, '2.png'), png);
        await mkdir(path.join(dir, 'dress')); await writeFile(path.join(dir, 'dress', 'front.png'), png);
        await writeFile(path.join(dir, 'dress', 'back.png'), png); await writeFile(path.join(dir, 'ignore.txt'), 'x');
        const flat = await scanImageFolder(dir);
        expect(flat.products.map(p => p.productId)).toEqual(['2.png', '10.png']);
        const grouped = await scanImageFolder(dir, 'subfolders');
        expect(grouped.products).toHaveLength(1); expect(grouped.products[0].paths).toHaveLength(2);
        expect(imagePaths(JSON.stringify(grouped.products[0].paths))).toEqual(grouped.products[0].paths);
    });
    it('rejects oversized groups instead of silently dropping references', async () => {
        const dir = await temp(); await mkdir(path.join(dir, 'dress'));
        for (let i=0;i<9;i++) await writeFile(path.join(dir,'dress',`${i}.png`),png);
        await expect(scanImageFolder(dir, 'subfolders')).rejects.toThrow(/8/);
    });
    it('creates a separate job per color image inside product folders, including more than eight images', async () => {
        const dir = await temp();
        await mkdir(path.join(dir,'dress-a')); await mkdir(path.join(dir,'dress-b'));
        for (let i=1;i<=10;i++) await writeFile(path.join(dir,'dress-a',`${i}.png`),png);
        await writeFile(path.join(dir,'dress-b','1.png'),png);
        await writeFile(path.join(dir,'root.png'),png);
        const scan = await scanImageFolder(dir,'product-images');
        expect(scan.products).toHaveLength(11);
        expect(scan.products.every(product=>product.paths.length===1)).toBe(true);
        expect(scan.products[0].productId).toBe('dress-a/1.png');
        expect(scan.products[9].productId).toBe('dress-a/10.png');
        expect(scan.products[10].productId).toBe('dress-b/1.png');
        expect(new Set(scan.products.map(product=>product.productId)).size).toBe(11);
    });
    it('rejects disguised non-image files before provider calls', async () => {
        const dir = await temp(), file = path.join(dir, 'bad.png'); await writeFile(file,'not an image');
        await expect(imageDataUrl(file)).rejects.toMatchObject({ code: 'IMAGE_FORMAT_INVALID' });
    });
    it('uploads every product reference and sends actual images plus role labels to AI', async () => {
        const dir = await temp(), file = path.join(dir, 'front.png'); await writeFile(file,png);
        const complete = vi.spyOn(beeknoeePromptClient,'complete').mockResolvedValue('Preserve the original dress.');
        const provider = { uploadImageAndExtractMediaId: vi.fn().mockResolvedValue('media') };
        const registry = createDefaultNodeExecutorRegistry();
        const upload = await registry.execute('upload-image', { data: { localPaths: [file], referenceRole: 'garment' }, resolved: { imageResults: [] }, provider, projectId:'p' });
        const result = await aiPromptExecutor.execute({ data: { model:'vision-model', systemMessage:'Master rules' }, resolved: { promptTexts: [], imageResults:upload.results } });
        expect(provider.uploadImageAndExtractMediaId).toHaveBeenCalledWith(file,'p');
        expect(result.textValue).toContain('original dress');
        const request = complete.mock.calls[0][0];
        expect(request.messages[0]).toEqual({ role:'system',content:'Master rules' });
        expect(request.messages[1].content).toContainEqual({ type:'text',text:'REFERENCE 1: GARMENT' });
        expect(request.messages[1].content.find(p=>p.type==='image_url').image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`);
        expect(request.maxTokens).toBe(4000);
    });
    it('saves images and prompts into separate product attempts without overwriting', async () => {
        const dir = await temp(), file = path.join(dir,'input.png'); await writeFile(file,png);
        const args = { outputDir: dir, productId:'../dress', results:[{url:`file://${file}`,kind:'image'}],prompts:['exact prompt'] };
        const first = await saveMediaBundle(args), second = await saveMediaBundle(args);
        expect(first[0].savedPath).not.toBe(second[0].savedPath);
        expect(path.relative(dir,first[0].savedPath).startsWith('..')).toBe(false);
        expect(await readFile(first[0].savedPath)).toEqual(png);
        expect(await readFile(path.join(path.dirname(first[0].savedPath),'prompts.txt'),'utf8')).toBe('exact prompt');
        await expect(saveMediaBundle({...args,results:[{kind:'image'}]})).rejects.toThrow(/URL/);
    });
    it('exposes image and save nodes as batch outputs', () => {
        const schema = extractBatchSchema({ nodes: ['generate-image','upscale-image','remove-image-logo','save-images'].map((type,i)=>({id:String(i),type,data:{batchRole:'output'}})) });
        expect(schema.outputs).toHaveLength(4);
    });
    it('groups colors from one source product folder and separates different products in the same batch', async () => {
        const dir = await temp(), file = path.join(dir,'input.png'); await writeFile(file,png);
        const args = {outputDir:dir,batchId:'one-batch',results:[{url:`file://${file}`,kind:'image'}],productGroup:{name:'Dress A',key:'/source/Dress A'}};
        const [red,blue,other] = await Promise.all([
            saveMediaBundle({...args,productId:'red'}),saveMediaBundle({...args,productId:'blue'}),
            saveMediaBundle({...args,productId:'red',productGroup:{name:'Dress B',key:'/source/Dress B'}})
        ]);
        const a=path.dirname(red[0].savedPath),b=path.dirname(blue[0].savedPath),c=path.dirname(other[0].savedPath);
        expect(a).toBe(b);expect(c).not.toBe(a);expect(path.dirname(a)).toBe(path.dirname(c));
        expect(path.basename(a)).toMatch(/^Dress A_/);
        const entries=await readdir(a,{withFileTypes:true});expect(entries.every(entry=>entry.isFile())).toBe(true);
        expect(entries.filter(entry=>entry.name.endsWith('.png'))).toHaveLength(2);
        const sameName=await saveMediaBundle({...args,productId:'red',productGroup:{name:'Dress A',key:'/other/Dress A'}});
        expect(path.dirname(sameName[0].savedPath)).not.toBe(a);
    });
    it('saves concurrent batch products and retries in one folder with unique files and separates other batches', async () => {
        const dir = await temp(), file = path.join(dir, 'input.png'); await writeFile(file, png);
        const args = { outputDir: dir, batchId: 'batch/one', productId: 'row_001_dress', results: [{url:`file://${file}`,kind:'image'}], prompts:['catalog prompt'] };
        const [a,b,c] = await Promise.all([saveMediaBundle(args), saveMediaBundle({...args,productId:'row_002_dress'}), saveMediaBundle(args)]);
        const files = [a,b,c].map(result => result[0].savedPath);
        expect(new Set(files).size).toBe(3);
        const folder = path.dirname(files[0]);
        expect(files.every(file => path.dirname(file) === folder)).toBe(true);
        expect(path.dirname(folder)).toBe(dir);
        const entries = await readdir(folder, {withFileTypes:true});
        expect(entries.every(entry => entry.isFile())).toBe(true);
        expect(entries.filter(entry => entry.name.endsWith('prompts.txt'))).toHaveLength(3);
        for (const file of files) expect(await readFile(file)).toEqual(png);
        const other = await saveMediaBundle({...args,batchId:'batch_one'});
        expect(path.dirname(other[0].savedPath)).not.toBe(folder);
    });
    it.each([false,true])('rejects truncated AI output (stream=%s) before Flow receives it', async stream => {
        const payload = {choices:[{message:{content:'partial'},delta:{content:'partial'},finish_reason:'length'}]};
        const client = new BeeknoeePromptClient({getApiKey: async()=> 'test',fetchImpl:async()=>new Response(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload))});
        await expect(client.complete({model:'test',messages:[],stream})).rejects.toMatchObject({code:'AI_PROMPT_TRUNCATED',retryable:false});
    });
});
