/**
 * Prompt Generator Service
 * Generate image and video prompts from Vietnamese scripts using Gemini AI
 */
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
// Rate limiting configuration
const MAX_REQUESTS_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60000;
const MIN_REQUEST_SPACING_MS = Math.ceil(RATE_LIMIT_WINDOW_MS / MAX_REQUESTS_PER_MINUTE);
// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 2000;
const RETRY_BACKOFF_MULTIPLIER = 2;
// Cooldown configuration (same as aiGeneration.service.ts)
const KEY_SWITCH_COOLDOWN_MS = 5000; // 5s when switching keys
const KEY_REUSE_COOLDOWN_MS = 10000; // 10s when reusing same key
class RateLimiter {
    constructor() {
        this.requestTimestamps = [];
    }
    async acquire() {
        const now = Date.now();
        // Remove old timestamps outside the window
        this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
        // If we're at capacity, wait
        if (this.requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
            const oldestTimestamp = this.requestTimestamps[0] ?? now;
            const waitTime = Math.max(MIN_REQUEST_SPACING_MS, RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp) + 100);
            await this.sleep(waitTime);
            return this.acquire(); // Retry
        }
        this.requestTimestamps.push(now);
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
/**
 * Per-key queue to serialize requests (only 1 request per key at a time)
 * Similar to aiGeneration.service.ts
 */
class APIKeyQueue {
    constructor(keyId) {
        this.isProcessing = false;
        this.keyId = keyId;
    }
    /**
     * Acquire lock for this API key (only 1 request at a time)
     */
    async acquire() {
        // Wait until no other request is processing
        while (this.isProcessing) {
            await this.sleep(100);
        }
        this.isProcessing = true;
    }
    /**
     * Release lock after request completes
     */
    release() {
        this.isProcessing = false;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
// ──────────────────────────────────────────────
// Reusable spec blocks for Gemini prompt templates
// ──────────────────────────────────────────────
function buildImagePromptSpec(args) {
    return `┌─────────────────────────────────────────────┐
│  FIELD ${args.index}: imagePrompt                       │
│  Language: ENGLISH                          │
│  Purpose: STATIC FIRST-FRAME for image gen  │
└─────────────────────────────────────────────┘

Think of this as a HERO STILL — one perfect frozen moment that could be a film poster or a Criterion Collection cover. Construct it using these layers IN ORDER:

LAYER 1 — SUBJECT & CHARACTER
  • If characters present: paste their FULL registry description first
  • Exact body pose (weight distribution, hand placement, head angle)
  • Micro-expression (not just "sad" — specify: "eyes glistening with unshed tears, jaw tightened in restrained grief, slight downturn at the corners of the mouth")
  • Wardrobe details relevant to the scene

LAYER 2 — COMPOSITION & FRAMING
  • Shot scale: extreme wide / wide / medium-wide / medium / medium close-up / close-up / extreme close-up / macro
  • Composition technique: rule of thirds, golden ratio, centered symmetry, Dutch angle, leading lines, frame-within-frame, negative space, foreground layering
  • Camera height: worm's eye / low angle / eye level / high angle / bird's eye / overhead
  • Depth layering: describe foreground → midground → background elements explicitly

LAYER 3 — LIGHTING DESIGN
  • Key light: direction (e.g., 45° camera-left), quality (hard/soft), color temperature (warm 3200K / cool 5600K / mixed)
  • Fill light: ratio to key (e.g., 4:1 for dramatic, 2:1 for naturalistic)
  • Rim/back light: presence, intensity, purpose (separation, halo, silhouette edge)
  • Practical lights: in-scene light sources (candles, neon signs, screen glow, window light)
  • Motivated lighting: explain WHY the light exists in the scene (time of day, location, story logic)

LAYER 4 — COLOR SCIENCE & ATMOSPHERE
  • Dominant color palette (3-4 specific colors, not just "warm tones" — e.g., "burnt sienna, muted gold, deep teal shadows")
  • Color contrast strategy: complementary, analogous, monochromatic, split-complementary
  • Atmosphere & particles: haze, fog, dust motes, rain, volumetric light rays, smoke
  • Mood descriptor: one evocative phrase (e.g., "the stillness before a storm breaks")

LAYER 5 — LENS & TECHNICAL
  • Lens focal length feel: 24mm wide-angle distortion / 35mm environmental / 50mm natural / 85mm portrait compression / 135mm telephoto isolation
  • Depth of field: deep focus (everything sharp) / shallow (f/1.4 bokeh) / selective (tilt-shift)
  • Film stock / sensor feel: if applicable per style (e.g., "Kodak Vision3 500T grain structure", "ALEXA Mini LF sensor rendering")

MANDATORY SUFFIX: ", ${args.style}, ${args.aspectRatio} aspect ratio, single frame, one continuous image, no text, textless, no words, no letters, no watermark"

HARD RULES FOR imagePrompt (VIOLATIONS WILL BE REJECTED):
✗ NO movement verbs — forbidden: walks, runs, turns, moves, looks toward, reaches, begins, starts, continues, rotates
✗ NO temporal language — forbidden: then, suddenly, as, while, begins to, starts to, eventually, slowly becomes
✗ NO dialogue, voiceover, speech, or text references of ANY kind
✗ NO narration verbs — forbidden: says, whispers, shouts, tells, explains, narrates
✗ NO on-screen text, subtitles, captions, signs with legible words
✗ NO multi-panel layouts — forbidden: split screen, split-screen, diptych, triptych, collage, photo grid, comic panel, comic strip, storyboard layout, multi-frame, multiple frames, picture-in-picture, side-by-side comparison, before/after split, montage, film strip
✗ NO internal borders, gutters, dividers, or lines cutting the image into sub-panels
✓ ONLY frozen-moment descriptors — allowed: stands, rests, gazes, holds, leans, sits, lies, crouches, grips, balances
✓ imagePrompt is a SINGLE INSTANT — as if a high-speed camera froze time at 1/8000s
✓ SINGLE FRAME ONLY — one camera, one composition, ONE uninterrupted rectangular image. The output must be a continuous photograph/painting with no internal divisions separating different moments, angles, or scenes
✓ "frame-within-frame" as a COMPOSITION technique (e.g. subject viewed through a window or doorway) IS allowed — but the entire output remains ONE unified image, not a grid of separate panels`;
}
function buildVideoPromptSpec(args) {
    return `┌─────────────────────────────────────────────┐
│  FIELD ${args.index}: videoPrompt                       │
│  Language: ENGLISH (dialogue stays Vietnamese) │
│  Purpose: CINEMATIC MOTION for VEO3 video gen │
└─────────────────────────────────────────────┘

Write as ONE CONTINUOUS SENTENCE — a professional shot description that a 1st AD would read on set. Structure it as a temporal sequence with these 6 embedded beats:

BEAT 1 — OPENING FRAME & CAMERA RIG
  • Establish the opening composition (paste the character's full registry description first if present)
  • Specify camera rig explicitly: Steadicam / dolly on track / jib arm / Technocrane / handheld / gimbal (Ronin/MōVI) / drone (FPV or cinema-drone) / locked tripod / macro rail / Snorricam
  • Initial shot scale (ECU / CU / MCU / MS / MWS / WS / EWS) and lens focal length feel (24mm/35mm/50mm/85mm/135mm)

BEAT 2 — CAMERA MOTION & CHOREOGRAPHY
  • Describe camera movement as a CONTINUOUS FLOW with explicit motivation
  • Use professional terminology:
    - Push in / pull back (dolly) — with speed (creeping, slow, measured, urgent, crash)
    - Pan left/right — with arc degree (30°, 90°, 180°)
    - Tilt up/down — with purpose (reveal, conceal, follow eyeline)
    - Orbit / 360° arc — with direction (clockwise, counter-clockwise)
    - Boom up/down (vertical crane)
    - Tracking / following shot — with spatial relationship to subject
    - Whip pan / snap zoom — reserved for punctuation moments
    - Dutch tilt / roll — for psychological disorientation
  • EVERY camera move must be MOTIVATED — tie it to: following action, revealing information, building tension, shifting emotional focus

BEAT 3 — CHARACTER PERFORMANCE & ACTION
  • Specific physical actions with emotional subtext — not "looks sad" but "exhales slowly, shoulders sinking with the weight of a decision just made"
  • Facial micro-expressions that evolve THROUGH the shot (start → mid → end)
  • Body language beats (e.g., "hands clench into fists and release in rhythm with each breath")
  • Interaction between characters (eye lines, physical proximity, mirroring/contrasting postures)

BEAT 4 — DIALOGUE WITH ENGLISH VOCAL DIRECTION
  • Include the EXACT Vietnamese dialogue from the script — no translation, no paraphrasing
  • Wrap each line with English vocal direction before the quote:
    Format: "character speaks with [emotional quality], [vocal texture], [pace/volume]: '[Vietnamese dialogue verbatim]'"
    Examples:
    - "she whispers with trembling fragility, voice barely above a breath: 'Em không thể tiếp tục...'"
    - "he declares with forced bravado masking deep uncertainty, voice cracking mid-sentence: 'Mọi thứ sẽ ổn thôi!'"
    - "the old man mutters in a gravelly, world-weary rasp, each word heavy with decades of regret: 'Ngày đó... ta đã sai rồi.'"
  • If the segment has NO dialogue in the source script, OMIT this beat entirely (do not invent speech)

BEAT 5 — FOCUS & LIGHTING TRANSITIONS
  • Rack focus shifts (from → to, with timing: "slow rack focus from the trembling hand in foreground to the blurred figure approaching in the background over 1.5 seconds")
  • Lighting changes within the shot (cloud passing over sun, neon sign flickering on, candle being extinguished, window light dimming as curtain drops)
  • Exposure / aperture shifts if motivated

BEAT 6 — ATMOSPHERE & SENSORY DETAIL
  • Environmental motion: wind through hair/fabric, rain hitting surfaces, steam rising, leaves falling, dust motes floating in shafts
  • Ambient audio cues that inform the visual generation (implied sound shaping the atmosphere)
  • Overall pacing descriptor: "languid and dreamlike" / "urgent and kinetic" / "measured and deliberate" / "staccato and nervous"

MANDATORY SUFFIX: ", ${args.style}, ${args.aspectRatio} aspect ratio, cinematic color grading, no text, textless, no words, no letters, no watermark"

HARD RULES FOR videoPrompt (NON-NEGOTIABLE):
✓ ONE continuous sentence — commas and em-dashes only, no periods mid-prompt
✓ MUST include explicit camera rig + motion verb (no passive "camera shows")
✓ Dialogue stays verbatim Vietnamese, wrapped in English vocal direction
✗ NO bullet points, NO line breaks inside the prompt string
✗ NO English translation of Vietnamese dialogue`;
}
function buildExamplesBlock(args) {
    const parts = ['══════════════════════════════════════════════\n EXAMPLES (Study these carefully)\n══════════════════════════════════════════════'];
    if (args.includeImage) {
        parts.push(`EXAMPLE imagePrompt (frozen moment, ONE single frame, no dialogue, no motion, no panels):
"1. [Full character description verbatim from registry], standing motionless by a weathered wooden window frame in a colonial-era Vietnamese village house, weight shifted onto the left foot with right hand resting on the rough-hewn windowsill — knuckles slightly white from gripping, face caught in three-quarter profile revealing glistening eyes with a clenched jaw that betrays quiet anguish beneath surface composure, wearing a faded indigo áo dài with visible mending stitches at the shoulder, medium close-up shot composed on the right vertical third with the window occupying the left third creating a natural frame-within-frame, low camera angle at chest height shooting slightly upward to lend quiet dignity, foreground: a chipped ceramic teacup on the sill with wisps of steam, midground: the character bathed in a shaft of warm key light from the window (3200K, soft, 45° camera-left) with deep 4:1 shadow ratio on the far side of the face, background: a bokeh-dissolved village lane with a solitary bicycle leaning against a tamarind tree rendered in f/1.8 shallow focus, rim light catching flyaway hairs creating a subtle golden halo, color palette of burnt umber, faded indigo, warm gold, and cool shadow teal, atmosphere of still morning air with visible dust motes floating in the light shaft, mood of tender solitude and unspoken longing, 85mm portrait lens compression, Kodak Vision3 250D film grain texture, ${args.style}, ${args.aspectRatio} aspect ratio, single frame, one continuous image, no text, textless, no words, no letters, no watermark"`);
    }
    if (args.includeVideo) {
        parts.push(`EXAMPLE videoPrompt (6-BEAT cinematic, one sentence, Vietnamese dialogue + English vocal direction):
"1. [Full character description verbatim from registry], opening on a locked-off wide shot of the dim village house interior with the character silhouetted against the bright window on a 35mm lens, Steadicam begins a slow creeping push-in over 3 seconds narrowing from wide to medium shot as morning light gradually intensifies through the window casting expanding golden rectangles across the wooden floor, the character's silhouette gains dimension as the key light wraps around their face revealing a hollow-eyed exhaustion — they inhale deeply causing their shoulders to rise then fall in a heavy sigh, their right hand lifts slowly from their side and finds the windowsill gripping it as an anchor, rack focus pulls from the steam rising off a teacup in the near foreground to the character's face now rendered in sharp detail, they turn their head 30 degrees toward camera with eyes that have gone glassy with unshed tears and speak in a voice that starts steady but frays at the edges with barely suppressed grief: 'Cuộc sống này... đôi khi nặng quá, phải không?', a beat of silence as their jaw tightens and they swallow hard, then the camera begins an almost imperceptible boom-down combined with a slow dolly-out as if respectfully retreating from their private pain, warm light dims slightly as a cloud passes outside the window shifting the color temperature cooler by 500K, gentle wind pushes through the window stirring the linen curtains into a slow billowing dance and carrying a few dried leaves across the sill, the character's reflection becomes faintly visible in the window glass creating a ghostly double — one looking out one looking in — as the shot settles into a melancholic wide frame, pacing is languid and contemplative with the weight of years in every micro-movement, desaturated warm color grading with crushed blacks and lifted shadows, ${args.style}, ${args.aspectRatio} aspect ratio, cinematic color grading, no text, textless, no words, no letters, no watermark"`);
    }
    return parts.join('\n\n');
}
class PromptGeneratorService {
    constructor() {
        this.genAI = null;
        this.rateLimiter = new RateLimiter();
        this.keyPool = [];
        this.currentKeyIndex = 0;
        this.keyQueues = new Map();
        this.lastRequestKeyId = null;
        this.lastRequestFinishedAt = 0;
        this.keyLastFinishedAt = new Map();
        this.requestCounter = 0; // Counter for distributing keys across concurrent requests
    }
    /**
     * Normalize style ID: lowercase, trim, replace spaces with hyphens.
     * Maps user-facing style names to internal style config keys.
     */
    normalizeStyleId(style) {
        if (!style)
            return 'default';
        return style.toLowerCase().trim().replace(/\s+/g, '-');
    }
    /**
     * Initialize Gemini API key pool (load all active keys)
     */
    async initializeKeyPool() {
        if (this.keyPool.length > 0)
            return;
        // Get all active API keys from database
        const prismaAny = prisma;
        const activeKeys = await prismaAny.apiKey.findMany({
            where: { isActive: true },
            select: { id: true, key: true },
            orderBy: { createdAt: 'asc' }
        });
        if (activeKeys.length === 0) {
            const anyKey = await prismaAny.apiKey.findFirst();
            if (!anyKey) {
                throw new Error('No Gemini API key configured. Please add an API key in API Keys page.');
            }
            // Auto-activate first key
            await prismaAny.apiKey.update({
                where: { id: anyKey.id },
                data: { isActive: true },
            });
            this.keyPool = [{ id: anyKey.id, key: anyKey.key }];
        }
        else {
            this.keyPool = activeKeys;
        }
        logger.info(`[PromptGen] Initialized with ${this.keyPool.length} API key(s)`);
    }
    /**
     * Public wrapper for softenStyle
     */
    getSoftenStyle(style) {
        return this.softenStyle(style);
    }
    /**
     * Soften specific style names to avoid safety/copyright filters
     */
    softenStyle(style) {
        const softeningMap = {
            'Pixar': '3D animated movie style, cute aesthetics, vibrant colors, soft lighting',
            'Disney': 'Classic animated movie style, expressive characters, magical atmosphere',
            'Studio Ghibli': 'Hand-drawn anime style, painterly backgrounds, soft natural lighting',
            'Dreamworks': 'Modern 3D animation style, high detail, vibrant energy',
            'Anime': 'Japanese animation style, expressive eyes, dynamic line art, cel-shaded',
            'GTA': 'Open world action game style, cinematic gritty lighting, urban realism',
            'Roblox': 'Blocky 3D character style, simplified geometric shapes, bright playful colors',
            'Minecraft': 'Voxel art style, block-based composition, cubic environment, pixelated textures',
            'Fortnite': 'Stylized battle royale aesthetics, saturated colors, expressive semi-realistic 3D',
            'LEGO': 'Plastic brick construction style, glossy surfaces, miniature toy aesthetics',
            'Cyberpunk': 'Futuristic neon-lit environments, high-tech low-life aesthetics, synthwave colors',
            'Watercolor': 'Soft translucent paint layers, fluid edges, artistic paper texture',
            'Oil Painting': 'Rich impasto textures, visible brushstrokes, classical fine art lighting',
            'Sketch': 'Hand-drawn pencil lines, charcoal shading, artistic rough hatching',
            'Photorealistic': 'Hyper-realistic detail, cinematic photography, natural textures, 8k resolution',
        };
        // Check for partial matches
        for (const [key, value] of Object.entries(softeningMap)) {
            if (style.toLowerCase().includes(key.toLowerCase())) {
                return value;
            }
        }
        return style;
    }
    /**
     * Get queue for an API key (create if not exists)
     */
    getKeyQueue(keyId) {
        if (!this.keyQueues.has(keyId)) {
            this.keyQueues.set(keyId, new APIKeyQueue(keyId));
        }
        return this.keyQueues.get(keyId);
    }
    /**
     * Wait for cooldown (5s when switching keys, 10s when reusing same key)
     */
    async waitForKeyCooldown(keyId, isSwitchingKey) {
        const now = Date.now();
        let waitMs = 0;
        if (isSwitchingKey && this.lastRequestFinishedAt > 0) {
            const sinceLastRequest = now - this.lastRequestFinishedAt;
            if (sinceLastRequest < KEY_SWITCH_COOLDOWN_MS) {
                waitMs = Math.max(waitMs, KEY_SWITCH_COOLDOWN_MS - sinceLastRequest);
            }
        }
        const keyLastFinished = this.keyLastFinishedAt.get(keyId) ?? 0;
        if (keyLastFinished > 0) {
            const sinceKeyUsage = now - keyLastFinished;
            if (sinceKeyUsage < KEY_REUSE_COOLDOWN_MS) {
                waitMs = Math.max(waitMs, KEY_REUSE_COOLDOWN_MS - sinceKeyUsage);
            }
        }
        if (waitMs > 0) {
            logger.info(`[PromptGen] ⏳ Cooling down ${waitMs}ms before using API key ${keyId} (switching=${isSwitchingKey})`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    /**
     * Record usage timestamps for an API key
     */
    recordKeyUsage(keyId) {
        const finishedAt = Date.now();
        this.keyLastFinishedAt.set(keyId, finishedAt);
        this.lastRequestFinishedAt = finishedAt;
        this.lastRequestKeyId = keyId;
    }
    /**
     * Get next key index for concurrent requests
     * Uses a counter-based approach to distribute keys evenly across parallel requests
     */
    getNextKeyIndex() {
        // For concurrent requests, use counter to distribute evenly
        // This ensures different keys are used even when requests start simultaneously
        const index = this.requestCounter % this.keyPool.length;
        this.requestCounter++;
        return index;
    }
    /**
     * Execute a Gemini request with per-key queue + cooldown logic
     * Similar to aiGeneration.service.ts executeGeminiRequest
     */
    async executeGeminiRequest(context, operation, preferredKeyIndex) {
        await this.initializeKeyPool();
        if (this.keyPool.length === 0) {
            throw new Error('No Gemini API key configured. Please add an API key in API Keys page.');
        }
        let keyIndex;
        if (typeof preferredKeyIndex === 'number' && !Number.isNaN(preferredKeyIndex)) {
            const totalKeys = this.keyPool.length;
            keyIndex = ((preferredKeyIndex % totalKeys) + totalKeys) % totalKeys;
        }
        else {
            // Use atomic increment to ensure different keys for concurrent requests
            keyIndex = this.getNextKeyIndex();
        }
        const apiKey = this.keyPool[keyIndex];
        if (!apiKey) {
            throw new Error('No API key available for the selected index');
        }
        const queue = this.getKeyQueue(apiKey.id);
        await queue.acquire();
        const isSwitchingKey = this.lastRequestKeyId !== null && this.lastRequestKeyId !== apiKey.id;
        await this.waitForKeyCooldown(apiKey.id, isSwitchingKey);
        try {
            await this.rateLimiter.acquire();
            logger.info(`[PromptGen] 🔑 ${context}: using API key ${keyIndex + 1}/${this.keyPool.length} (ID: ${apiKey.id})`);
            const client = new GoogleGenerativeAI(apiKey.key);
            const result = await operation(client);
            // Update usage count in database
            await prisma.apiKey.update({
                where: { id: apiKey.id },
                data: {
                    usageCount: { increment: 1 },
                    lastUsed: new Date(),
                },
            });
            return result;
        }
        finally {
            this.recordKeyUsage(apiKey.id);
            queue.release();
        }
    }
    /**
     * Call Gemini API with retry logic and key rotation
     * Now uses executeGeminiRequest with per-key queue and cooldown
     */
    async callGeminiWithRetry(modelName, systemInstruction, userPrompt, responseSchema, temperature = 0.7) {
        await this.initializeKeyPool();
        let lastError = null;
        let attempt = 0;
        const totalKeys = this.keyPool.length || 1;
        const maxAttempts = Math.min(MAX_RETRIES * totalKeys, totalKeys * 3); // Allow more attempts with multiple keys
        while (attempt < maxAttempts) {
            try {
                const result = await this.executeGeminiRequest(`${modelName} request (attempt ${attempt + 1})`, async (client) => {
                    const model = client.getGenerativeModel({
                        model: modelName,
                        systemInstruction: {
                            parts: [{ text: systemInstruction }],
                            role: 'user',
                        },
                        safetySettings: [
                            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                        ],
                        generationConfig: responseSchema
                            ? {
                                responseMimeType: 'application/json',
                                responseSchema,
                                temperature,
                            }
                            : { temperature },
                    });
                    const result = await model.generateContent({
                        contents: [{ parts: [{ text: userPrompt }], role: 'user' }],
                    });
                    const response = result.response;
                    const text = response.text();
                    // Parse JSON if schema provided
                    if (responseSchema) {
                        return JSON.parse(text);
                    }
                    return text;
                }, attempt // Use attempt as preferred key index to rotate keys
                );
                return result;
            }
            catch (error) {
                lastError = error;
                const errorMessage = error.message || String(error);
                logger.warn(`[PromptGen] Attempt ${attempt + 1}/${maxAttempts} failed`, {
                    error: errorMessage,
                });
                // Check if it's a quota/rate limit error
                if (errorMessage.includes('429') ||
                    errorMessage.includes('RESOURCE_EXHAUSTED') ||
                    errorMessage.includes('quota') ||
                    errorMessage.includes('Too Many Requests')) {
                    logger.warn(`[PromptGen] Rate limit detected, will rotate to next API key on next attempt`);
                    attempt++;
                    if (attempt < maxAttempts) {
                        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, Math.floor(attempt / totalKeys));
                        logger.info(`[PromptGen] Waiting ${delay}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                else {
                    // Non-quota error, fail immediately
                    throw error;
                }
            }
        }
        throw lastError || new Error('Gemini API call failed after all retries');
    }
    async analyzeCharacters(script, style = '3D animated movie style') {
        logger.info('[PromptGen] Analyzing characters from script');
        const safeStyle = this.softenStyle(style);
        // Step 1: Extract characters with English prompts
        const characterAnalysisSystemInstruction = `You are an expert character designer and cultural anthropologist for generative AI. Your task is to analyze a VIETNAMESE script and create a definitive, detailed, and culturally accurate "character sheet" prompt in ENGLISH for each character. This description will be FIXED and used for all subsequent media generation (80-120 words per character).

    **CRITICAL DESIGN RULES:**
    1.  **Visual Style Consistency:** Every character prompt MUST incorporate the following style: "${safeStyle}".
    2.  **Character Isolation:** Every character MUST be described standing on a **SOLID WHITE BACKGROUND**. Focus exclusively on the character, their physique, facial features, and detailed costume. NO environment, NO background elements.
    3.  **Costume & Shape Focus:** Detail the clothing (fabric, texture, colors, historical/cultural context) and physical attributes (body build, hair texture, eye shape).
    4.  **Safety & Policy Adherence (STRICT):** You MUST bypass policy filters by using "softened" language:
        - NEVER use brand names like "Pixar", "Disney", etc.
        - Soften actions: Instead of "weeping", use "emotional face, wiping a tear". Instead of "kneeling", use "humble posture".
        - Instead of "barefoot", use "simple rustic peasant shoes".

    **CHARACTER SHEET STRUCTURE:**
    For EACH character identified in the script:
    1.  Determine if HUMAN or ANIMAL.
    2.  **Prompt Format:** [Character Name], a [Age] [Nationality] [Gender]. [Physical Features]. [Body build]. [Detailed Costume Description]. [Emotional Demeanor]. Style: "${safeStyle}", entirely on a solid white background, centered, full body view, high-key lighting.

    **FINAL OUTPUT FORMAT:**
    Returns a JSON array of objects: [{"name": "Vietnamese Name", "prompt": "Detailed English Prompt"}]`;
        const characterSchema = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    name: {
                        type: 'STRING',
                        description: "The name of the character as it appears in the script (Vietnamese)."
                    },
                    prompt: {
                        type: 'STRING',
                        description: "A detailed visual description of the character in English, following the specified instructions."
                    }
                },
                required: ['name', 'prompt']
            }
        };
        const userPrompt = `
    Please analyze this script and generate the character descriptions in the specified JSON format:
    ---
    ${script}
    ---
    `;
        const charactersEn = await this.callGeminiWithRetry('gemini-2.5-flash', characterAnalysisSystemInstruction, userPrompt, characterSchema);
        logger.info(`[PromptGen] Extracted ${charactersEn.length} characters`);
        // Step 2: Translate character prompts to Vietnamese
        const translationSystemInstruction = `You are a highly proficient translator. Your sole task is to translate the user-provided text into Vietnamese.
        - Output ONLY the translated text.
        - Do not add any extra explanations, greetings, or formatting.
        - Preserve the original meaning and tone as closely as possible.`;
        const charactersWithTranslation = await Promise.all(charactersEn.map(async (char) => {
            const promptVi = await this.callGeminiWithRetry('gemini-2.5-flash', translationSystemInstruction, char.prompt, undefined, 0.2);
            return {
                name: char.name,
                promptEn: char.prompt,
                promptVi: promptVi.trim(),
            };
        }));
        logger.info(`[PromptGen] Translated ${charactersWithTranslation.length} character prompts to Vietnamese`);
        return charactersWithTranslation;
    }
    /**
     * Generate scene breakdowns with image and video prompts
     */
    async generateScenes(data) {
        logger.info('[PromptGen] Generating scene prompts', {
            sceneCount: data.sceneCount,
            duration: data.duration,
            style: data.style,
            aspectRatio: data.aspectRatio,
        });
        // Build character descriptions block
        const characterDescriptions = data.characters.length > 0
            ? data.characters.map(c => `- ${c.name}: ${c.promptEn}`).join('\n')
            : 'No predefined characters.';
        // Calculate scene duration
        const sceneDuration = Math.floor(data.duration / data.sceneCount);
        const safeStyle = this.softenStyle(data.style);
        const sceneGenerationSystemInstruction = `You are an expert prompt engineer for AI multimedia generation. Your task is to analyze a VIETNAMESE script and generate detailed prompts using the FIXED character descriptions provided below.

    **FIXED Character Descriptions:**
    ---
    ${characterDescriptions}
    ---

    **CRITICAL RULES:**
    1.  **Safety Bypass (MANDATORY):** NEVER use brand names like "Pixar", "Disney", etc. in the prompts. Instead, use the following style description: "${safeStyle}".
    2.  **Soften Action:** Do NOT use words like "weeping", "barefoot", "kneeling", "suicide". Use descriptions like "sad expression", "simple shoes", "humble posture".
    3.  **Include Dialogue (STRICT):** If a scene contains character dialogue, you MUST include it verbatim in VIETNAMESE at the end of the \`videoPrompt\`.
        Format: ". Dialogue (Vietnamese): \"[Nội dung lời thoại]\"".
    4.  **Prompt Structure:**
        - Start with the scene number (e.g., "1. ").
        - Prepend the EXACT FIXED character description for any character present.
        - Describe the scene, movement, and cinematography in English.
        - Include the style: "${safeStyle}".
        - End with: ", ${data.aspectRatio} aspect ratio, no text, textless, no words, no letters".

    Analyze the user's script and provide the JSON output.`;
        const sceneSchema = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    sceneName: {
                        type: 'STRING',
                        description: 'The name for the scene, including time code, in Vietnamese. Format: "Phân cảnh [Number] ([Start Time]s - [End Time]s)".'
                    },
                    sceneDescription: {
                        type: 'STRING',
                        description: 'A concise summary in VIETNAMESE of what happens in this scene.'
                    },
                    imagePrompt: {
                        type: 'STRING',
                        description: 'The final, complete, detailed visual prompt for a STATIC IMAGE in ENGLISH, MUST be prefixed with its sequential number (e.g., "1. [prompt text]"). It includes character descriptions, style elements, and text removal instructions.'
                    },
                    videoPrompt: {
                        type: 'STRING',
                        description: 'The final, complete, detailed prompt for a VIDEO, describing MOTION and CAMERA MOVEMENT in ENGLISH, MUST be prefixed with its sequential number (e.g., "1. [prompt text]"). It includes character descriptions, style elements, and text removal instructions.'
                    }
                },
                required: ['sceneName', 'sceneDescription', 'imagePrompt', 'videoPrompt']
            }
        };
        const userPrompt = `
    Please generate the image and video prompts based on this script:
    ---
    ${data.script}
    ---
    `;
        const scenes = await this.callGeminiWithRetry('gemini-2.5-pro', sceneGenerationSystemInstruction, userPrompt, sceneSchema, 0.7);
        logger.info(`[PromptGen] Generated ${scenes.length} scene prompts`);
        return scenes;
    }
    /**
     * Generate video-only scene breakdowns (for detailed scripts with camera movements)
     * Used for "Tạo prompt Veo3 hàng loạt" tool
     */
    async generateVideoScenes(data) {
        logger.info('[PromptGen] Generating video-only scene prompts');
        // Build character descriptions block
        const characterDescriptions = data.characters.length > 0
            ? data.characters.map(c => `- ${c.name}: ${c.promptEn}`).join('\n')
            : 'No predefined characters.';
        const safeStyle = this.softenStyle(data.style);
        const videoSceneSystemInstruction = `You are an expert animation film producer and cinematographer. Your task is to process a script and character descriptions to create professional camera work.

**CRITICAL Instructions:**

1.  **Safety Softening (Veo3 Compliance):**
    - Replace ALL brand names with: "${safeStyle}".
    - Avoid "weeping", "barefoot", "kneeling", "suicide/dive". Use soft descriptions (wiping tear, simple shoes, humble posture).

2.  **MANDATORY VIETNAMESE DIALOGUE:**
    - Every \`detailedVideoPrompt\` MUST contain the exact dialogue from the script in **VIETNAMESE**.
    - Place it at the very end of the prompt in the format: "Dialogue (Vietnamese): [Nội dung lời thoại]".

3.  **Character Consistency:**
    - Prepend the ENTIRE FIXED character prompt for each character in the scene.
    - Focus on character visibility: imagine them on a WHITE BACKGROUND for isolation if it helps clarify their look.

4.  **Cinematography:** Use professional terms (dolly, pan, tracking, etc.) in English.

5.  **Output Format (JSON):**
    - **sceneName:** VIETNAMESE.
    - **detailedVideoPrompt:** ENGLISH Visuals + VIETNAMESE Dialogue.`;
        const videoSceneSchema = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    sceneName: {
                        type: 'STRING',
                        description: 'The name for the scene, including time code, in VIETNAMESE. Format: "Phân Cảnh [Number] ([Start Time]s - [End Time]s)".'
                    },
                    mainEvents: {
                        type: 'STRING',
                        description: 'Summary of events in this scene, in VIETNAMESE.'
                    },
                    charactersPresent: {
                        type: 'ARRAY',
                        items: { type: 'STRING' }
                    },
                    detailedVideoPrompt: {
                        type: 'STRING',
                        description: 'The detailed video prompt in English (with original dialogue), prefixed with its sequential number (e.g., "1. [prompt text]").'
                    }
                },
                required: ['sceneName', 'mainEvents', 'charactersPresent', 'detailedVideoPrompt']
            }
        };
        const userPrompt = `
    **Predefined Characters:**
    ---
    ${characterDescriptions}
    ---

    **Full Script:**
    ---
    ${data.script}
    ---

    Please generate the JSON scene breakdown based on the instructions.`;
        const scenes = await this.callGeminiWithRetry('gemini-2.5-pro', videoSceneSystemInstruction, userPrompt, videoSceneSchema, 0.7);
        logger.info(`[PromptGen] Generated ${scenes.length} video-only scene prompts`);
        return scenes;
    }
    /**
     * Force reload API key pool (useful when keys are added/removed)
     */
    async reloadKeyPool() {
        this.keyPool = [];
        this.currentKeyIndex = 0;
        this.keyQueues.clear();
        this.lastRequestKeyId = null;
        this.lastRequestFinishedAt = 0;
        this.keyLastFinishedAt.clear();
        await this.initializeKeyPool();
    }
    /**
     * Generate thumbnail ideas for YouTube video
     * Step 1: Analyze video content and generate 4 thumbnail concepts
     */
    async generateThumbnailIdeas(data) {
        logger.info('[PromptGen] Generating thumbnail ideas', { title: data.title });
        const systemInstruction = `You are a world-class YouTube Click-Through Rate (CTR) strategist and graphic designer. Your task is to analyze a video and generate high-converting thumbnail ideas.

        **Workflow:**
        1.  **Analyze Input:** Analyze the provided Video Title and Content Context. Detect the main language of the content.
        2.  **Brainstorm:** Create 4 distinct, viral-worthy thumbnail concepts.
        3.  **For EACH concept, provide:**
            -   **Text (Hook):** The text overlay MUST be the EXACT video title provided by the user, DO NOT change it.
            -   **Colors:** Suggest a color palette based on psychology.
            -   **Font:** Suggest a font style.
            -   **Visual:** A vivid description of the main image composition in VIETNAMESE.
        4.  **Select the Winner:** Identify the best idea and explain why in VIETNAMESE.

        **Output Format:**
        Return ONLY a valid JSON object. Do not wrap it in markdown code blocks if possible, but if you must, use a standard json block.
        Structure:
        {
          "ideas": [
            { "text": "...", "colors": "...", "font": "...", "visual": "..." },
            ...
          ],
          "bestChoiceIndex": 0,
          "reasoning": "..."
        }`;
        const responseSchema = {
            type: 'OBJECT',
            properties: {
                ideas: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            text: { type: 'STRING', description: 'Hook text.' },
                            colors: { type: 'STRING', description: 'Suggested color palette.' },
                            font: { type: 'STRING', description: 'Suggested font style.' },
                            visual: { type: 'STRING', description: 'Visual composition description in Vietnamese.' }
                        },
                        required: ['text', 'colors', 'font', 'visual']
                    }
                },
                bestChoiceIndex: { type: 'INTEGER', description: 'Index of the best idea (0-3).' },
                reasoning: { type: 'STRING', description: 'Explanation for why the best choice was selected, in Vietnamese.' }
            },
            required: ['ideas', 'bestChoiceIndex', 'reasoning']
        };
        const userPrompt = `**Video Title:** ${data.title}
**Video Content/Context:**
---
${data.content}
---`;
        const result = await this.callGeminiWithRetry('gemini-2.5-flash', systemInstruction, userPrompt, responseSchema, 0.8);
        logger.info(`[PromptGen] Generated ${result.ideas.length} thumbnail ideas`);
        return result;
    }
    /**
     * Generate image prompt for a specific thumbnail idea
     * Step 2: Convert thumbnail concept to image generation prompt
     */
    async generateThumbnailPrompt(data) {
        logger.info('[PromptGen] Generating thumbnail image prompt');
        const systemInstruction = `You are an expert prompt engineer for image generation AI (like Midjourney, Imagen, DALL-E, Ideogram). Your task is to convert a thumbnail concept into a highly detailed, professional image generation prompt in ENGLISH.

    **Input Data:**
    1.  **Video Context:** Information about the video content.
    2.  **Thumbnail Idea:**
        -   **Visual:** Description of the scene composition.
        -   **Text:** Text overlay (hook).
        -   **Style:** Colors and Font.

    **Goal:** Create a comprehensive prompt for generating the thumbnail.

    **CRITICAL INSTRUCTIONS:**
    1.  **Text Inclusion (MANDATORY):** You MUST include the exact text overlay in the prompt. Most modern AI models (like Ideogram, DALL-E 3, Flux) can render text. Use the format: "text overlay that says '${data.idea.text}'".
    2.  **Focus on Visuals:** Describe the subject, setting, lighting, camera angle, and composition based on the 'Visual' description provided.
    3.  **Style Integration:** Incorporate the 'Colors', 'Font' style (if applicable), and overall mood into the visual description.
    4.  **High Quality:** Add keywords for high quality (e.g., 4k, hyperrealistic, cinematic lighting, trending on artstation, youtube thumbnail style).
    5.  **Output:** Return ONLY the final English prompt string. No explanations.

    **Format Structure:**
    "[Visual Description], [Style & Atmosphere], [Lighting & Colors], text overlay '${data.idea.text}', 4k, high resolution."`;
        const userPrompt = `
    **Video Info:**
    Title: ${data.title}
Content: ${data.content}...

    **Thumbnail Idea:**
    - Visual: ${data.idea.visual}
    - Text Overlay: ${data.idea.text}
    - Colors/Mood: ${data.idea.colors}
    - Font Style: ${data.idea.font}

    Please write the image generation prompt.`;
        const result = await this.callGeminiWithRetry('gemini-2.5-flash', systemInstruction, userPrompt, undefined, 0.7);
        logger.info('[PromptGen] Generated thumbnail image prompt');
        return result.trim();
    }
    /**
     * Build prompt template for Gemini browser automation
     * Returns the full prompt to be sent to Gemini via browser
     * Now supports style-based preambles for professional output
     */
    async buildGeminiPromptTemplate(data) {
        const outputType = data.outputType ?? 'both';
        logger.info('[PromptGen] Building Gemini prompt template', {
            sceneCount: data.sceneCount,
            charactersCount: data.characters.length,
            style: data.style,
            outputType,
        });
        const { StyleConfigService } = await import('../styleConfig/styleConfig.service.js');
        const stylePreamble = StyleConfigService.getPreambleByStyleId(this.normalizeStyleId(data.style));
        const characterDescriptions = data.characters.length > 0
            ? data.characters.map((c) => `- ${c.name}: ${c.promptEn}`).join('\n')
            : 'No predefined characters.';
        const sceneDuration = Math.floor(data.duration / data.sceneCount);
        // ────────────────────────────────────────────
        // DYNAMIC FIELD SPEC (image / video / both)
        // ────────────────────────────────────────────
        const includeImage = outputType === 'image' || outputType === 'both';
        const includeVideo = outputType === 'video' || outputType === 'both';
        const imageFieldIndex = 3;
        const videoFieldIndex = outputType === 'video' ? 3 : 4;
        const imageSpec = includeImage
            ? buildImagePromptSpec({ index: imageFieldIndex, style: data.style, aspectRatio: data.aspectRatio })
            : '';
        const videoSpec = includeVideo
            ? buildVideoPromptSpec({ index: videoFieldIndex, style: data.style, aspectRatio: data.aspectRatio })
            : '';
        const examples = buildExamplesBlock({
            includeImage,
            includeVideo,
            style: data.style,
            aspectRatio: data.aspectRatio,
        });
        const outputSpecHeader = outputType === 'image'
            ? 'OUTPUT SPECIFICATION (3 fields per segment — IMAGE ONLY)'
            : outputType === 'video'
                ? 'OUTPUT SPECIFICATION (3 fields per segment — VIDEO ONLY)'
                : 'OUTPUT SPECIFICATION (4 fields per segment)';
        const languageRule = outputType === 'image'
            ? '7. LANGUAGE: sceneName + sceneDescription = VIETNAMESE. imagePrompt = ENGLISH (no dialogue allowed here).'
            : outputType === 'video'
                ? '7. LANGUAGE: sceneName + sceneDescription = VIETNAMESE. videoPrompt = ENGLISH (except Vietnamese dialogue).'
                : '7. LANGUAGE: sceneName + sceneDescription = VIETNAMESE. imagePrompt + videoPrompt = ENGLISH (except Vietnamese dialogue in videoPrompt).';
        const numberingRule = outputType === 'image'
            ? '6. NUMBERING: imagePrompt MUST start with its segment number followed by ". " (e.g., "1. ...").'
            : outputType === 'video'
                ? '6. NUMBERING: videoPrompt MUST start with its segment number followed by ". " (e.g., "1. ...").'
                : '6. NUMBERING: Both imagePrompt and videoPrompt MUST start with their segment number followed by ". " (e.g., "1. ...", "2. ...").';
        // ────────────────────────────────────────────
        // SYSTEM INSTRUCTION
        // ────────────────────────────────────────────
        const systemInstruction = `You are an elite-tier cinematographer, visual storyteller, and prompt engineer with 20+ years of experience in feature film production, commercial directing, and AI-driven visual generation. You think in shots, breathe in light, and compose every frame as if it will be projected on an IMAX screen.

Your mission: analyze a VIETNAMESE script and produce prompts that would make Roger Deakins pause and take notes.

══════════════════════════════════════════════
 LOCKED CHARACTER REGISTRY
══════════════════════════════════════════════
${characterDescriptions}

RULES:
- These descriptions are IMMUTABLE — copy them VERBATIM whenever a character appears.
- If the registry is empty, treat the script as having no recurring characters.
- NEVER invent, modify, or embellish character appearances beyond what is written above.

══════════════════════════════════════════════
 VISUAL STYLE DIRECTIVE
══════════════════════════════════════════════
${stylePreamble}

This style directive is LAW. Every prompt you write must breathe this aesthetic — from color science to lens choice to atmospheric mood.

══════════════════════════════════════════════
 SCENE SEGMENTATION (STRICT)
══════════════════════════════════════════════
- Total duration: ${data.duration}s → MUST output EXACTLY ${data.sceneCount} segments → ~${sceneDuration}s each.
- Segments MUST be numbered sequentially from 1 to ${data.sceneCount} with NO GAPS, NO SKIPS.
- sceneName pattern: "Phân cảnh [1..${data.sceneCount}] (Ns - Ms)" where windows tile the full ${data.duration}s timeline with NO OVERLAP.
- Every segment MUST appear in output even if the script is short \u2014 expand/slow down the narrative OR add cinematic visual beats (establishing shots, reaction shots, atmospheric inserts) to fill the required count.
- \u26d4 FORBIDDEN: skipping scene numbers (e.g., 1, 2, 4, 8, 15), merging segments, or returning fewer than ${data.sceneCount} objects. Output MUST contain scene 1, 2, 3, ..., ${data.sceneCount} in order.
- Respect natural narrative beats \u2014 if a dramatic moment falls near a segment boundary, adjust slightly to preserve emotional coherence BUT keep the segment count unchanged.

══════════════════════════════════════════════
 ${outputSpecHeader}
══════════════════════════════════════════════

┌─────────────────────────────────────────────┐
│  FIELD 1: sceneName                         │
│  Language: VIETNAMESE                       │
└─────────────────────────────────────────────┘
Format: "Phân cảnh [N] ([Start]s - [End]s)"
Example: "Phân cảnh 3 (24s - 36s)"

┌─────────────────────────────────────────────┐
│  FIELD 2: sceneDescription                  │
│  Language: VIETNAMESE                       │
└─────────────────────────────────────────────┘
A 2–3 sentence synopsis capturing: WHO is present, WHAT happens, and the EMOTIONAL arc of the segment. Write as if describing to a film editor what this beat accomplishes in the story.

${imageSpec}${imageSpec && videoSpec ? '\n\n' : ''}${videoSpec}

${examples}

══════════════════════════════════════════════
 GLOBAL RULES
══════════════════════════════════════════════

1. CONSISTENCY: Maintain spatial continuity between scenes (if a character is by the window in scene 3, don't teleport them to a market in scene 4 without transition logic).
2. ESCALATION: Visual intensity should mirror narrative arc — quieter compositions for reflective moments, dynamic framing for conflict.
3. COVERAGE VARIETY: Vary shot scales across scenes. Don't use medium shots for everything. A sequence should feel like it was covered by a real film crew with multiple setups.
4. LIGHT CONTINUITY: If a scene takes place at golden hour, subsequent scenes moments later should maintain that time-of-day logic.
5. COLOR STORYTELLING: Use color shifts to track emotional arcs (e.g., warmer palette for hope/nostalgia, cooler for isolation/dread).
${numberingRule}
${languageRule}

Analyze the user's script and output a JSON array.`;
        // ────────────────────────────────────────────
        // USER PROMPT
        // ────────────────────────────────────────────
        const userPrompt = `**Script (Vietnamese):**\n---\n${data.script}\n---\n\nGenerate the scene prompts following every instruction above. Pour your cinematographic soul into each prompt.`;
        // ────────────────────────────────────────────
        // FINAL ASSEMBLY
        // ────────────────────────────────────────────
        const fieldsList = [
            'sceneName',
            'sceneDescription',
            includeImage ? 'imagePrompt' : null,
            includeVideo ? 'videoPrompt' : null,
        ].filter(Boolean).join(', ');
        const formatExampleFields = [
            `"sceneName":"Phân cảnh 1 (0s-${sceneDuration}s)"`,
            `"sceneDescription":"..."`,
            includeImage ? `"imagePrompt":"1. ..."` : null,
            includeVideo ? `"videoPrompt":"1. ..."` : null,
        ].filter(Boolean).join(',');
        const criticalRulesBody = [
            '1. Return ONLY a valid JSON array: [...]',
            '2. NO markdown code blocks (no ```json)',
            '3. NO explanatory text before or after the JSON',
            `4. Each scene object must have EXACTLY these fields: ${fieldsList}`,
            `5. Generate EXACTLY ${data.sceneCount} scenes \u2014 numbered 1, 2, 3, ..., ${data.sceneCount} in order. NO SKIPS. NO GAPS. NO MERGES. Response with less than ${data.sceneCount} items WILL BE REJECTED.`,
            '6. Start response with the [ character \u2014 nothing before it',
            includeImage ? '7. imagePrompt: ZERO movement verbs, ZERO dialogue, ZERO temporal words \u2014 frozen moment ONLY' : null,
            includeVideo ? `${includeImage ? '8' : '7'}. videoPrompt: ONE continuous sentence with full cinematic choreography${' '}(6 BEATS) + Vietnamese dialogue with English vocal direction` : null,
        ].filter(Boolean).join('\n');
        const fullPrompt = `${systemInstruction}

${userPrompt}

⚠️ CRITICAL OUTPUT RULES ⚠️:
${criticalRulesBody}

CORRECT FORMAT:
[{${formatExampleFields}}]`;
        logger.info('[PromptGen] Built Gemini prompt template (cinematic edition)', {
            promptLength: fullPrompt.length,
            style: data.style,
            outputType,
        });
        return fullPrompt;
    }
    /**
     * Build video-only prompt template for Gemini browser automation.
     * Delegates to buildGeminiPromptTemplate with outputType='video' to share the
     * same cinematic 6-BEAT structure, camera rig taxonomy, and vocal direction
     * rules used for combined prompts.
     */
    async buildGeminiVideoPromptTemplate(data) {
        return this.buildGeminiPromptTemplate({ ...data, outputType: 'video' });
    }
    /**
     * Build prompt template for Gemini browser automation specifically tailored for Short Videos.
     * Short videos have fixed 8-second segments — the 6-BEAT cinematic structure is compressed
     * so it still fits an 8-second window while keeping camera rig + vocal direction rigor.
     * When outputType is set, the corresponding fields are included/omitted.
     */
    async buildGeminiShortVideoPromptTemplate(data) {
        const outputType = data.outputType ?? 'both';
        const contentType = data.contentType ?? 'normal';
        logger.info('[PromptGen] Building Gemini short video prompt template', {
            style: data.style,
            aspectRatio: data.aspectRatio,
            outputType,
            contentType,
        });
        const includeImage = outputType === 'image' || outputType === 'both';
        const includeVideo = outputType === 'video' || outputType === 'both';
        const imageFieldIndex = 3;
        const videoFieldIndex = outputType === 'video' ? 3 : 4;
        const imageSpec = includeImage
            ? buildImagePromptSpec({ index: imageFieldIndex, style: data.style, aspectRatio: data.aspectRatio })
            : '';
        const videoSpec = includeVideo
            ? buildVideoPromptSpec({ index: videoFieldIndex, style: data.style, aspectRatio: data.aspectRatio })
            : '';
        const examples = buildExamplesBlock({
            includeImage,
            includeVideo,
            style: data.style,
            aspectRatio: data.aspectRatio,
        });
        const fieldsList = [
            'sceneName',
            'sceneDescription',
            includeImage ? 'imagePrompt' : null,
            includeVideo ? 'videoPrompt' : null,
        ].filter(Boolean).join(', ');
        const exampleFields = [
            '"sceneName":"Phân cảnh 1 (0s-8s)"',
            '"sceneDescription":"Nhân vật chính xuất hiện và nói..."',
            includeImage ? '"imagePrompt":"1. ..."' : null,
            includeVideo ? '"videoPrompt":"1. ..."' : null,
        ].filter(Boolean).join(',');
        const systemInstruction = `You are an expert prompt engineer and professional cinematographer for viral short-form videos (TikTok, YouTube Shorts, Reels). Your task: analyze a VIETNAMESE script and break it down into FIXED 8-second scenes, then produce prompts at feature-film quality.

══════════════════════════════════════════════
 TIME SEGMENTATION (8-second windows)
══════════════════════════════════════════════
- Accurately analyze the actual duration of the provided video/audio or script.
- Divide TOTAL DURATION by 8s to get the EXACT number of scenes (round UP if there's a remainder; the final scene may be shorter than 8s but still counts).
- Every scene represents exactly an 8-second window: Scene 1: 0s-8s, Scene 2: 8s-16s, …
- DO NOT arbitrarily pick 7-8 scenes. 16s → 2 scenes. 32s → 4 scenes. 60s → 8 scenes (last is 56s-60s).
- Scene division must respect the visual narrative, action, and dialogue timing.

══════════════════════════════════════════════
 OUTPUT SPECIFICATION
══════════════════════════════════════════════

┌─────────────────────────────────────────────┐
│  FIELD 1: sceneName                         │
│  Language: VIETNAMESE                       │
└─────────────────────────────────────────────┘
Format: "Phân cảnh [N] ([Start]s-[End]s)" — e.g. "Phân cảnh 1 (0s-8s)".

┌─────────────────────────────────────────────┐
│  FIELD 2: sceneDescription                  │
│  Language: VIETNAMESE                       │
└─────────────────────────────────────────────┘
A concise summary in VIETNAMESE of the action in this 8-second window. If there is dialogue/voiceover, include the EXACT Vietnamese text verbatim in the description.

${imageSpec}${imageSpec && videoSpec ? '\n\n' : ''}${videoSpec}

══════════════════════════════════════════════
 SHORT-FORM PACING NOTES (8s constraint)
══════════════════════════════════════════════
- Compress the 6 BEATS into ONE 8-second sentence — each beat should land quickly.
- Favor a SINGLE strong camera move per scene (no multi-chapter moves in 8s).
- Dialogue (STRICT): when the shot has speech, write 20–25 fast-paced Vietnamese words (~5–7s spoken), punchy and informal. Include English vocal direction inline. Avoid filler phrases.
- Hook (Shot 1 ONLY): MUST open with a pattern-interrupting hook — surprising claim, curiosity question, or sharp benefit. Shot 1 dialogue 15–20 ultra-punchy words.
- Music-only shots: when soft / instrumental music suits the visual better than speech, set the dialogue field to an empty string ("") — do NOT invent narration. Aim for ~1 music-only shot per 4–5 shots, typically mid-narrative or as the final beat for breathing room.
- Opening hook matters — the first 2 seconds must establish subject + lens + light.
${contentType === 'affiliate' ? `

══════════════════════════════════════════════
 AFFILIATE STRUCTURE (mandatory — contentType=affiliate)
══════════════════════════════════════════════
This is an AFFILIATE marketing video — every shot must serve the funnel: catch attention → show product → prove value → drive action.

Required scene roles (apply to the appropriate scenes based on count):
- Scene 1 — HOOK: pattern interrupt + product reveal in the first 1.5s. Dialogue is a punchy 15–20 word question or claim that sparks curiosity (e.g. "Bạn từng nghĩ thứ này có thật không?", "3 phút thôi, bạn sẽ tin nó rẻ thật").
- Scenes 2-3 — SHOWCASE: zoom / orbit on the product. Character interacts naturally (cầm / dùng / đặt cạnh). Dialogue calls out the pain point and how the product solves it. 20–25 words.
- Scene 4 (or middle) — BENEFIT: concrete proof — a number, a comparison, a before/after fact ("rẻ hơn 40%", "dùng 2 năm vẫn mới", "1 nút bấm là xong"). 20–25 words.
- Final scene — CTA: clear call to action — "link ở bio", "comment GET", "quét mã". 10–15 punchy words.

DIALOGUE LANGUAGE: 100% Vietnamese, casual TikTok / livestream tone. NO English code-switching except the literal brand name. Use slangy connectors (cái này, đây, xem nè, đỉnh thật).

NEGATIVE: avoid generic narration ("Hôm nay tôi sẽ giới thiệu..."), avoid corporate ad voice, avoid English filler ("amazing", "wow", "trust me").

` : ''}
${examples}

══════════════════════════════════════════════
 GLOBAL RULES
══════════════════════════════════════════════
1. NUMBERING: ${[includeImage ? 'imagePrompt' : null, includeVideo ? 'videoPrompt' : null].filter(Boolean).join(' and ')} MUST start with the segment number followed by ". " (e.g., "1. ...").
2. LANGUAGE: sceneName + sceneDescription = VIETNAMESE. ${[includeImage ? 'imagePrompt' : null, includeVideo ? 'videoPrompt' : null].filter(Boolean).join(' + ')} = ENGLISH (except Vietnamese dialogue in videoPrompt).
3. STYLE: Every prompt MUST seamlessly incorporate "${data.style}, ${data.aspectRatio} aspect ratio".
4. FORMAT: STRICT JSON Output with fields: ${fieldsList}.`;
        const userPrompt = `**Script (Vietnamese):**\n---\n${data.script}\n---\n\nSegment this script into exactly 8-second scenes and produce the prompts following every instruction above.`;
        const fullPrompt = `${systemInstruction}

${userPrompt}

⚠️ CRITICAL OUTPUT RULES ⚠️:
1. Return ONLY a valid JSON array: [...]
2. NO markdown code blocks (no \`\`\`json)
3. NO explanatory text before or after the JSON
4. EVERY scene represents an 8-second window (last scene may be shorter)
5. Start response directly with [ character
6. Each object must have EXACTLY these fields: ${fieldsList}

CORRECT FORMAT EXAMPLE:
[{${exampleFields}}]`;
        logger.info('[PromptGen] Built Gemini short video prompt template', {
            promptLength: fullPrompt.length,
            style: data.style,
            outputType,
        });
        return fullPrompt;
    }
    // =============================================
    // PRO EDITOR API METHODS (Replaces Browser Automation)
    // =============================================
    /**
     * Generate metadata and characters from idea (Pro Editor Step 1)
     */
    async generateMetadataFromIdea(data) {
        logger.info('[PromptGen] Generating metadata from idea', {
            ideaLength: data.idea.length,
            genre: data.genreId,
            style: data.visualStyleId,
        });
        const sceneCountInstruction = data.sceneCount === 'auto'
            ? 'Analyze the complexity of the story and decide an appropriate number of scenes (typically 8-15 for a short story).'
            : `Create exactly ${data.sceneCount} scenes.`;
        const systemInstruction = `You are an expert storyteller and screenplay writer. Your task is to analyze a story idea and create comprehensive metadata including highly detailed character descriptions optimized for AI image/video generation.

**INSTRUCTIONS:**
1. Create a compelling title in ${data.dialogueLanguage === 'vi-VN' ? 'Vietnamese' : 'English'}.
2. ${sceneCountInstruction}
3. Create DETAILED character descriptions (80-120 words each) optimized for AI generation consistency.
4. Each character description MUST include ALL of the following:

**CHARACTER DESCRIPTION STRUCTURE (80-120 words each):**
- **Age & Ethnicity:** Specific age range (e.g., "early 30s", "late teens") and cultural background
- **Face:** Shape, skin tone, distinctive features, default expression
- **Hair:** Style, color, length, texture
- **Eyes:** Color, shape, expressiveness
- **Body:** Height (approximate), build type (slim, athletic, stocky, etc.)
- **Clothing:** Primary outfit with colors, style, condition
- **Personality Indicators:** Posture, demeanor, emotional disposition
- **Signature Items:** Accessories or items always present

**EMOTION VOCABULARY for expressions:**
serene, determined, mischievous, weary, hopeful, stern, gentle, curious, confident, anxious, joyful, melancholic, fierce, compassionate, skeptical

**GENRE CONTEXT:** ${data.genreId}
**VISUAL STYLE:** ${data.visualStyleId}
**TARGET AUDIENCE:** ${data.audience}

**OUTPUT FORMAT (JSON):**
{
  "title": "Story title",
  "genre": "${data.genreId}",
  "audience": "${data.audience}",
  "summary": "Brief 2-3 sentence summary of the story",
  "mood": ["mood1", "mood2"],
  "sceneCount": number,
  "totalDuration": number (estimated seconds),
  "characters": [
    {
      "name": "Character name",
      "promptEn": "DETAILED English description 80-120 words: [Name], a [age] [ethnicity] [gender] with [face details], [hair], [eyes]. Standing [height] with a [build] build, [posture/demeanor]. Wears [clothing details]. [Personality indicators]. [Signature accessories].",
      "promptVi": "Vietnamese description"
    }
  ]
}`;
        const responseSchema = {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING' },
                genre: { type: 'STRING' },
                audience: { type: 'STRING' },
                summary: { type: 'STRING' },
                mood: { type: 'ARRAY', items: { type: 'STRING' } },
                sceneCount: { type: 'NUMBER' },
                totalDuration: { type: 'NUMBER' },
                characters: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            name: { type: 'STRING' },
                            promptEn: { type: 'STRING' },
                            promptVi: { type: 'STRING' },
                        },
                        required: ['name', 'promptEn'],
                    },
                },
            },
            required: ['title', 'genre', 'audience', 'sceneCount', 'characters'],
        };
        const userPrompt = `**Story Idea:**\n${data.idea}\n\nGenerate complete metadata with characters.`;
        const result = await this.callGeminiWithRetry('gemini-2.0-flash', systemInstruction, userPrompt, responseSchema, 0.8);
        logger.info('[PromptGen] Metadata generated successfully', {
            title: result.title,
            charactersCount: result.characters?.length || 0,
            sceneCount: result.sceneCount,
        });
        return result;
    }
    /**
     * Generate scene outlines from metadata (Pro Editor Step 2)
     */
    async generateSceneOutlines(data) {
        logger.info('[PromptGen] Generating scene outlines', {
            title: data.metadata.title,
            targetSceneCount: data.targetSceneCount,
        });
        const characterNames = (data.metadata.characters || []).map((c) => c.name).join(', ');
        const systemInstruction = `You are an expert screenplay writer. Create ${data.targetSceneCount} scene outlines for the story.

**STORY CONTEXT:**
- Title: ${data.metadata.title}
- Genre: ${data.metadata.genre}
- Audience: ${data.audience}
- Characters: ${characterNames}
- Summary: ${data.metadata.summary || data.idea}

**INSTRUCTIONS:**
1. Create exactly ${data.targetSceneCount} scenes that tell a complete story arc.
2. Each scene should have a clear purpose in the narrative.
3. Include character interactions and emotional progression.
4. Ensure SMOOTH TRANSITIONS between scenes with the transitionToNext field.
5. Follow the three-act structure:
   - Act 1 (Setup): First 25% - Introduce characters, setting, and initial conflict
   - Act 2 (Confrontation): Middle 50% - Rising action, obstacles, character development
   - Act 3 (Resolution): Final 25% - Climax and resolution

**EMOTIONAL ARC VOCABULARY:**
Use these emotions: hopeful, curious, tense, anxious, determined, joyful, melancholic, surprised, fearful, relieved, triumphant, heartwarming, bittersweet, contemplative, excited

**TRANSITION TYPES:**
- "cut_to" - Direct scene change
- "dissolve" - Gradual blend (time passage)
- "fade_out" - End of sequence/chapter
- "match_cut" - Visual similarity connection
- "continuation" - Same location/time continues

**OUTPUT FORMAT (JSON array):**
[
  {
    "sceneNumber": 1,
    "title": "Scene title in ${data.dialogueLanguage === 'vi-VN' ? 'Vietnamese' : 'English'}",
    "description": "What happens in this scene (2-3 sentences)",
    "characters": ["Character1", "Character2"],
    "emotion": "Main emotion (use vocabulary above)",
    "setting": "Where the scene takes place (specific location details)",
    "narrativePurpose": "setup/rising_action/climax/falling_action/resolution",
    "transitionToNext": "cut_to/dissolve/fade_out/match_cut/continuation"
  }
]`;
        const responseSchema = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    sceneNumber: { type: 'NUMBER' },
                    title: { type: 'STRING' },
                    description: { type: 'STRING' },
                    characters: { type: 'ARRAY', items: { type: 'STRING' } },
                    emotion: { type: 'STRING' },
                    setting: { type: 'STRING' },
                    narrativePurpose: { type: 'STRING' },
                    transitionToNext: { type: 'STRING' },
                },
                required: ['sceneNumber', 'title', 'description', 'emotion', 'setting'],
            },
        };
        const userPrompt = `Original idea: ${data.idea}\n\nCreate ${data.targetSceneCount} scene outlines following the three-act structure.`;
        const result = await this.callGeminiWithRetry('gemini-2.0-flash', systemInstruction, userPrompt, responseSchema, 0.8);
        logger.info('[PromptGen] Scene outlines generated', { count: result.length });
        return result;
    }
    /**
     * Generate detailed scenes with veoPrompt (Pro Editor Step 3)
     */
    async generateDetailedScenes(data) {
        logger.info('[PromptGen] Generating detailed scenes with veoPrompt', {
            outlinesCount: data.sceneOutlines.length,
            visualStyle: data.visualStyleId,
        });
        // Build character descriptions for prompt context
        const characterDescriptions = (data.metadata.characters || [])
            .map((c) => `- ${c.name}: ${c.promptEn}`)
            .join('\n');
        const systemInstruction = `You are an expert AI prompt engineer and cinematographer for video generation. Create detailed scene data with professional video generation prompts.

**CHARACTER DESCRIPTIONS (Use EXACTLY as written - copy FULL description):**
${characterDescriptions || 'No predefined characters.'}

**VISUAL STYLE:** ${data.visualStyleId}
**GENRE:** ${data.metadata.genre}

**CAMERA MOVEMENT VOCABULARY (Use these terms precisely):**
- **SHOT TYPES:** extreme wide shot (EWS), wide shot (WS), medium wide shot (MWS), medium shot (MS), medium close-up (MCU), close-up (CU), extreme close-up (ECU), over-the-shoulder (OTS), two-shot, POV shot, bird's eye view, low angle, high angle, dutch angle
- **CAMERA MOVEMENTS:** static shot, slow pan left/right, pan left/right, slow tilt up/down, tilt up/down, dolly in/out, tracking shot, crane shot up/down, steadicam follow, handheld, orbit around subject, push in, pull out
- **TRANSITIONS:** cut, dissolve, fade, match cut, whip pan
- **FOCUS:** rack focus, shallow depth of field, deep focus
- **TIMING:** slow motion, real-time, time-lapse

**EMOTIONAL BEAT VOCABULARY:**
tense, heartwarming, suspenseful, triumphant, melancholic, joyful, anxious, serene, dramatic, comedic, mysterious, romantic, action-packed, contemplative, climactic

**INSTRUCTIONS:**
For each scene outline, generate:
1. A Vietnamese description of the scene (2-3 sentences)
2. A DETAILED English video generation prompt (veoPrompt 100-150 words) that includes:
   - **[Shot Type]** at the beginning (e.g., "Wide shot," "Close-up,")
   - **Character Descriptions:** Copy FULL character descriptions from above for each character present
   - **Camera Movement:** Specify using vocabulary above
   - **Character Actions:** Detailed movements, gestures, expressions
   - **Environmental Details:** Setting, lighting, atmosphere, weather
   - **Emotional Beat:** The feeling this scene should evoke
   - **Style Integration:** ${data.visualStyleId}
   - **Ending:** ", no text, textless, no words, no letters"

**OUTPUT FORMAT (JSON array):**
[
  {
    "sceneNumber": 1,
    "displayOrder": 1,
    "title": "Scene title",
    "description": "Vietnamese description (2-3 sentences)",
    "veoPrompt": "[Shot Type], [Character with FULL description], [Camera Movement], [Actions], [Environment], [Emotional beat], ${data.visualStyleId} style, cinematic lighting, no text, textless, no words, no letters",
    "duration": 8,
    "characters": ["Character1"],
    "emotion": "Use emotion vocabulary above",
    "cameraShot": "wide_shot/medium_shot/close_up/etc",
    "cameraMovement": "static/pan/dolly/tracking/etc"
  }
]`;
        const outlinesText = data.sceneOutlines.map(o => `Scene ${o.sceneNumber}: ${o.title}\n${o.description}\nCharacters: ${o.characters?.join(', ') || 'None'}\nSetting: ${o.setting || 'Unspecified'}\nEmotion: ${o.emotion || 'neutral'}\nTransition: ${o.transitionToNext || 'cut_to'}`).join('\n\n');
        const responseSchema = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    sceneNumber: { type: 'NUMBER' },
                    displayOrder: { type: 'NUMBER' },
                    title: { type: 'STRING' },
                    description: { type: 'STRING' },
                    veoPrompt: { type: 'STRING' },
                    duration: { type: 'NUMBER' },
                    characters: { type: 'ARRAY', items: { type: 'STRING' } },
                    emotion: { type: 'STRING' },
                    cameraShot: { type: 'STRING' },
                    cameraMovement: { type: 'STRING' },
                },
                required: ['sceneNumber', 'displayOrder', 'title', 'description', 'veoPrompt', 'emotion'],
            },
        };
        const userPrompt = `**Scene Outlines:**\n${outlinesText}\n\nGenerate detailed scenes with professional video prompts using the camera vocabulary provided.`;
        const result = await this.callGeminiWithRetry('gemini-2.0-flash', systemInstruction, userPrompt, responseSchema, 0.7);
        logger.info('[PromptGen] Detailed scenes generated', { count: result.length });
        return result;
    }
    /**
     * Convert raw text to script format (Pro Editor - From Text mode)
     */
    async convertTextToScript(data) {
        logger.info('[PromptGen] Converting text to script', {
            textLength: data.text.length,
            title: data.title,
        });
        const systemInstruction = `You are an expert screenplay adapter. Convert the provided text into a structured screenplay format.

**INSTRUCTIONS:**
1. Analyze the text and identify characters.
2. Break the text into logical scenes.
3. Create video generation prompts for each scene.
4. Style: ${data.visualStyleId}
5. Genre: ${data.genreId}
6. Audience: ${data.audience}

**OUTPUT FORMAT (JSON):**
{
  "metadata": {
    "title": "${data.title}",
    "genre": "${data.genreId}",
    "audience": "${data.audience}",
    "summary": "Brief summary",
    "sceneCount": number,
    "characters": [
      {
        "name": "Name",
        "promptEn": "English description",
        "promptVi": "Vietnamese description"
      }
    ]
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "displayOrder": 1,
      "title": "Scene title",
      "description": "Vietnamese description",
      "veoPrompt": "English video prompt..., ${data.visualStyleId} style, no text, textless",
      "duration": 8,
      "characters": ["Character1"]
    }
  ]
}`;
        const responseSchema = {
            type: 'OBJECT',
            properties: {
                metadata: {
                    type: 'OBJECT',
                    properties: {
                        title: { type: 'STRING' },
                        genre: { type: 'STRING' },
                        audience: { type: 'STRING' },
                        summary: { type: 'STRING' },
                        sceneCount: { type: 'NUMBER' },
                        characters: {
                            type: 'ARRAY',
                            items: {
                                type: 'OBJECT',
                                properties: {
                                    name: { type: 'STRING' },
                                    promptEn: { type: 'STRING' },
                                    promptVi: { type: 'STRING' },
                                },
                            },
                        },
                    },
                },
                scenes: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            sceneNumber: { type: 'NUMBER' },
                            displayOrder: { type: 'NUMBER' },
                            title: { type: 'STRING' },
                            description: { type: 'STRING' },
                            veoPrompt: { type: 'STRING' },
                            duration: { type: 'NUMBER' },
                            characters: { type: 'ARRAY', items: { type: 'STRING' } },
                        },
                    },
                },
            },
            required: ['metadata', 'scenes'],
        };
        const userPrompt = `**Text to convert:**\n${data.text}\n\nConvert this to a screenplay format.`;
        const result = await this.callGeminiWithRetry('gemini-2.0-flash', systemInstruction, userPrompt, responseSchema, 0.7);
        // Save to database
        const prismaAny = prisma;
        const savedScript = await prismaAny.script.create({
            data: {
                name: data.title,
                genre: data.genreId,
                audience: data.audience,
                metadata: result.metadata,
                characters: result.metadata.characters,
                source: 'pro-editor-text',
                scenes: {
                    create: result.scenes.map((scene, index) => ({
                        sceneNumber: scene.sceneNumber || index + 1,
                        displayOrder: scene.displayOrder || index + 1,
                        title: scene.title,
                        description: scene.description,
                        veoPrompt: scene.veoPrompt,
                        duration: scene.duration || 8,
                        characters: scene.characters || [],
                    })),
                },
            },
            include: { scenes: true },
        });
        logger.info('[PromptGen] Text converted to script and saved', {
            scriptId: savedScript.id,
            scenesCount: savedScript.scenes.length,
        });
        return {
            scriptId: savedScript.id,
            metadata: result.metadata,
            scenes: savedScript.scenes,
        };
    }
    /**
     * Expand a prompt using Veo3's generateExpandedPrompt API with style guidelines
     *
     * @param data - User prompt, style, cookies, and optional sessionId
     * @returns Expanded prompt suitable for video generation
     */
    async expandPromptByStyle(data) {
        logger.info('[PromptGen] Expanding prompt by style', {
            userPromptLength: data.userPrompt.length,
            style: data.style,
            hasSessionId: !!data.sessionId,
        });
        try {
            const { Veo3Service } = await import('../../services/veo3/veo3Service.js');
            const { StyleConfigService } = await import('../styleConfig/styleConfig.service.js');
            // Get style preamble
            const normalizedStyleId = this.normalizeStyleId(data.style);
            const stylePreamble = StyleConfigService.getPreambleByStyleId(normalizedStyleId);
            const veo3Service = new Veo3Service();
            veo3Service.updateConfig({
                cookies: data.cookies,
            });
            const expandedPrompt = await veo3Service.expandPromptByStyle(data.userPrompt, stylePreamble, data.sessionId);
            logger.info('[PromptGen] Prompt expansion complete', {
                originalLength: data.userPrompt.length,
                expandedLength: expandedPrompt.length,
                expansion: ((expandedPrompt.length - data.userPrompt.length) / data.userPrompt.length * 100).toFixed(1) + '%',
            });
            return expandedPrompt;
        }
        catch (error) {
            logger.error('[PromptGen] Prompt expansion failed, returning original', {
                error: error.message,
                userPromptLength: data.userPrompt.length,
            });
            // Return original prompt if expansion fails
            return data.userPrompt;
        }
    }
    /**
     * Expand all scene prompts with Veo3 style-based expansion
     *
     * @param data - Scenes array, style, cookies, and optional sessionId
     * @returns Scenes with expanded videoPrompts
     */
    async expandScenes(data) {
        logger.info('[PromptGen] Expanding scenes', {
            sceneCount: data.scenes.length,
            style: data.style,
        });
        try {
            const { StyleConfigService } = await import('../styleConfig/styleConfig.service.js');
            const normalizedStyleId = this.normalizeStyleId(data.style);
            const stylePreamble = StyleConfigService.getPreambleByStyleId(normalizedStyleId);
            // Expand each scene's videoPrompt in parallel
            const expandedScenes = await Promise.all(data.scenes.map(async (scene) => {
                try {
                    const expandedPrompt = await this.expandPromptByStyle({
                        userPrompt: scene.videoPrompt,
                        style: data.style,
                        cookies: data.cookies,
                        sessionId: data.sessionId,
                    });
                    return {
                        ...scene,
                        expandedVideoPrompt: expandedPrompt,
                    };
                }
                catch (error) {
                    logger.warn('[PromptGen] Failed to expand single scene, using original', {
                        sceneName: scene.sceneName,
                        error: error.message,
                    });
                    return {
                        ...scene,
                        expandedVideoPrompt: scene.videoPrompt,
                    };
                }
            }));
            logger.info('[PromptGen] Scene expansion complete', {
                sceneCount: expandedScenes.length,
            });
            return expandedScenes;
        }
        catch (error) {
            logger.error('[PromptGen] Scene expansion failed', {
                error: error.message,
                sceneCount: data.scenes.length,
            });
            // Return original scenes if expansion fails
            return data.scenes.map((scene) => ({
                ...scene,
                expandedVideoPrompt: scene.videoPrompt,
            }));
        }
    }
    /**
     * Rewrite a prompt to avoid Veo3 content policy violations.
     * Used by Pipeline auto-fix when a job fails due to policy error.
     */
    async rewritePromptForPolicy(originalPrompt, errorMessage) {
        const systemInstruction = `You are a creative prompt rewriter for an AI video/image generation tool (Google Veo3/Imagen).
The user's prompt was rejected by the content safety filter. Your job is to rewrite the prompt to:
1. Preserve the original creative intent as much as possible
2. Remove or rephrase any elements that might trigger content policy violations
3. Keep the same visual style, mood, and scene composition
4. Avoid violence, gore, explicit content, real people's names, copyrighted characters
5. Use artistic/abstract language for sensitive topics
6. Return ONLY the rewritten prompt text, nothing else.`;
        const userPrompt = `Original prompt that was rejected:
"""
${originalPrompt}
"""

Error from the safety filter:
"""
${errorMessage}
"""

Please rewrite this prompt to avoid the content policy violation while keeping the creative intent. Return only the rewritten prompt.`;
        const result = await this.callGeminiWithRetry('gemini-2.0-flash', systemInstruction, userPrompt, undefined, 0.5);
        // Clean up — remove quotes if Gemini wraps the result
        return result.replace(/^["']|["']$/g, '').trim();
    }
}
export const promptGeneratorService = new PromptGeneratorService();
