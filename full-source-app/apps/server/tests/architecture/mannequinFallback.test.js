import { describe, it, expect, vi } from 'vitest';
import { generateWithMannequinFallback, MANNEQUIN_PROMPT } from '../../src/modules/workflow/lib/mannequinFallback.js';
const images = [{ referenceRole:'garment',mediaId:'dress' }, { referenceRole:'model',mediaId:'person' }, {referenceRole:'pose',mediaId:'pose'}];
const run = generate => generateWithMannequinFallback({enabled:true,images,count:4,generate});
describe('product-only mannequin alternative',()=>{
 it('changes the actual request and removes human references after a clothing refusal',async()=>{
  const generate=vi.fn().mockRejectedValueOnce(new Error('PUBLIC_ERROR_SEXUAL')).mockResolvedValueOnce([{name:'result'}]);
  const result=await run(generate);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1][0]).toHaveLength(4);
  expect(generate.mock.calls[1][0][0]).toEqual({prompt:MANNEQUIN_PROMPT,referenceImageMediaIds:['dress']});
  expect(result.fallbackPrompt).toContain('NEW CAMERA ANGLE');
  expect(result.fallbackPrompt).toContain('NEW BACKGROUND');
 });
 it('keeps successful requests unchanged and ignores network/unrelated policy failures',async()=>{
  const success=vi.fn().mockResolvedValue(['image']);expect(await run(success)).toEqual({results:['image']});expect(success).toHaveBeenCalledTimes(1);
  for(const message of ['fetch failed','PUBLIC_ERROR_VIOLENCE','PUBLIC_ERROR_HIGH_TRAFFIC']){
   const generate=vi.fn().mockRejectedValue(new Error(message));await expect(run(generate)).rejects.toThrow(message);expect(generate).toHaveBeenCalledTimes(1);
  }
 });
 it('falls back to a mannequin after a child-reference rejection',async()=>{
  const generate=vi.fn().mockRejectedValueOnce(new Error('PUBLIC_ERROR_MINOR_UPLOAD')).mockResolvedValueOnce([{name:'mannequin-result'}]);
  const result=await run(generate);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1][0][0]).toEqual({prompt:MANNEQUIN_PROMPT,referenceImageMediaIds:['dress']});
  expect(result).toMatchObject({results:[{name:'mannequin-result'}],fallbackPrompt:MANNEQUIN_PROMPT});
 });
 it('stops after one failed alternative instead of restarting the model branch',async()=>{
  const generate=vi.fn().mockRejectedValue(new Error('PUBLIC_ERROR_SEXUAL'));
  await expect(run(generate)).rejects.toMatchObject({name:'NonRetryableNodeError',code:'CONTENT_REVIEW_REQUIRED'});expect(generate).toHaveBeenCalledTimes(2);
 });
 it('requires opt-in, garment references, and respects cancellation',async()=>{
  for(const extra of [{enabled:false},{isCancelled:()=>true},{images:images.slice(1)}]){
   const generate=vi.fn().mockRejectedValue(new Error('PUBLIC_ERROR_SEXUAL'));
   await expect(generateWithMannequinFallback({enabled:true,images,count:1,generate,...extra})).rejects.toThrow();expect(generate).toHaveBeenCalledTimes(1);
  }
 });
});
