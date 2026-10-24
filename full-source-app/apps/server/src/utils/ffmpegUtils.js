/**
 * FFmpeg Utilities
 * Functions for video processing using ffmpeg
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { resolveFfmpegBinary, resolveFfprobeBinary } from './ffmpegResolver.js';
import { logger } from '../lib/logger.js';
const execAsync = promisify(exec);
// Lazy-initialized resolved binary paths
let _ffmpegBin;
let _ffprobeBin;
function ffmpeg() {
    if (_ffmpegBin === undefined)
        _ffmpegBin = resolveFfmpegBinary();
    return _ffmpegBin ? `"${_ffmpegBin}"` : 'ffmpeg';
}
function ffprobe() {
    if (_ffprobeBin === undefined)
        _ffprobeBin = resolveFfprobeBinary();
    return _ffprobeBin ? `"${_ffprobeBin}"` : 'ffprobe';
}
/**
 * Extract the last frame from a video file
 * @param videoUrl - URL or file path to the video
 * @param outputPath - Path where the frame image should be saved
 * @returns Promise<string> - Path to the extracted frame image
 */
export async function extractLastFrame(videoUrl, outputPath) {
    try {
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        // Get video duration first
        const { stdout: durationOutput } = await execAsync(`${ffprobe()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`);
        const duration = parseFloat(durationOutput.trim());
        if (isNaN(duration) || duration <= 0) {
            throw new Error(`Invalid video duration: ${duration}`);
        }
        // Extract frame at 0.1 seconds before the end (to avoid potential issues with exact end)
        const frameTime = Math.max(0, duration - 0.1);
        // Extract frame using ffmpeg
        // -ss: seek to position
        // -i: input file
        // -vframes 1: extract only 1 frame
        // -q:v 2: high quality JPEG
        const command = `${ffmpeg()} -ss ${frameTime} -i "${videoUrl}" -vframes 1 -q:v 2 "${outputPath}"`;
        logger.info(`🎬 Extracting last frame from video: ${videoUrl}`);
        logger.info(`   Duration: ${duration}s, Frame time: ${frameTime}s`);
        logger.info(`   Output: ${outputPath}`);
        await execAsync(command);
        // Verify output file exists
        if (!fs.existsSync(outputPath)) {
            throw new Error(`Frame extraction failed: output file not found at ${outputPath}`);
        }
        logger.info(`✅ Frame extracted successfully: ${outputPath}`);
        return outputPath;
    }
    catch (error) {
        logger.error(`❌ Error extracting frame from video:`, error);
        throw new Error(`Failed to extract last frame: ${error.message}`);
    }
}
/**
 * Concatenate multiple video files into a single output video using FFmpeg concat demuxer.
 * @param inputPaths - Ordered list of local video file paths
 * @param outputPath - Path for the merged output video
 * @returns Promise<string> - Path to the merged video
 */
export async function concatVideos(inputPaths, outputPath) {
    if (inputPaths.length === 0)
        throw new Error('No input videos provided');
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    // Write a concat list file
    const listPath = path.join(outputDir, `_concat_list_${Date.now()}.txt`);
    const listContent = inputPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');
    try {
        // Use concat demuxer: fast, lossless copy, no re-encode
        const command = `${ffmpeg()} -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
        logger.info(`🎬 Merging ${inputPaths.length} videos → ${outputPath}`);
        await execAsync(command);
        if (!fs.existsSync(outputPath)) {
            throw new Error('Merge failed: output file not found');
        }
        logger.info(`✅ Merge complete: ${outputPath}`);
        return outputPath;
    }
    finally {
        try {
            fs.unlinkSync(listPath);
        }
        catch { }
    }
}
/**
 * Check if ffmpeg is available in the system
 * @returns Promise<boolean>
 */
export async function checkFFmpegAvailable() {
    try {
        await execAsync(`${ffmpeg()} -version`);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Get the duration of a media file (audio or video) in seconds
 */
export async function getMediaDuration(filePath) {
    const { stdout } = await execAsync(`${ffprobe()} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration) || duration <= 0) {
        throw new Error(`Invalid media duration: ${stdout.trim()}`);
    }
    return duration;
}
/**
 * Mute a video (remove audio track, keep video only)
 */
export async function muteVideo(inputPath, outputPath) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    const command = `${ffmpeg()} -y -i "${inputPath}" -c:v copy -an "${outputPath}"`;
    logger.info(`🔇 Muting video: ${inputPath}`);
    await execAsync(command);
    if (!fs.existsSync(outputPath))
        throw new Error('Mute failed: output file not found');
    logger.info(`✅ Muted: ${outputPath}`);
    return outputPath;
}
/**
 * Overlay audio onto a video (replace any existing audio)
 */
export async function overlayAudio(videoPath, audioPath, outputPath, options) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    const shortest = options?.trimToShortest !== false ? '-shortest' : '';
    const volume = options?.audioVolume != null && options.audioVolume !== 1
        ? `[1:a]volume=${options.audioVolume}[aout]" -map 0:v:0 -map "[aout]"`
        : `" -map 0:v:0 -map 1:a:0`;
    // +faststart moves the moov atom to the front so the muxed mp4 streams/previews
    // progressively in a <video> element instead of needing a full download first.
    const faststart = '-movflags +faststart';
    let command;
    if (options?.audioVolume != null && options.audioVolume !== 1) {
        command = `${ffmpeg()} -y -i "${videoPath}" -i "${audioPath}" -filter_complex "[1:a]volume=${options.audioVolume}[aout]" -map 0:v:0 -map "[aout]" -c:v copy ${faststart} ${shortest} "${outputPath}"`;
    }
    else {
        command = `${ffmpeg()} -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v copy ${faststart} ${shortest} "${outputPath}"`;
    }
    logger.info(`🔊 Overlaying audio onto video`);
    await execAsync(command);
    if (!fs.existsSync(outputPath))
        throw new Error('Audio overlay failed: output file not found');
    logger.info(`✅ Audio overlaid: ${outputPath}`);
    return outputPath;
}
/**
 * Mix background music with existing audio in a video
 */
export async function mixBackgroundMusic(videoPath, bgmPath, outputPath, options) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    const bgmVol = options?.bgmVolume ?? 0.2;
    const fadeIn = options?.fadeIn ?? 2;
    const fadeOut = options?.fadeOut ?? 3;
    const loopFlag = options?.loop !== false ? '-stream_loop -1' : '';
    // Get video duration for fade out calculation
    const videoDuration = await getMediaDuration(videoPath);
    const fadeOutStart = Math.max(0, videoDuration - fadeOut);
    // Build BGM filter: volume + fade in + fade out
    const bgmFilter = `[1:a]volume=${bgmVol},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut}[bgm]`;
    const mixFilter = `${bgmFilter};[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    const command = `${ffmpeg()} -y -i "${videoPath}" ${loopFlag} -i "${bgmPath}" -filter_complex "${mixFilter}" -map 0:v:0 -map "[aout]" -c:v copy -shortest "${outputPath}"`;
    logger.info(`🎵 Mixing BGM into video (volume: ${bgmVol})`);
    await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
    if (!fs.existsSync(outputPath))
        throw new Error('BGM mix failed: output file not found');
    logger.info(`✅ BGM mixed: ${outputPath}`);
    return outputPath;
}
/**
 * Burn a subtitle file into a video. Expects a self-describing `.ass` file
 * (see {@link generateASS}) — the ASS carries its own PlayResX/Y and Style, so
 * no `force_style` override is needed and libass renders in real video pixels.
 */
export async function burnSubtitles(videoPath, subtitlePath, outputPath) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    // Escape special characters in the subtitle path for the FFmpeg filter graph
    // (forward slashes + escaped drive colon work on Windows and Unix alike).
    const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const command = `${ffmpeg()} -y -i "${videoPath}" -vf "subtitles='${escapedPath}'" -c:a copy "${outputPath}"`;
    logger.info(`📝 Burning subtitles into video`);
    await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
    if (!fs.existsSync(outputPath))
        throw new Error('Subtitle burn failed: output file not found');
    logger.info(`✅ Subtitles burned: ${outputPath}`);
    return outputPath;
}
/**
 * Generate SRT subtitle content from pre-wrapped cues.
 */
export function generateSRT(cues) {
    return cues
        .filter((cue) => cue.lines.length > 0)
        .map((cue, i) => {
        // Guard against zero-duration cues from float rounding.
        const end = cue.end <= cue.start ? cue.start + 0.1 : cue.end;
        const startTime = formatSRTTime(cue.start);
        const endTime = formatSRTTime(end);
        return `${i + 1}\n${startTime} --> ${endTime}\n${cue.lines.join('\n')}\n`;
    })
        .join('\n');
}
function formatSRTTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
/** ASS timestamp: `H:MM:SS.cc` (centiseconds, no comma). */
function formatASSTime(seconds) {
    const clamped = Math.max(0, seconds);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = Math.floor(clamped % 60);
    const cs = Math.min(99, Math.round((clamped % 1) * 100));
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
/**
 * Escape a subtitle line for the ASS Dialogue Text field. Backslash first so the
 * brace escapes are not themselves re-escaped. Commas need no escaping — Text is
 * the last field on a Dialogue line.
 */
function escapeASSText(raw) {
    return raw
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\n/g, '\\N'); // a stray literal newline would otherwise truncate the Dialogue line
}
const ASS_STYLE_FORMAT = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
    'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
    'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
/**
 * Generate a self-describing ASS subtitle file from pre-wrapped cues.
 *
 * A plain SRT is rendered by libass against its 384×288 default script space,
 * which inflates `FontSize` ~3.75× at 1080p and re-wraps our lines (the "7 lines
 * instead of 2" bug). Declaring `PlayResX/Y` = the real video size makes every
 * unit a video pixel, and `WrapStyle: 2` disables libass auto-wrap — so the
 * ≤maxLines cues from {@link SubtitleCue} render exactly as laid out.
 */
export function generateASS(cues, cfg, videoWidth, videoHeight) {
    const primaryColor = hexToAss(cfg.textColor);
    const outlineColor = hexToAss(cfg.outlineColor);
    const backColor = hexToAssAlpha(cfg.backgroundColor, cfg.backgroundOpacity);
    const alignment = cfg.position === 'top' ? 8 : cfg.position === 'center' ? 5 : 2;
    const borderStyle = cfg.background ? 3 : 1;
    const outline = cfg.outline ? cfg.outlineWidth : 0;
    const marginX = Math.round(videoWidth * (cfg.sideMargin / 100));
    const marginV = Math.round(videoHeight * 0.05);
    const scriptInfo = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${videoWidth}`,
        `PlayResY: ${videoHeight}`,
        'ScaledBorderAndShadow: yes',
        'WrapStyle: 2',
        'Collisions: Normal',
    ].join('\n');
    // 23 fields, matching ASS_STYLE_FORMAT. SecondaryColour is unused (&H000000FF&).
    const styleRow = `Style: Default,Arial,${cfg.fontSize},${primaryColor},&H000000FF&,${outlineColor},${backColor},` +
        `0,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${marginX},${marginX},${marginV},1`;
    const styles = ['[V4+ Styles]', ASS_STYLE_FORMAT, styleRow].join('\n');
    const dialogues = cues
        .filter((cue) => cue.lines.length > 0)
        .map((cue) => {
        const end = cue.end <= cue.start ? cue.start + 0.1 : cue.end;
        const text = cue.lines.map(escapeASSText).join('\\N');
        return `Dialogue: 0,${formatASSTime(cue.start)},${formatASSTime(end)},Default,,0,0,0,,${text}`;
    });
    const events = [
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...dialogues,
    ].join('\n');
    return `${scriptInfo}\n\n${styles}\n\n${events}\n`;
}
/**
 * Convert hex color (#RRGGBB) to ASS format (&HBBGGRR&)
 */
function hexToAss(hex) {
    const clean = hex.replace('#', '');
    if (clean.length !== 6)
        return '&H00FFFFFF&';
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    return `&H00${b}${g}${r}&`;
}
/**
 * Convert hex color (#RRGGBB) + opacity (0..1) to an ASS color with alpha.
 * ASS alpha is inverted vs CSS: 0x00 = fully opaque, 0xFF = fully transparent.
 */
function hexToAssAlpha(hex, opacity) {
    const clean = hex.replace('#', '');
    if (clean.length !== 6)
        return '&H80000000&'; // fallback: semi-transparent black
    const r = clean.substring(0, 2);
    const g = clean.substring(2, 4);
    const b = clean.substring(4, 6);
    const clamped = Math.max(0, Math.min(1, opacity));
    const assAlpha = Math.round((1 - clamped) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
    return `&H${assAlpha}${b}${g}${r}&`;
}
/**
 * @deprecated Superseded by {@link generateASS}, which renders in real video
 * pixels via PlayResX/Y. Kept only for the existing unit tests.
 *
 * Build the libass `force_style` string from a SubtitleConfig. Exported for
 * unit-testability.
 *
 * Background mode (cfg.background = true): BorderStyle=3 draws an opaque/alpha
 * box behind the text. OutlineColour becomes the box's border colour and Outline
 * becomes box padding; the glyph stroke is dropped — an accepted tradeoff.
 *
 * Outline mode (cfg.background = false): BorderStyle=1 strokes the glyph edges.
 */
export function buildForceStyle(cfg, videoWidth, videoHeight) {
    const primaryColor = hexToAss(cfg.textColor);
    const outlineColor = hexToAss(cfg.outlineColor);
    const alignment = cfg.position === 'top' ? 8 : cfg.position === 'center' ? 5 : 2;
    const marginL = Math.round(videoWidth * (cfg.sideMargin / 100));
    const marginR = marginL;
    const marginV = Math.round(videoHeight * 0.05);
    const outline = cfg.outline ? cfg.outlineWidth : 0;
    const parts = [
        'FontName=Arial',
        `FontSize=${cfg.fontSize}`,
        `PrimaryColour=${primaryColor}`,
        `OutlineColour=${outlineColor}`,
        `BorderStyle=${cfg.background ? 3 : 1}`,
        `Outline=${outline}`,
        'Shadow=0',
        `Alignment=${alignment}`,
        `MarginL=${marginL}`,
        `MarginR=${marginR}`,
        `MarginV=${marginV}`,
    ];
    if (cfg.background) {
        parts.push(`BackColour=${hexToAssAlpha(cfg.backgroundColor, cfg.backgroundOpacity)}`);
    }
    return parts.join(',');
}
