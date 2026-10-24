/**
 * Shared subtitle layout: wrapping and time-slicing.
 *
 * Pure/synchronous — no filesystem, no FFmpeg, no FableCut dependencies. Both
 * subtitle paths (FFmpeg burn-in SRT and FableCut text clips) consume the cues
 * this module produces, so "max N lines on screen" is enforced in exactly one
 * place and stays identical across paths.
 */
export const DEFAULT_SUBTITLE_CONFIG = {
    enabled: false,
    maxLines: 2,
    fontSize: 52,
    textColor: '#ffffff',
    outline: true,
    outlineWidth: 3,
    outlineColor: '#000000',
    background: true,
    backgroundColor: '#000000',
    backgroundOpacity: 0.62,
    position: 'bottom',
    sideMargin: 6,
    maxCharsPerCue: 45,
};
const MIN_CUE_DURATION = 0.3; // seconds
const BOX_PADDING_PX = 40; // horizontal breathing room reserved for the box/pill
const AVG_GLYPH_RATIO = 0.55; // avg Latin glyph width as a fraction of font size
const CJK_WIDTH_RATIO = 0.55; // CJK glyphs are ~2x wide → fewer per line
const MIN_CHARS_PER_LINE = 10;
const MAX_CHARS_PER_LINE = 60;
function hasCJK(text) {
    return /[　-鿿가-힯豈-﫿]/.test(text);
}
function computeCharsPerLine(videoWidth, cfg) {
    const usable = videoWidth * (1 - (2 * cfg.sideMargin) / 100) - BOX_PADDING_PX;
    const avgGlyph = cfg.fontSize * AVG_GLYPH_RATIO;
    const raw = Math.floor(usable / avgGlyph);
    return Math.max(MIN_CHARS_PER_LINE, Math.min(MAX_CHARS_PER_LINE, raw));
}
function greedyWrap(text, charsPerLine, cjk) {
    if (!text)
        return [];
    if (cjk) {
        // Character-level wrap; spread handles surrogate pairs correctly.
        const chars = [...text];
        const lines = [];
        for (let i = 0; i < chars.length; i += charsPerLine) {
            lines.push(chars.slice(i, i + charsPerLine).join(''));
        }
        return lines;
    }
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= charsPerLine) {
            current = candidate;
            continue;
        }
        if (current)
            lines.push(current);
        if (word.length > charsPerLine) {
            // Force-break an oversized single word (long URL, no-break string).
            let rem = word;
            while (rem.length > charsPerLine) {
                lines.push(rem.slice(0, charsPerLine));
                rem = rem.slice(charsPerLine);
            }
            current = rem;
        }
        else {
            current = word;
        }
    }
    if (current)
        lines.push(current);
    return lines;
}
/**
 * Wrap a single Whisper segment into cues of at most `cfg.maxLines` lines each.
 *
 * When the wrapped text exceeds `maxLines`, the segment is split into sequential
 * cues, time-sliced proportionally to each chunk's character count. Text is
 * never dropped; empty/whitespace segments return an empty array.
 *
 * @param seg        Whisper segment (start/end in seconds, raw text).
 * @param cfg        Full SubtitleConfig — merge with DEFAULT_SUBTITLE_CONFIG first.
 * @param videoWidth Canvas width in pixels (drives the chars-per-line heuristic).
 */
export function wrapAndSplit(seg, cfg, videoWidth) {
    const text = seg.text.trim();
    if (!text)
        return [];
    const cjk = hasCJK(text);
    const baseCpl = computeCharsPerLine(videoWidth, cfg);
    const widthCpl = cjk ? Math.max(MIN_CHARS_PER_LINE, Math.floor(baseCpl * CJK_WIDTH_RATIO)) : baseCpl;
    // Cap per-line width so that `maxLines` lines fit within the per-cue budget.
    // Capping at the full budget instead would let one line consume it entirely,
    // collapsing every cue to a single line.
    const cueLineBudget = Math.floor(cfg.maxCharsPerCue / cfg.maxLines);
    const charsPerLine = Math.max(MIN_CHARS_PER_LINE, Math.min(widthCpl, cueLineBudget));
    const allLines = greedyWrap(text, charsPerLine, cjk);
    const maxLines = cfg.maxLines;
    // Group wrapped lines into cues bounded by BOTH maxLines and maxCharsPerCue,
    // so a long segment becomes several short cues that flip in sequence.
    const chunks = [];
    let current = [];
    let currentChars = 0;
    for (const line of allLines) {
        const fits = current.length < maxLines && (current.length === 0 || currentChars + line.length <= cfg.maxCharsPerCue);
        if (fits) {
            current.push(line);
            currentChars += line.length;
        }
        else {
            chunks.push(current);
            current = [line];
            currentChars = line.length;
        }
    }
    if (current.length > 0)
        chunks.push(current);
    if (chunks.length <= 1) {
        return [{ start: seg.start, end: Math.max(seg.end, seg.start + MIN_CUE_DURATION), lines: allLines }];
    }
    const totalChars = allLines.reduce((sum, line) => sum + line.length, 0);
    const segDuration = Math.max(MIN_CUE_DURATION * chunks.length, seg.end - seg.start);
    const cues = [];
    let cursor = seg.start;
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunkChars = chunks[ci].reduce((sum, line) => sum + line.length, 0);
        const fraction = totalChars > 0 ? chunkChars / totalChars : 1 / chunks.length;
        const clampedDur = Math.max(MIN_CUE_DURATION, segDuration * fraction);
        let end;
        if (ci === chunks.length - 1) {
            // Last cue snaps to seg.end, but never inverts if per-chunk MIN_CUE
            // clamping already pushed the cursor past seg.end.
            end = Math.max(seg.end, cursor + MIN_CUE_DURATION);
        }
        else {
            // Reserve at least MIN_CUE_DURATION for each remaining cue so the cursor
            // can never overrun seg.end before the final chunk.
            const remaining = chunks.length - ci - 1;
            const maxEnd = seg.end - MIN_CUE_DURATION * remaining;
            const proportionalEnd = Math.round((cursor + clampedDur) * 1000) / 1000;
            end = Math.max(cursor + MIN_CUE_DURATION, Math.min(proportionalEnd, maxEnd));
        }
        cues.push({ start: cursor, end, lines: chunks[ci] });
        cursor = end;
    }
    return cues;
}
