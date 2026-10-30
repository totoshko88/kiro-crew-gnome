#!/usr/bin/env gjs -m
/* Unit tests for lib/token.js. Run: gjs -m tests/test-token.js  */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const tokenUrl = `file://${here}/../kiro-crew@totoshko88.github.io/lib/token.js`;

const {
    tokenClaims, tokenExp, tokenSessionExp, secondsUntilExp, refreshDelaySecs
} = await import(tokenUrl);

let fail = 0;
function eq(got, want, msg) {
    if (got !== want) {
        print(`FAIL: ${msg} got=${got} want=${want}`);
        fail++;
    } else {
        print(`ok: ${msg}`);
    }
}

/** Build a token the way the gateway does: base64url(JSON) as the first segment. */
function mkToken(claims, sigSegments = ['', '']) {
    const json = JSON.stringify(claims);
    const bytes = new TextEncoder().encode(json);
    const b64 = GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return [b64, ...sigSegments].join('.');
}

// A realistic 0.11 token: short exp, longer session_exp.
const now = 1_700_000_000;
const tok = mkToken({sub: 'local-app', iat: now, exp: now + 300, session_exp: now + 72000, nonce: 'abc'});

// --- claims -----------------------------------------------------------
const claims = tokenClaims(tok);
eq(claims?.sub, 'local-app', 'claims sub');
eq(tokenExp(tok), now + 300, 'exp read');
eq(tokenSessionExp(tok), now + 72000, 'session_exp read');

// --- malformed inputs resolve to null, never throw --------------------
eq(tokenClaims(''), null, 'empty token -> null');
eq(tokenClaims(null), null, 'null token -> null');
eq(tokenClaims('not-base64url!!!'), null, 'garbage segment -> null');
eq(tokenClaims('%%%.sig.sig'), null, 'non-base64url chars -> null');
eq(tokenExp(mkToken({sub: 'x'})), null, 'no exp -> null');
eq(tokenExp('x.y.z'), null, 'undecodable -> null');

// --- numeric string claims (the gateway may send either) --------------
eq(tokenExp(mkToken({exp: '1700000300'})), 1700000300, 'numeric-string exp');
eq(tokenExp(mkToken({exp: 'not-a-number'})), null, 'non-numeric exp -> null');

// --- secondsUntilExp --------------------------------------------------
eq(secondsUntilExp(tok, now * 1000), 300, 'seconds until exp');
eq(secondsUntilExp(tok, (now + 400) * 1000), -100, 'negative once lapsed');
eq(secondsUntilExp('nope', now * 1000), null, 'no exp -> null');

// --- refreshDelaySecs: refresh `lead` before exp, clamped -------------
eq(refreshDelaySecs(tok, now * 1000, {lead: 30, floor: 5, max: 3600}), 270, 'lead before exp');
// Already near/past exp: never a tight loop, always at least `floor`.
eq(refreshDelaySecs(tok, (now + 290) * 1000, {lead: 30, floor: 5, max: 3600}), 5, 'floor near exp');
eq(refreshDelaySecs(tok, (now + 1000) * 1000, {lead: 30, floor: 5, max: 3600}), 5, 'floor past exp');
// Far-off or unreadable exp: clamp to max.
eq(refreshDelaySecs(mkToken({exp: now + 100000}), now * 1000, {lead: 30, floor: 5, max: 3600}),
    3600, 'clamp to max for far exp');
eq(refreshDelaySecs('unreadable', now * 1000, {max: 3600}), 3600, 'no exp -> max');

if (fail) {
    print(`\n${fail} FAILED`);
    imports.system.exit(1);
} else {
    print('\nALL PASS');
}
