/**
 * Builds a FableCut `project.json` document from a doodle project's timeline.
 *
 * The audio-sync invariant is preserved for free: each shot clip is placed on V1
 * at `start = segment.start` (the Whisper timing), and the narration sits on A1
 * at `start = 0`. FableCut's compositor then plays everything against that clock,
 * so the prefilled timeline already matches the narration before the user edits.
 *
 * Pure/synchronous — no filesystem or network. The media files are copied into
 * FableCut's media dir separately (see DoodleVideoService.prepareFablecut).
 */
import { DEFAULT_SUBTITLE_CONFIG, wrapAndSplit } from './subtitleLayout.js';
const MIN_CLIP_SECONDS = 0.5;
const KEN_BURNS_ZOOM = 1.12;
function dimensions(aspectRatio) {
    return aspectRatio === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}
/** Duration a shot occupies: span to the next segment's start (owns VAD silence gaps). */
function shotDuration(segments, i) {
    const seg = segments[i];
    const next = segments[i + 1];
    const span = next ? next.start - seg.start : seg.end - seg.start;
    return Math.max(MIN_CLIP_SECONDS, span);
}
export function buildFablecutProject(input) {
    const { title, aspectRatio, outputType, audioFilename, audioDuration, shotFilenames, segments, settings } = input;
    const { width, height } = dimensions(aspectRatio);
    const clipKind = outputType === 'IMAGE' ? 'image' : 'video';
    const hasTransition = settings.transitionType !== 'none';
    const n = shotFilenames.length;
    const media = shotFilenames.map((filename, i) => ({
        id: `m_shot_${i}`,
        name: filename,
        kind: clipKind,
        src: `/media/${encodeURIComponent(filename)}`,
        duration: shotDuration(segments, i),
        width,
        height,
    }));
    media.push({
        id: 'm_audio',
        name: audioFilename,
        kind: 'audio',
        src: `/media/${encodeURIComponent(audioFilename)}`,
        duration: audioDuration,
    });
    const clips = [];
    for (let i = 0; i < n; i++) {
        const seg = segments[i];
        const duration = shotDuration(segments, i);
        const clip = {
            id: `c_shot_${i}`,
            mediaId: `m_shot_${i}`,
            kind: clipKind,
            track: 'V1',
            start: seg.start, // Whisper timing — master clock preserved
            in: 0,
            duration,
            name: `Shot ${i + 1}`,
            props: {},
        };
        // Ken Burns: a slow scale push, only meaningful on still images.
        if (settings.kenBurns && outputType === 'IMAGE') {
            clip.keyframes = {
                scale: [
                    { t: 0, v: 1 },
                    { t: duration, v: KEN_BURNS_ZOOM, ease: 'linear' },
                ],
            };
        }
        if (hasTransition && i > 0) {
            clip.transitionIn = { type: settings.transitionType, duration: settings.transitionDuration };
        }
        if (hasTransition && i < n - 1) {
            clip.transitionOut = { type: settings.transitionType, duration: settings.transitionDuration };
        }
        clips.push(clip);
        const subtitleConfig = settings.subtitleConfig ?? DEFAULT_SUBTITLE_CONFIG;
        if (settings.includeSubtitles && subtitleConfig.enabled && seg.text?.trim()) {
            // FableCut positions text as an offset from the canvas centre (cy = H/2 + y),
            // so bottom captions are a POSITIVE downward offset (not an absolute y).
            const yOffset = subtitleConfig.position === 'center'
                ? 0
                : subtitleConfig.position === 'top'
                    ? -Math.round(height * 0.34)
                    : Math.round(height * 0.34);
            const cues = wrapAndSplit({ start: seg.start, end: seg.end, text: seg.text }, subtitleConfig, width);
            for (let ci = 0; ci < cues.length; ci++) {
                const cue = cues[ci];
                clips.push({
                    id: `c_sub_${i}_${ci}`,
                    mediaId: null,
                    kind: 'text',
                    track: 'V2',
                    start: cue.start,
                    in: 0,
                    duration: Math.max(MIN_CLIP_SECONDS, cue.end - cue.start),
                    name: `Sub ${i + 1}${cues.length > 1 ? `.${ci + 1}` : ''}`,
                    props: {
                        text: cue.lines.join('\n'),
                        fontSize: subtitleConfig.fontSize,
                        color: subtitleConfig.textColor,
                        strokeWidth: subtitleConfig.outline ? subtitleConfig.outlineWidth : 0,
                        strokeColor: subtitleConfig.outlineColor,
                        bgColor: subtitleConfig.backgroundColor,
                        bgOpacity: subtitleConfig.background ? subtitleConfig.backgroundOpacity : 0,
                        align: 'center',
                        // FableCut lineHeight is a MULTIPLIER (clamped 0.6–3, default 1.2);
                        // keep it tight so a 2-line caption sits close together.
                        lineHeight: 1.1,
                        y: yOffset,
                        textAnim: 'fade',
                    },
                });
            }
        }
    }
    clips.push({
        id: 'c_audio',
        mediaId: 'm_audio',
        kind: 'audio',
        track: 'A1',
        start: 0,
        in: 0,
        duration: audioDuration,
        name: 'Narration',
        props: { volume: 1 },
    });
    return {
        name: title || 'Doodle Video',
        width,
        height,
        fps: settings.fps,
        background: '#ffffff',
        revision: 1,
        markers: [],
        media,
        clips,
    };
}
