import { logger } from "../lib/logger.js";
/**
 * Veo3 image-gen returns mediaIds in two formats:
 *   - UUID: `9f2c9717-1234-...` (from upload, REST media name)
 *   - CAMa: `CAMSJDE1ZGI4NWQy...` (proto-base64 envelope from batchGenerateImages)
 * Veo3's video gen `referenceImages[].mediaId` and image gen `imageInputs[].name`
 * accept UUID only — sending CAMa triggers 500 INTERNAL. The CAMa proto carries
 * the UUID in field 3 (tag 0x1a, length 0x24=36 bytes).
 */
export function extractUUIDFromMediaId(mediaId) {
    if (!mediaId)
        return "";
    if (!mediaId.startsWith("CAM"))
        return mediaId; // already UUID
    try {
        const buf = Buffer.from(mediaId, "base64");
        const str = buf.toString("binary");
        const idx = str.indexOf("\x1a\x24");
        if (idx >= 0 && idx + 2 + 36 <= str.length) {
            const uuid = str.substring(idx + 2, idx + 2 + 36);
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
                return uuid;
            }
        }
    }
    catch {
        // fall through
    }
    logger.warn(`⚠️ [extractUUID] Could not decode UUID from CAMa: ${mediaId.substring(0, 40)}...`);
    return mediaId;
}
/**
 * Normalize a referenceImages[] entry to the proven-working Flow r2v contract:
 *  - mediaId MUST be a flat UUID. Mixing CAMa + UUID in one request → 500 INTERNAL.
 *  - imageUsageType MUST be present. Flow's reference endpoint rejects a bare
 *    { mediaId } with 500 INTERNAL; the UI always tags references ASSET. Default
 *    it here so every caller (workflow engine included) matches genNormal's
 *    working request shape without each caller repeating the contract.
 */
export function normalizeReferenceImage(ref) {
    // Whitelisted rather than spread: callers that carry extra metadata alongside
    // a reference (named COMPONENTS attaches a `handle`) must not leak it onto the
    // wire — Flow rejects unknown fields in referenceImages[] with 500 INTERNAL.
    return {
        mediaId: extractUUIDFromMediaId(ref?.mediaId),
        imageUsageType: ref?.imageUsageType ?? "IMAGE_USAGE_TYPE_ASSET",
    };
}
