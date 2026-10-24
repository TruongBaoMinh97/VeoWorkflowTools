import { timingSafeEqual } from 'node:crypto';
/**
 * Constant-time string equality. Pads / truncates both buffers to a fixed
 * length so the comparison length is independent of the input — prevents
 * length oracles when one side is attacker-controlled.
 */
export function safeStringEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    const len = Math.max(ab.length, bb.length, 32);
    const left = Buffer.alloc(len);
    const right = Buffer.alloc(len);
    ab.copy(left);
    bb.copy(right);
    const equal = timingSafeEqual(left, right);
    return equal && ab.length === bb.length;
}
