/* Unit tests for lib/profiles.js. Run: gjs -m tests/test-profiles.js */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const P = await import(`file://${here}/../kiro-crew@totoshko88.github.io/lib/profiles.js`);

let fail = 0;
function eq(got, want, msg) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok)
        fail++;
    print(`${ok ? 'ok' : 'FAIL'}: ${msg}${ok ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

// Normalization: only id/name/port/token survive; port defaults and clamps.
eq(P.normalizeProfile({id: 'l', name: 'L', port: '3676'}),
    {id: 'l', name: 'L', port: '3676', token: ''}, 'keeps the four known fields');
eq(P.normalizeProfile({name: 'L'}).port, '5476', 'missing port defaults to 5476');
eq(P.normalizeProfile({name: 'L', port: '70000'}).port, '5476', 'out-of-range port falls back to default');
eq(P.normalizeProfile({name: 'L', host: 'x', kind: 'remote', sshcontrol: '1'}).host, undefined,
    'legacy host/kind/sshcontrol fields are dropped');

// Validation
eq(P.profileError({name: '', port: '5476'}), 'name', 'empty name rejected');
eq(P.profileError({name: 'x', port: '70000'}), 'port', 'port range');
eq(P.profileError({name: 'x', port: '5476'}), null, 'valid profile saves');

// URLs always point at this computer's loopback.
eq(P.profileBaseUrl({port: '3676'}), 'http://127.0.0.1:3676', 'base URL uses 127.0.0.1');
eq(P.profileSummary({port: '3676'}), '127.0.0.1:3676', 'summary uses 127.0.0.1');

// Serialization round-trips the four fields.
eq(P.serializeProfile({id: 'a', name: 'b', port: '3676', token: 't'}),
    {id: 'a', name: 'b', port: '3676', token: 't'}, 'serialize keeps the four fields');

// 0.1.2 migration: loopback endpoints become local profiles; remotes are dropped.
const m = P.profilesFromLegacy('http://localhost:3676', ['http://localhost:3676'], '');
eq(m.profiles.map(p => [p.name, p.port]), [['127.0.0.1:3676', '3676']],
    'migration keeps the loopback endpoint as a local profile');
const m2 = P.profilesFromLegacy('http://localhost:5476/', ['http://10.0.0.5:5476'], 'TOK');
eq(m2.profiles.map(p => [p.name, p.token]), [['This computer', 'TOK']],
    'token goes to the active endpoint; the non-loopback remote is dropped');
const m3 = P.profilesFromLegacy('', [], '');
eq(m3.profiles.map(p => p.name), ['This computer'], 'empty legacy settings still yield a local profile');

// Local service port resolution (systemd Environment= / EnvironmentFile).
eq(P.unitPort([], ''), 5476, 'default port');
eq(P.unitPort(['USER=a', 'KIROCREW_PORT=3676'], ''), 3676, 'baked Environment=');
eq(P.unitPort(['KIROCREW_PORT=3676'], '#KIROCREW_PORT=5477\nKIROCREW_PORT=3700\n'), 3700,
    'env file wins, comments ignored');

// findActive falls back to the first profile.
const list = [{id: 'a'}, {id: 'b'}];
eq(P.findActive(list, 'b').id, 'b', 'findActive picks the matching id');
eq(P.findActive(list, 'zzz').id, 'a', 'findActive falls back to the first');

if (fail > 0) {
    print(`\n${fail} FAILED`);
    imports.system.exit(1);
}
print('\nALL PASS');
