/**
 * Script Writer Service
 * Uses Gemini AI for script rewriting, idea expansion, and scene segmentation
 */
import { geminiApiService } from '../geminiApi/geminiApi.service.js';
import { logger } from '../../lib/logger.js';
class ScriptWriterService {
    /**
     * Expand a brief idea into a full screenplay
     */
    async expandIdea(idea, options = {}) {
        const targetMinutes = options.targetMinutes || 10;
        const style = options.style || 'cinematic';
        const prompt = `Bạn là biên kịch chuyên nghiệp. Hãy mở rộng ý tưởng sau thành kịch bản video chi tiết.

Ý tưởng: ${idea}

Yêu cầu:
- Thời lượng mục tiêu: ~${targetMinutes} phút
- Phong cách: ${style}
- Chia thành các SCENE rõ ràng, mỗi scene bắt đầu bằng "## SCENE X:"
- Mỗi scene gồm: mô tả hình ảnh (visual description), lời thoại/narration, hành động
- Mô tả visual phải đủ chi tiết để tạo hình ảnh AI
- Viết bằng tiếng Việt

Định dạng:
## SCENE 1: [Tên scene]
**Visual**: [Mô tả hình ảnh chi tiết cho AI gen]
**Narration**: [Lời kể/thoại]
**Duration**: [Thời lượng ước tính, VD: 8s]

## SCENE 2: ...`;
        const result = await geminiApiService.generate({ prompt, maxTokens: 8000 });
        if (!result.success || !result.text) {
            throw new Error(result.error || 'Failed to expand idea');
        }
        const sceneCount = (result.text.match(/## SCENE \d+/g) || []).length;
        logger.info(`[ScriptWriter] Expanded idea into ${sceneCount} scenes`);
        return { screenplay: result.text, sceneCount };
    }
    /**
     * Rewrite/enhance an existing script
     */
    async rewriteScript(script, options = {}) {
        const style = options.style || 'cinematic';
        const prompt = `Bạn là biên kịch chuyên nghiệp. Hãy viết lại kịch bản sau để cải thiện chất lượng.

Kịch bản gốc:
${script}

Yêu cầu:
- Phong cách: ${style}
- Cải thiện đối thoại tự nhiên hơn
- Thêm mô tả visual chi tiết cho mỗi cảnh (để AI có thể gen hình ảnh)
- Cải thiện nhịp điệu và cấu trúc kịch bản
- Giữ nguyên nội dung chính và thông điệp
- Chia thành các SCENE rõ ràng
- Viết bằng tiếng Việt

Định dạng output giống expandIdea: mỗi scene bắt đầu bằng "## SCENE X:" với Visual, Narration, Duration.`;
        const result = await geminiApiService.generate({ prompt, maxTokens: 8000 });
        if (!result.success || !result.text) {
            throw new Error(result.error || 'Failed to rewrite script');
        }
        return { originalScript: script, rewrittenScript: result.text };
    }
    /**
     * Segment a script/screenplay into timed scenes
     */
    async segmentScript(script, options = {}) {
        const targetDuration = options.targetDuration || 8;
        // Truncate script to avoid token overflow - use first 4000 chars
        const truncatedScript = script.substring(0, 4000);
        const estimatedScenes = Math.max(5, Math.min(30, Math.ceil(truncatedScript.length / 300)));
        const prompt = `Split this script into ${estimatedScenes} scenes (each ~${targetDuration}s).

SCRIPT:
"""
${truncatedScript}
"""

OUTPUT FORMAT: Return ONLY a JSON array like this example:
[{"index":0,"text":"Scene text","visualDescription":"English cinematic description","duration":${targetDuration},"narration":"Narration"}]

RULES:
- Return VALID JSON array ONLY. No markdown. No \`\`\`. No explanation before or after.
- "visualDescription" in ENGLISH: cinematic, include setting, lighting, camera, action
- "text" in original script language
- Each scene ~${targetDuration} seconds
- ${estimatedScenes} scenes total`;
        // Retry up to 3 times
        let segments = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = await geminiApiService.generate({ prompt, maxTokens: 6000 });
            if (!result.success || !result.text) {
                logger.warn(`[ScriptWriter] segmentScript attempt ${attempt + 1} failed: ${result.error}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw new Error(result.error || 'Failed to segment script');
            }
            // Robust JSON extraction
            let cleaned = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                logger.warn(`[ScriptWriter] segmentScript attempt ${attempt + 1}: no JSON array found. Response preview: ${cleaned.substring(0, 200)}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw new Error('Failed to parse segments from AI response');
            }
            try {
                // Fix trailing commas
                let jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
                segments = JSON.parse(jsonStr);
                break;
            }
            catch (e) {
                logger.warn(`[ScriptWriter] segmentScript attempt ${attempt + 1}: JSON parse error: ${e.message}`);
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw new Error(`Failed to parse segments JSON: ${e.message}`);
            }
        }
        // Assign timing
        let currentTime = 0;
        for (const seg of segments) {
            seg.start = currentTime;
            seg.end = currentTime + (seg.duration || targetDuration);
            currentTime = seg.end;
        }
        logger.info(`[ScriptWriter] Segmented script into ${segments.length} segments`);
        return { segments };
    }
}
export const scriptWriterService = new ScriptWriterService();
