import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageReviewExecutor } from '../../src/modules/workflow/nodes/imageReviewExecutor.js';
import { beeknoeePromptClient } from '../../src/integrations/ai/BeeknoeePromptClient.js';
const source = {url:'https://example.test/source.png',kind:'image'};
const result = {url:'https://example.test/result.png',kind:'image'};
const context = {data:{model:'vision'},resolved:{reviewReferences:[source],reviewCandidates:[result]}};
afterEach(()=>vi.restoreAllMocks());
describe('image review gate',()=>{
    it('passes through only generated images when the review passes',async()=>{
        const complete=vi.spyOn(beeknoeePromptClient,'complete').mockResolvedValue('{"verdict":"pass","notes":"Visible design matches"}');
        const output=await imageReviewExecutor.execute(context);
        expect(output.results).toEqual([result]);
        expect(JSON.parse(output.textValue).verdict).toBe('pass');
        const parts=complete.mock.calls[0][0].messages[0].content;
        expect(parts).toContainEqual({type:'text',text:'ORIGINAL GARMENT'});
        expect(parts).toContainEqual({type:'text',text:'GENERATED RESULT'});
    });
    it('stops downstream saving when discrepancies need human review',async()=>{
        vi.spyOn(beeknoeePromptClient,'complete').mockResolvedValue('{"verdict":"review","notes":"Neckline changed"}');
        await expect(imageReviewExecutor.execute(context)).rejects.toMatchObject({code:'IMAGE_REVIEW_REQUIRED'});
        const output=await imageReviewExecutor.execute({...context,data:{model:'vision',blockOnReview:false}});
        expect(JSON.parse(output.textValue).verdict).toBe('review');
    });
    it('never passes unparseable model output as a successful review',async()=>{
        vi.spyOn(beeknoeePromptClient,'complete').mockResolvedValue('looks fine');
        await expect(imageReviewExecutor.execute(context)).rejects.toMatchObject({code:'REVIEW_RESPONSE_INVALID'});
    });
});
