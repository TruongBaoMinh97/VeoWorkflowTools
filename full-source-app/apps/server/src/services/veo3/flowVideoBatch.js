/**
 * Pure helpers for sending several video rows in ONE Flow call (one token), the way the web client does.
 * Kept free of network and captcha imports so they can be unit-tested on their own.
 */
/** Rows the web client was seen to put in one call. */
export const MAX_ROWS_PER_RPC = 4;
/**
 * On by default (confirmed live 2026-10-31: 2 and 4 rows with different prompts, replies in row order).
 * `VEO3_VIDEO_SINGLE_RPC=0` goes back to one call and one token per video.
 */
export function isSingleRpcEnabled(env = process.env) {
    return env.VEO3_VIDEO_SINGLE_RPC !== '0';
}
/**
 * Refusals that belong to ONE row's content (policy, safety, people filters). When a multi-row call fails
 * like this, the other rows are probably fine, so the group is re-sent row by row to find the culprit.
 * Account-wide failures (reCAPTCHA, traffic, quota, model access) fail every row alike: never split on those.
 */
const ROW_SPECIFIC_FAILURE = /PUBLIC_ERROR_(?:MINOR_UPLOAD|AUDIO_FILTERED|UNSAFE_GENERATION|SEXUAL|VIOLENCE|HATE|HARASSMENT|DANGEROUS|IP_VIOLATION|COPYRIGHT|CELEBRITY|PUBLIC_FIGURE|PROMINENT_PEOPLE_FILTER_FAILED)|content policy|policy violation|Prompt bị từ chối/i;
export function isRowSpecificFailure(...texts) {
    return texts.some((t) => !!t && ROW_SPECIFIC_FAILURE.test(t));
}
/**
 * Indexes of the rows to send together. Rows with the same key share a call, in first-seen order of the
 * key; a group is cut into calls of at most `limit` rows. Order inside a call follows the original order.
 */
export function groupRowsForRpc(rows, limit = MAX_ROWS_PER_RPC) {
    const byKey = new Map();
    for (const { index, groupKey } of rows) {
        const bucket = byKey.get(groupKey);
        if (bucket)
            bucket.push(index);
        else
            byKey.set(groupKey, [index]);
    }
    const calls = [];
    for (const bucket of byKey.values()) {
        for (let i = 0; i < bucket.length; i += limit)
            calls.push(bucket.slice(i, i + limit));
    }
    return calls;
}
/**
 * Pair the operations Flow returned with the rows we sent, by position. Whether Flow keeps the order is
 * still to be confirmed live, so a shortfall is reported, never filled by guessing.
 */
export function assignOperationsToRows(operations, rowCount) {
    const assigned = Array.from({ length: rowCount }, (_, i) => operations[i]);
    const missingRows = assigned.flatMap((op, i) => (op === undefined ? [i] : []));
    return { assigned, missingRows, extra: Math.max(0, operations.length - rowCount) };
}
/** Failures that hit every row alike: splitting the group would only burn more tokens and requests. */
const ACCOUNT_WIDE_FAILURE = /UNUSUAL_ACTIVITY|TOO_MUCH_TRAFFIC|RESOURCE_EXHAUSTED|QUOTA|MODEL_ACCESS_DENIED|PERMISSION_DENIED|reCAPTCHA|captcha|cookies?\b|đăng nhập|UNAUTHENTICATED|\b(?:401|403|429)\b/i;
/** The call may have reached Flow without us seeing the answer; re-sending its rows could submit them twice. */
const TRANSPORT_FAILURE = /timed? ?out|timeout|HTTP 0\b|connection|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|socket|fetch failed|network/i;
/**
 * Should a failed multi-row call be re-sent row by row? Yes when Flow itself answered with a rejection that
 * is not about the whole account (content policy, invalid argument, no operation returned): the healthy rows
 * then still go through and only the offender is reported. No for account-wide or transport failures.
 */
export function shouldIsolateRows(...texts) {
    const present = texts.filter((t) => !!t);
    if (present.length === 0)
        return false;
    if (isRowSpecificFailure(...present))
        return true;
    if (present.some((t) => ACCOUNT_WIDE_FAILURE.test(t) || TRANSPORT_FAILURE.test(t)))
        return false;
    return true;
}
