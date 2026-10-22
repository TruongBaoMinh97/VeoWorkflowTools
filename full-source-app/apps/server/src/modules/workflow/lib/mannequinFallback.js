import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';
import { contentReviewMessage } from './contentReview.js';

export const MANNEQUIN_PROMPT = `Create one non-explicit commercial product catalog photograph of the referenced garment displayed on an obviously artificial, smooth matte ivory retail dress form or mannequin. No real person, face, skin texture, anatomical intimate details or human model. The product, not a body, is the subject.

REFERENCE AND PRODUCT
Use only the supplied GARMENT references for the actual product. Preserve the exact color, neckline, straps/sleeves, silhouette, proportions, length, seams, fastenings, fabric texture and visible embellishments. Remove the original wearer and original setting from the composition. Do not copy a person's identity or pose. Do not add clothing, lining, padding, accessories or decorations. Do not change transparency or opacity; a sheer area reveals only the featureless artificial mannequin surface. Keep the garment's authentic fit and drape.

NEW BACKGROUND
Replace the source background entirely with a clean pale warm-gray studio cyclorama and a subtle floor shadow. If the source already has a similar gray studio, use a muted sage studio wall instead. No original room furniture, bed, bedroom, text, logo or watermark. Use soft even neutral studio light without recoloring the garment.

NEW CAMERA ANGLE
Make a visibly different but modest camera angle: a slight left or right three-quarter offset, approximately 10–15 degrees from the source view, with eye-level product photography and the whole garment/hem visible. Choose the direction supported by the garment references. Never turn a front-only reference into an invented back view or fabricate an unseen fastening. When construction is not visible, use a smaller camera shift and different distance/framing instead of inventing it.

FINAL CHECK
One standalone photograph, not a collage. Clearly artificial retail display, neutral presentation, no suggestive pose. Verify that the background and framing differ from the source while all visible garment details remain faithful. Do not fabricate hidden construction.`;

function eligible(error) {
    const text = [error?.errorText, error?.message, error?.reason, error?.code].filter(Boolean).join(' ');
    // This opt-in clothing alternative may safely replace a rejected child or
    // human presentation with an obviously artificial retail mannequin.
    // Unrelated policy, transport and quota failures remain unchanged.
    if (/PUBLIC_ERROR_(?:VIOLENCE|HATE|HARASSMENT|DANGEROUS|IP_VIOLATION|COPYRIGHT|CELEBRITY|PUBLIC_FIGURE)/i.test(text)) return false;
    return /PUBLIC_ERROR_(?:SEXUAL|UNSAFE_GENERATION|MINOR_UPLOAD)\b|Nội dung bị từ chối: Chứa yếu tố nhạy cảm\/khiêu dâm|vi phạm chính sách an toàn/i.test(text);
}

export async function generateWithMannequinFallback({ enabled, images, count, generate, isCancelled = () => false }) {
    try {
        return { results: await generate(null) };
    } catch (error) {
        if (!enabled || !eligible(error) || isCancelled()) throw error;
        const garmentIds = images.filter(image => image.referenceRole === 'garment').map(image => image.mediaId).filter(Boolean);
        if (!garmentIds.length) throw new NonRetryableNodeError(contentReviewMessage('Thiếu ảnh GARMENT để tạo phương án ma-nơ-canh.'), { code: 'CONTENT_REVIEW_REQUIRED' });
        // A new, materially different product-only request. Never reuse the rejected
        // human-model prompt or MODEL/POSE/BACKGROUND images. One attempt only.
        try {
            const prompts = Array.from({ length: count }, () => ({ prompt: MANNEQUIN_PROMPT, referenceImageMediaIds: garmentIds }));
            const results = await generate(prompts);
            if (!results?.length) throw new Error('Không có ảnh trả về.');
            return { results, fallbackPrompt: MANNEQUIN_PROMPT };
        } catch (fallbackError) {
            if (isCancelled()) throw fallbackError;
            throw new NonRetryableNodeError(contentReviewMessage(`Phương án ma-nơ-canh chưa thành công: ${fallbackError.message || fallbackError}`), { code: 'CONTENT_REVIEW_REQUIRED', cause: fallbackError });
        }
    }
}
