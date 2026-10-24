/**
 * Named reference-image handles for COMPONENTS ("Thành phần") reference-to-video.
 *
 * A prompt addresses specific uploaded images by name:
 *   "wide shot of @BG-01 with @CHAR-04 on camera-left"
 * Each `@Handle` binds one reference image. Flow caps references per request
 * (3 for Veo r2v, 7 for Omni Flash), so the caller passes `maxRefs`.
 *
 * The renderer mirrors the tokenizer half of this file in
 * `apps/renderer/src/utils/referenceHandles.ts` (plus slug helpers it alone
 * needs). The two workspaces share no package and this repo already duplicates
 * small pure utils across them (see `getJobMode`); keep the tokenizer in sync.
 */
/** Characters allowed inside a handle: ASCII alphanumerics, hyphen, underscore. */
const HANDLE_CHAR_RE = /[A-Za-z0-9\-_]/;
/** Matches a whole `@Handle` mention. Kept separate from the tokenizer scan. */
export const MENTION_RE = /@([A-Za-z0-9\-_]+)/g;
/**
 * Split a prompt into alternating text / reference parts.
 *
 * Scans character-by-character rather than using `MENTION_RE` so a handle token
 * is always consumed greedily: with both `CHAR-1` and `CHAR-10` defined, the
 * text `@CHAR-10` binds `CHAR-10` — a shortest-match or unordered-alternation
 * regex would bind `CHAR-1` and leave a stray `0`.
 *
 * A repeated mention emits a reference part at every position (the model needs
 * the image pinned wherever it is named) but contributes one entry to `bound`,
 * which is what becomes `referenceImages[]`.
 *
 * Unknown handles are left verbatim in the text so the user can still see what
 * they typed; they are reported via `unknown` for the caller to surface.
 */
export function tokenizePrompt(raw, handleMap, maxRefs) {
    const parts = [];
    const bound = [];
    const unknown = [];
    const seen = new Set();
    let index = 0;
    let buffer = "";
    const flush = () => {
        if (buffer) {
            parts.push({ text: buffer });
            buffer = "";
        }
    };
    while (index < raw.length) {
        if (raw[index] !== "@") {
            buffer += raw[index];
            index += 1;
            continue;
        }
        let end = index + 1;
        while (end < raw.length && HANDLE_CHAR_RE.test(raw[end]))
            end += 1;
        const token = raw.slice(index + 1, end);
        // A bare "@" (or "@" followed by punctuation) is ordinary text.
        if (!token) {
            buffer += "@";
            index += 1;
            continue;
        }
        const definition = handleMap.get(token.toLowerCase());
        if (!definition) {
            unknown.push(token);
            buffer += `@${token}`;
            index = end;
            continue;
        }
        flush();
        parts.push({
            reference: {
                media: { mediaId: definition.mediaId, handle: definition.canonical },
            },
        });
        const key = token.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            bound.push(definition.canonical);
        }
        index = end;
    }
    flush();
    return { parts, bound, unknown, overflow: bound.length > maxRefs };
}
/**
 * Enforce the prompt character budget across `parts` without ever touching a
 * reference part — trimming one would drop an image binding entirely. Trailing
 * text parts are shortened (and dropped when emptied) until the budget is met.
 */
export function clampTextParts(parts, maxChars) {
    const textLength = (list) => list.reduce((sum, part) => sum + ("text" in part ? part.text.length : 0), 0);
    if (textLength(parts) <= maxChars)
        return parts;
    const clamped = parts.map((part) => ({ ...part }));
    for (let i = clamped.length - 1; i >= 0; i -= 1) {
        const excess = textLength(clamped) - maxChars;
        if (excess <= 0)
            break;
        const part = clamped[i];
        if (!("text" in part))
            continue;
        part.text = part.text.slice(0, Math.max(0, part.text.length - excess));
    }
    return clamped.filter((part) => !("text" in part) || part.text.length > 0);
}
/**
 * Drop the `@` marker but keep the name: "@BG-01 on the left" → "BG-01 on the
 * left". Used by the flat-prompt path, where the image set is already resolved
 * and the marker would only be noise to the model.
 */
export function stripMentionMarkers(raw) {
    return raw.replace(/@([A-Za-z0-9\-_]+)/g, "$1");
}
/** True when the text contains at least one well-formed `@Handle`. */
export function hasAnyMention(text) {
    return /@[A-Za-z0-9\-_]+/.test(text);
}
/** Build the tokenizer's lookup map from stored `{handle, mediaId}` pairs. */
export function buildHandleMap(handles) {
    const map = new Map();
    for (const entry of handles) {
        if (!entry?.handle || !entry?.mediaId)
            continue;
        map.set(entry.handle.toLowerCase(), {
            canonical: entry.handle,
            mediaId: entry.mediaId,
        });
    }
    return map;
}
