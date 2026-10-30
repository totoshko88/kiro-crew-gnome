/**
 * token.js — read the lifetimes out of a Kiro Crew access token. Pure
 * JavaScript, covered by tests/test-token.js.
 *
 * Since gateway 0.11 the token the extension holds is a short-lived bearer
 * credential: its `exp` is only a few minutes out, while a longer `session_exp`
 * is what a cookie session rides on. The extension sends the token once as a
 * `?token=` query parameter; the gateway exchanges it for an HttpOnly session
 * cookie (`mc_token_<port>`) and from then on authenticates by that cookie.
 * This module lets the client see the short `exp` so it can refresh before it
 * lapses instead of after a 401/403.
 *
 * The payload is the FIRST dot-separated segment (base64url of a JSON object),
 * which is this gateway's own layout — not a standard JWT header.payload.sig.
 * Signatures are the gateway's to verify; the extension only reads the claims.
 */

import GLib from 'gi://GLib';

/** Decode a base64url string to bytes, or null when it is not valid base64url. */
function b64urlToBytes(segment) {
    const s = String(segment ?? '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*$/.test(s))
        return null;
    const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
    try {
        const bytes = GLib.base64_decode(padded);
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    } catch {
        return null;
    }
}

/**
 * The claims object of a token, or null when it cannot be read. Never throws.
 * @param {string} token
 * @returns {?object}
 */
export function tokenClaims(token) {
    const segment = String(token ?? '').split('.')[0];
    if (!segment)
        return null;
    const bytes = b64urlToBytes(segment);
    if (!bytes)
        return null;
    try {
        const obj = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

/** A numeric claim in epoch SECONDS, or null. Accepts a number or a numeric string. */
function epochClaim(claims, key) {
    const v = claims?.[key];
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v && Number.isFinite(Number(v)))
        return Number(v);
    return null;
}

/** The token's short bearer-window expiry in epoch seconds, or null. */
export function tokenExp(token) {
    return epochClaim(tokenClaims(token), 'exp');
}

/** The token's longer session expiry in epoch seconds, or null. */
export function tokenSessionExp(token) {
    return epochClaim(tokenClaims(token), 'session_exp');
}

/**
 * Seconds until the token's short `exp`, measured from `nowMs`. Negative when
 * it already lapsed; null when the token carries no readable `exp`.
 * @param {string} token
 * @param {number} nowMs Date.now()
 */
export function secondsUntilExp(token, nowMs) {
    const exp = tokenExp(token);
    if (exp === null)
        return null;
    return exp - Math.floor(nowMs / 1000);
}

/**
 * When to refresh a token: `lead` seconds before its short `exp`, but never
 * sooner than `floor` seconds from now (so a token already past — or nearly
 * past — `exp` still gets a small grace instead of a tight loop), and clamped
 * to `max` for a token with a far-off or unreadable `exp`.
 * @returns {number} delay in seconds until the next refresh
 */
export function refreshDelaySecs(token, nowMs, {lead = 30, floor = 5, max = 3600} = {}) {
    const left = secondsUntilExp(token, nowMs);
    if (left === null)
        return max;
    return Math.min(max, Math.max(floor, left - lead));
}
