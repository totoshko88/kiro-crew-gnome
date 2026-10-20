#!/usr/bin/env gjs -m
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

const local = P.normalizeProfile({id: 'l', name: 'L', host: 'localhost', port: '3676'});
const remote = P.normalizeProfile({id: 'r', name: 'R', host: 'anton@192.168.0.131', port: '3676', sshcontrol: '1'});

// Kinds
eq(P.normalizeProfile({host: '192.168.0.131', kind: 'local'}).kind, 'remote', 'non-loopback host is always remote');
eq(local.kind, 'local', 'localhost defaults to local');
eq(P.normalizeProfile({host: 'localhost', kind: 'remote'}).kind, 'remote', 'localhost can be marked remote');
eq(P.usesTunnel(P.normalizeProfile({host: 'localhost', kind: 'remote'})), false, 'localhost remote opens no tunnel');
eq(P.usesSshControl(remote), true, 'ssh control kept for a tunnel profile');
eq(P.usesSshControl(P.normalizeProfile({host: 'localhost', kind: 'remote', sshcontrol: '1'})), false,
    'ssh control dropped without a tunnel');

// Validation (the host is passed to ssh)
eq(P.profileError({name: 'x', host: '-oProxyCommand=evil', port: '22'}), 'host', 'reject option-looking host');
eq(P.profileError({name: 'x', host: 'anton@-evil', port: '22'}), 'host', 'reject option-looking host after @');
eq(P.profileError({name: 'x', host: 'a;b', port: '22'}), 'host', 'reject shell metacharacters');
eq(P.profileError({name: 'x', host: '[::1]', port: '5476'}), null, 'bracketed IPv6 ok');
eq(P.profileError({name: 'x', host: 'h', port: '70000'}), 'port', 'port range');

// Tunnel ports: never the remote port, never a local profile's port
const reserved = P.reservedPorts([local, remote]);
eq([...reserved], [3676], 'reserved = loopback profiles only');
eq(P.pickTunnelPort(3676, reserved), 13676, 'remote 3676 -> 13676');
eq(P.pickTunnelPort(3676, reserved, p => p !== 13676), 13677, 'busy port skipped');
eq(P.pickTunnelPort(13676, new Set()), 23676, 'remote port inside the range is skipped');
eq(P.pickTunnelPort(3676, new Set(), () => false), null, 'nothing free');
eq(P.profileBaseUrl(remote, 13676), 'http://127.0.0.1:13676', 'tunnel URL uses 127.0.0.1');
eq(P.sshArgv(remote, 13676).slice(-4), ['-L', '127.0.0.1:13676:localhost:3676', '--', 'anton@192.168.0.131'],
    'ssh forward binds loopback, destination after --');

// Remote commands: constants + the validated port only
eq(P.sshCommandArgv(remote, 'stop').slice(-3), ['--', 'anton@192.168.0.131', 'sudo -n systemctl stop kirocrew.service'],
    'stop command');
eq(P.remoteCommand('token', '3676').includes('http://127.0.0.1:3676/api/token/local'), true, 'token command targets the host loopback');
let threw = false;
try {
    P.remoteCommand('token', '3676; rm -rf ~');
} catch {
    threw = true;
}
eq(threw, true, 'non-numeric port rejected');

// Service port resolution
eq(P.unitPort([], ''), 5476, 'default port');
eq(P.unitPort(['USER=a', 'KIROCREW_PORT=3676'], ''), 3676, 'baked Environment=');
eq(P.unitPort(['KIROCREW_PORT=3676'], '#KIROCREW_PORT=5477\nKIROCREW_PORT=3700\n'), 3700, 'env file wins, comments ignored');
eq(P.parseProbe('LoadState=loaded\nActiveState=active\nEnvironment=USER=anton KIROCREW_PORT=3676\n'),
    {loaded: true, active: 'active', port: 3676}, 'probe parse');
eq(P.parseProbe('LoadState=not-found\nActiveState=inactive\nEnvironment=\n').loaded, false, 'probe: no unit');

// 0.1.2 migration
const m = P.profilesFromLegacy('http://localhost:3676', ['http://localhost:3676'], '');
eq(m.profiles.map(p => [p.name, p.kind, p.port]), [['This computer', 'local', '5476'], ['localhost:3676', 'remote', '3676']],
    'migration adds a local profile and marks another loopback port remote');
const m2 = P.profilesFromLegacy('http://localhost:5476/', ['http://10.0.0.5:5476'], 'TOK');
eq(m2.profiles.map(p => [p.kind, p.token]), [['local', 'TOK'], ['remote', '']], 'token goes to the active endpoint only');

if (fail > 0) {
    print(`\n${fail} FAILED`);
    imports.system.exit(1);
}
print('\nALL PASS');
