/**
 * Flow (flow.google.com) BOQ `batchexecute` transport.
 *
 * Google retired parts of the labs.google tRPC API in Sept 2026 — `project.createProject`,
 * `videoFx.getVideoModelConfig` and `flow.projectInitialData` now answer 404
 * "Flow RPCs have been deprecated and disabled". The web app moved to the BOQ RPC
 * transport on flow.google.com, which differs in two ways that matter here:
 *
 *   - Wire format: form-encoded `f.req` carrying JSON-inside-JSON, and a response
 *     made of length-prefixed chunks behind an XSSI prefix.
 *   - Auth: plain Google web cookies (the OSID family) plus an XSRF token read from
 *     the page — no ya29 Bearer. The aisandbox-pa video API still uses the Bearer,
 *     so both lanes coexist.
 *
 * The per-session values (`at`, `bl`, `f.sid`) come from `WIZ_global_data` embedded in
 * the flow.google.com HTML, so a bootstrap fetch precedes the first RPC of each session.
 */
import { tlsFetch, recycleTlsSession } from './tlsClient.js';
import { getCookieHeader, invalidateCookieJar, ESSENTIAL_COOKIE_NAMES } from './cookieJar.js';
import { globalProxyManager } from './GlobalProxyManager.js';
import { getProfileCookiesCompat } from '../utils/profileCookies.js';
import { logger } from './logger.js';
import { getHostUa } from './hostChromeUa.js';
const BOQ_ENDPOINT = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute';
const FLOW_ORIGIN = 'https://flow.google.com';
const FLOW_HOME = 'https://flow.google.com/';
/** Keys inside `WIZ_global_data` on the Flow page. */
const WIZ_KEYS = {
    xsrfToken: 'SNlM0e',
    buildLabel: 'cfb2h',
    sessionId: 'FdrFJe',
    /** Signed-in account email — absent on the logged-out shell. */
    email: 'oPEP7c',
};
/**
 * Flow BOQ methods this app uses. Each id was captured from the live web client;
 * keep new ones here so there is one list to check when Google renames a method.
 * See docs/flow-api-migration.md for how to capture a new id.
 */
export const FLOW_RPC = {
    /** Create a project → `["<uuid>", ["<name>"]]` */
    createProject: 'jHPbke',
    /** Credits / quota → `[credits, tier, serviceTier, sku, null, subscriptionCredits]` */
    credits: 'nzlxg',
    /** Project data incl. the preset voice catalogue → payload[3] is the voice list */
    projectData: 'Zzl0ze',
    /** Video model catalogue (replaces videoFx.getVideoModelConfig) */
    videoModelConfig: 'HTrJv',
    /** Image upsample / download process → SPrCad */
    upsampleImage: 'SPrCad',
    /**
     * Upload an image into a project → payload[0][0] is the mediaId (UUID). Replaces
     * the REST `aisandbox-pa …/v1/flow/uploadImage`, which answers 400 since Sept 2026.
     */
    uploadImage: 'maseQ',
    /** Telemetry events batching → WuwhI */
    telemetry: 'WuwhI',
    /** Auxiliary status / ping → DTaVef */
    auxStatus: 'DTaVef',
};
const SESSION_TTL_MS = 10 * 60000;
const REQUEST_TIMEOUT_MS = 30000;
/** Matches the real host Chrome used by the verification-browser lane. */
const DEFAULT_USER_AGENT = getHostUa();
/** Flow answered with its logged-out shell — cookies cannot be repaired by retrying. */
export class FlowSignedOutError extends Error {
    constructor(detail) {
        super('Chưa đăng nhập Flow trên profile này (flow.google.com trả về trang đăng nhập). ' +
            'Mở Profiles → Đăng nhập lại để cấp phiên mới.' +
            (detail ? ` [${detail}]` : ''));
        this.code = 'FLOW_SIGNED_OUT';
        this.name = 'FlowSignedOutError';
    }
}
/**
 * Mã trạng thái gRPC Google trả ở ô thứ 6 của hàng `wrb.fr`. Dịch sang tên để log
 * đọc được ngay, khỏi tra bảng.
 */
const GRPC_STATUS = {
    1: 'CANCELLED',
    2: 'UNKNOWN',
    3: 'INVALID_ARGUMENT',
    4: 'DEADLINE_EXCEEDED',
    5: 'NOT_FOUND',
    6: 'ALREADY_EXISTS',
    7: 'PERMISSION_DENIED',
    8: 'RESOURCE_EXHAUSTED',
    9: 'FAILED_PRECONDITION',
    10: 'ABORTED',
    11: 'OUT_OF_RANGE',
    12: 'UNIMPLEMENTED',
    13: 'INTERNAL',
    14: 'UNAVAILABLE',
    15: 'DATA_LOSS',
    16: 'UNAUTHENTICATED',
};
/** The RPC reached Flow but came back without a usable payload. */
export class FlowRpcError extends Error {
    constructor(rpcid, message, status) {
        super(`Flow RPC ${rpcid} thất bại: ${message}`);
        this.code = 'FLOW_RPC_ERROR';
        this.name = 'FlowRpcError';
        this.rpcid = rpcid;
        this.status = status;
    }
}
const sessionByProfile = new Map();
const bootstrapInFlight = new Map();
/**
 * BOQ expects a monotonic per-tab counter. Keep one sequence per profile: a
 * single process-wide counter would let Google line up requests from different
 * accounts as one arithmetic series.
 */
const reqIdByProfile = new Map();
function nextReqId(profileId) {
    const next = (reqIdByProfile.get(profileId) ?? Math.floor(Math.random() * 900000) + 100000) + 100;
    reqIdByProfile.set(profileId, next);
    return next;
}
/** Same egress as every other Google call for this profile. */
const currentProxyUrl = () => globalProxyManager.getCurrentHttpProxyUrl() ?? undefined;
/**
 * Cookie header for flow.google.com.
 *
 * The live Chrome jar is the best source, but it needs the Electron IPC bridge.
 * When that is unreachable the rest of the app falls back to the partition /
 * login snapshot, and so must this — otherwise a momentary bridge hiccup is
 * reported to the user as "you are signed out of Flow", which it is not.
 */
async function flowCookieHeader(profileId) {
    const live = await getCookieHeader(profileId, FLOW_HOME).catch(() => '');
    if (live.trim())
        return live;
    const { parsed } = await getProfileCookiesCompat({ id: profileId });
    if (!parsed)
        return '';
    // Same allow-list as the live jar so both paths send the same cookies, and
    // the copy whose domain is most specific to flow.google.com wins — sending
    // every Google cookie overflows the header (flow answers 431).
    const best = new Map();
    for (const cookie of parsed) {
        const name = typeof cookie?.name === 'string' ? cookie.name : '';
        const domain = (typeof cookie?.domain === 'string' ? cookie.domain : '').toLowerCase();
        if (!name || !ESSENTIAL_COOKIE_NAMES.has(name))
            continue;
        const bare = domain.startsWith('.') ? domain.slice(1) : domain;
        const score = bare === 'flow.google.com' ? 2 : bare === 'google.com' ? 1 : 0;
        if (score === 0)
            continue;
        const prev = best.get(name);
        if (!prev || prev.score < score)
            best.set(name, { value: String(cookie.value ?? ''), score });
    }
    if (best.size > 0) {
        logger.warn(`[FlowBoq] ${profileId.substring(0, 8)}: cookie jar trống, dùng snapshot partition`);
    }
    return [...best].map(([name, { value }]) => `${name}=${value}`).join('; ');
}
function readWizValue(html, key) {
    const match = html.match(new RegExp(`"${key}":"([^"]*)"`));
    return match?.[1] ?? null;
}
async function bootstrapSession(profileId, userAgent) {
    const cookies = await flowCookieHeader(profileId);
    const res = await tlsFetch({
        profileId,
        url: FLOW_HOME,
        method: 'GET',
        headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'user-agent': userAgent,
            'upgrade-insecure-requests': '1',
        },
        cookies,
        proxyUrl: currentProxyUrl(),
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) {
        throw new FlowRpcError('bootstrap', `GET flow.google.com → HTTP ${res.status}`, res.status);
    }
    const xsrfToken = readWizValue(res.body, WIZ_KEYS.xsrfToken);
    const buildLabel = readWizValue(res.body, WIZ_KEYS.buildLabel);
    const sessionId = readWizValue(res.body, WIZ_KEYS.sessionId);
    const email = readWizValue(res.body, WIZ_KEYS.email);
    // The logged-out shell still renders WIZ_global_data, minus the account entry —
    // so the email is what separates "not signed in" from "page shape changed".
    if (!xsrfToken || !buildLabel || !sessionId) {
        throw email
            ? new FlowRpcError('bootstrap', 'WIZ_global_data thiếu at/bl/f.sid — Flow có thể đã đổi trang')
            : new FlowSignedOutError('không tìm thấy phiên trong WIZ_global_data');
    }
    if (!email)
        throw new FlowSignedOutError('WIZ_global_data không có tài khoản đăng nhập');
    logger.info(`[FlowBoq] session ready for ${profileId.substring(0, 8)} (${email}) bl=${buildLabel}`);
    return { xsrfToken, buildLabel, sessionId, email, fetchedAt: Date.now() };
}
async function getSession(profileId, userAgent) {
    const cached = sessionByProfile.get(profileId);
    if (cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) {
        return { session: cached, fromCache: true };
    }
    const existingBootstrap = bootstrapInFlight.get(profileId);
    if (existingBootstrap)
        return existingBootstrap.then((session) => ({ session, fromCache: false }));
    const promise = bootstrapSession(profileId, userAgent)
        .then((session) => {
        sessionByProfile.set(profileId, session);
        return session;
    })
        .finally(() => bootstrapInFlight.delete(profileId));
    bootstrapInFlight.set(profileId, promise);
    return promise.then((session) => ({ session, fromCache: false }));
}
/**
 * Drop the cached bootstrap so the next call re-reads `at`/`bl`/`f.sid`, and the
 * cookie jar with it — a rejected request would otherwise be retried with the
 * very cookies it was just refused for. Scoped to `used` so a slow caller cannot
 * discard a session another call bootstrapped in the meantime.
 */
export function invalidateFlowSession(profileId, used) {
    const cached = sessionByProfile.get(profileId);
    if (!used || cached === used)
        sessionByProfile.delete(profileId);
    invalidateCookieJar(profileId);
}
/**
 * Pull the payload for `rpcid` out of a batchexecute response.
 *
 * Shape: an XSSI prefix, then repeating `<byteLength>\n<json chunk>`. The chunk
 * holding the answer is `["wrb.fr", rpcid, "<json string>", …]`; `["er", …]` carries
 * an RPC error. The trailing `["e", 4, …]` row is a normal end-of-stream marker and
 * must NOT be read as a failure.
 *
 * Chunk lengths count BYTES while JS slices UTF-16 units, and real payloads contain
 * multibyte text, so chunks are reassembled by parsing rather than by offset.
 */
export function parseBatchExecute(body, rpcid) {
    const text = body.replace(/^\)\]\}'\s*/, '');
    const rows = [];
    let buffer = '';
    for (const line of text.split('\n')) {
        // A bare number between chunks is the length header. Safe only because BOQ
        // never sends a bare numeric chunk — a JSON value always starts with `[`.
        if (buffer === '' && /^\d+$/.test(line.trim()))
            continue;
        buffer += line;
        try {
            const chunk = JSON.parse(buffer);
            buffer = '';
            if (!Array.isArray(chunk))
                continue;
            for (const row of chunk) {
                if (!Array.isArray(row))
                    continue;
                // Fail on an error row as soon as it appears, so a later success row
                // for the same rpcid cannot mask it.
                if (row[0] === 'er') {
                    throw new FlowRpcError(rpcid, `upstream error ${JSON.stringify(row.slice(1)).slice(0, 200)}`);
                }
                rows.push(row);
            }
        }
        catch (err) {
            if (err instanceof FlowRpcError)
                throw err;
            buffer += '\n'; // chunk spans more lines — keep accumulating
        }
    }
    // Leftover text means the body was cut off mid-chunk; report that rather than
    // the identical-looking "no row for this rpcid".
    if (buffer.trim()) {
        throw new FlowRpcError(rpcid, `phản hồi bị cắt ngắn: ${buffer.trim().slice(0, 120)}`);
    }
    const answer = rows.find((row) => row[0] === 'wrb.fr' && row[1] === rpcid);
    if (!answer) {
        throw new FlowRpcError(rpcid, `không có kết quả trong phản hồi: ${body.slice(0, 200)}`);
    }
    // Một hàng hỏng trông như ["wrb.fr", rpcid, null, null, null, [13], "generic"]:
    // payload rỗng NHƯNG ô thứ 6 mang mã lỗi. Trả null ở đây khiến caller tưởng
    // "Google không có dữ liệu" trong khi thật ra là bị từ chối.
    const payload = answer[2];
    if (payload == null) {
        const status = Array.isArray(answer[5]) ? answer[5][0] : undefined;
        if (typeof status === 'number') {
            const name = GRPC_STATUS[status];
            throw new FlowRpcError(rpcid, `Google từ chối, mã ${status}${name ? ` (${name})` : ''}`, status);
        }
        return null;
    }
    if (typeof payload !== 'string')
        return payload;
    try {
        return JSON.parse(payload);
    }
    catch {
        return payload;
    }
}
async function postRpc(profileId, session, rpcid, args, userAgent, sourcePath, timeoutMs) {
    const envelope = JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]);
    const params = new URLSearchParams({
        rpcids: rpcid,
        'source-path': sourcePath,
        bl: session.buildLabel,
        'f.sid': session.sessionId,
        hl: 'vi',
        _reqid: String(nextReqId(profileId)),
        rt: 'c',
    });
    const res = await tlsFetch({
        profileId,
        url: `${BOQ_ENDPOINT}?${params.toString()}`,
        method: 'POST',
        headers: {
            accept: '*/*',
            'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            origin: FLOW_ORIGIN,
            referer: FLOW_HOME,
            'user-agent': userAgent,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'x-same-domain': '1',
        },
        cookies: await flowCookieHeader(profileId),
        proxyUrl: currentProxyUrl(),
        body: `f.req=${encodeURIComponent(envelope)}&at=${encodeURIComponent(session.xsrfToken)}&`,
        timeoutMs,
    });
    return { status: res.status, body: res.body };
}
/**
 * Call one Flow BOQ RPC and return its decoded payload.
 *
 * A rejected or stale session is retried exactly once against a fresh bootstrap;
 * a second failure is surfaced so callers do not spin.
 */
export async function callFlowRpc(profileId, rpcid, args, opts = {}) {
    if (!profileId)
        throw new FlowRpcError(rpcid, 'thiếu profileId');
    const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    // The web client sends the path of the page making the call. Flow answers the
    // same either way, but matching it keeps our traffic shaped like a real tab.
    const sourcePath = opts.sourcePath ?? '/';
    for (let attempt = 0; attempt < 2; attempt++) {
        const { session, fromCache } = await getSession(profileId, userAgent);
        const resolvedArgs = typeof args === 'function' ? await args() : args;
        const { status, body } = await postRpc(profileId, session, rpcid, resolvedArgs, userAgent, sourcePath, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
        // A 200 means Flow accepted and ran the RPC. Retrying an unreadable answer
        // would re-run a non-idempotent call (createProject would make a second
        // project), so the parse error is surfaced instead.
        if (status === 200) {
            return parseBatchExecute(body, rpcid);
        }
        // Status 0 is node-tls-client's "connection never completed" — the shared
        // TLS session may be wedged, so recycle it like every other Google lane.
        if (status === 0) {
            recycleTlsSession(profileId, `flow-boq ${rpcid} connection failed`);
        }
        // 400 means "bad request", not "stale session" — only worth another round
        // trip when the session we used was a cached one that may have expired.
        const sessionMayBeStale = status === 401 || status === 403 || (status === 400 && fromCache);
        if (sessionMayBeStale && attempt === 0) {
            invalidateFlowSession(profileId, session);
            logger.warn(`[FlowBoq] ${rpcid}: HTTP ${status}, bootstrap lại rồi thử lại`);
            continue;
        }
        throw new FlowRpcError(rpcid, `HTTP ${status} — ${body.slice(0, 200)}`, status);
    }
    throw new FlowRpcError(rpcid, 'hết lượt thử sau khi làm mới phiên');
}
