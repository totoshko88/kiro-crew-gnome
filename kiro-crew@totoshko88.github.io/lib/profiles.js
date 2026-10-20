/**
 * profiles.js — the gateway profile model. Pure JavaScript, shared by both
 * processes and covered by tests/test-profiles.js.
 *
 * A profile is a dict of strings:
 *   id, name    key and label
 *   host        IP or hostname, "user@host" for another SSH user
 *   port        the gateway's port on that host
 *   token       that gateway's access token
 *   kind        'local' (this computer: full controls, local token bootstrap)
 *               or 'remote' (read-only; this computer's secret is never sent)
 *   sshcontrol  '1' lets a remote profile handle its token and service over SSH
 *
 * Locality is the kind, never the URL: a tunnel listens on localhost too. A
 * non-loopback host is always remote and reached through an SSH tunnel.
 */

export const DEFAULT_PORT = 5476;

export const KIND = Object.freeze({LOCAL: 'local', REMOTE: 'remote'});

// A tunnel's local port: remote port + 10000 (3676 -> 13676), within 10000-65535.
const TUNNEL_PORT_OFFSET = 10000;
const TUNNEL_PORT_MIN = 10000;

const FIELDS = ['id', 'name', 'host', 'port', 'token', 'kind', 'sshcontrol'];

// Optional "user@" plus a hostname, IPv4 or bracketed IPv6. Each part starts
// with a letter or digit, so a host can never be read as an ssh option.
const HOST_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/;

/** The address part of "user@host" (brackets kept for IPv6). */
function hostAddress(host) {
    const s = String(host ?? '').trim();
    const at = s.lastIndexOf('@');
    return at >= 0 ? s.slice(at + 1) : s;
}

export function isLoopbackHost(host) {
    const a = hostAddress(host).toLowerCase().replace(/^\[|\]$/g, '');
    return a === 'localhost' || a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/** Port number 1-65535, or null. */
function parsePort(value) {
    const s = String(value ?? '').trim();
    if (!/^\d{1,5}$/.test(s))
        return null;
    const n = Number(s);
    return n >= 1 && n <= 65535 ? n : null;
}

/** Fill defaults and force the kind a host allows. Pure. */
export function normalizeProfile(raw = {}) {
    const p = {};
    for (const f of FIELDS)
        p[f] = String(raw[f] ?? '').trim();
    p.port = String(parsePort(p.port) ?? DEFAULT_PORT);
    if (!isLoopbackHost(p.host))
        p.kind = KIND.REMOTE;
    else if (p.kind !== KIND.REMOTE)
        p.kind = KIND.LOCAL;
    p.sshcontrol = usesTunnel(p) && p.sshcontrol === '1' ? '1' : '';
    return p;
}

/** A remote profile on another machine is reached through an SSH tunnel. */
export function usesTunnel(p) {
    return p.kind === KIND.REMOTE && !isLoopbackHost(p.host);
}

/** A remote profile whose token and service may be handled over SSH. */
export function usesSshControl(p) {
    return usesTunnel(p) && p.sshcontrol === '1';
}

/**
 * The fixed commands SSH control runs on a remote host. ssh passes them to the
 * remote login shell as a string, so they hold only constants and the parsed
 * port, never text from a profile. The token command reads the host's secret
 * and uses it there; only the minted token comes back.
 */
export function remoteCommand(action, port) {
    const n = parsePort(port);
    if (n === null)
        throw new Error('invalid port');
    switch (action) {
        case 'token':
            return `curl -fsS --max-time 10 -H "X-Local-Secret: $(cat ~/.kiro/crew/.local_secret)" http://127.0.0.1:${n}/api/token/local`;
        case 'probe':
            return 'systemctl show kirocrew.service -p LoadState -p ActiveState -p Environment; ' +
            'grep -h "^KIROCREW_PORT=" /etc/kirocrew/kirocrew.env 2>/dev/null; true';
        case 'start':
        case 'stop':
        case 'restart':
            return `sudo -n systemctl ${action} kirocrew.service`;
        case 'update':
            return '"$HOME/.local/bin/kirocrew" update && sudo -n systemctl restart kirocrew.service';
        default:
            throw new Error(`unknown remote action ${action}`);
    }
}

/** argv for one remote command: no tty, no prompts, bounded connect time. */
export function sshCommandArgv(p, action) {
    return [
        'ssh', '-n', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '--', p.host, remoteCommand(action, p.port)
    ];
}

/** Last KIROCREW_PORT=… assignment in a list of KEY=value strings, or null. */
function portFromAssignments(lines) {
    let port = null;
    for (const line of lines) {
        const m = String(line).trim().match(/^KIROCREW_PORT=["']?(\d{1,5})["']?$/);
        if (m && parsePort(m[1]) !== null)
            port = Number(m[1]);
    }
    return port;
}

/**
 * The port kirocrew.service listens on, resolved like systemd does: the
 * EnvironmentFile overrides the unit's Environment=, else the default.
 * @param {string[]} environment the unit's Environment= entries
 * @param {string} envFile text of /etc/kirocrew/kirocrew.env, '' if absent
 */
export function unitPort(environment = [], envFile = '') {
    return portFromAssignments(String(envFile).split('\n')) ??
        portFromAssignments(environment) ?? DEFAULT_PORT;
}

/** Output of the 'probe' remote command as {loaded, active, port}. */
export function parseProbe(text) {
    const props = {};
    const fileLines = [];
    for (const line of String(text ?? '').split('\n')) {
        const m = line.match(/^(LoadState|ActiveState|Environment)=(.*)$/);
        if (m)
            props[m[1]] = m[2];
        else if (line.startsWith('KIROCREW_PORT='))
            fileLines.push(line);
    }
    const env = (props.Environment ?? '').split(/\s+/).filter(Boolean);
    return {
        loaded: props.LoadState === 'loaded',
        active: props.ActiveState ?? null,
        port: unitPort(env, fileLines.join('\n'))
    };
}

/** First problem with a profile as entered, or null when it can be saved. */
export function profileError(p) {
    if (!String(p.name ?? '').trim())
        return 'name';
    if (!HOST_RE.test(String(p.host ?? '').trim()))
        return 'host';
    if (parsePort(p.port) === null)
        return 'port';
    return null;
}

/**
 * Base URL of the profile's gateway. A tunnel is reached on 127.0.0.1, not
 * "localhost", which may resolve to ::1 where another service could listen.
 * @param {number} tunnelPort the open tunnel's local port, 0 if none
 */
export function profileBaseUrl(p, tunnelPort = 0) {
    if (usesTunnel(p))
        return `http://127.0.0.1:${tunnelPort}`;
    return `http://${hostAddress(p.host) || 'localhost'}:${p.port}`;
}

/** "localhost:5476", "anton@192.168.0.131:3676". */
export function profileSummary(p) {
    return `${p.host}:${p.port}`;
}

/**
 * ssh argv for a tunnel. The forward binds 127.0.0.1 only; BatchMode fails
 * fast instead of prompting where nobody can answer; ExitOnForwardFailure
 * turns a busy local port into an exit; "--" ends options before the host.
 */
export function sshArgv(p, localPort) {
    return [
        'ssh', '-N', '-n',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${localPort}:localhost:${p.port}`,
        '--', p.host
    ];
}

/** Ports a tunnel must not take: those of the gateways on this computer. */
export function reservedPorts(profiles) {
    const used = new Set();
    for (const p of profiles) {
        if (isLoopbackHost(p.host))
            used.add(Number(p.port));
    }
    return used;
}

/**
 * Local port for a tunnel to remote `port`: the first free one from
 * port + 10000 upward, wrapping within the range and skipping the remote port
 * itself and `reserved`. Null when none is free.
 * @param {(port: number) => boolean} isFree probes this machine
 */
export function pickTunnelPort(port, reserved = new Set(), isFree = () => true) {
    const span = 65535 - TUNNEL_PORT_MIN + 1;
    const start = (Number(port) + TUNNEL_PORT_OFFSET - TUNNEL_PORT_MIN) % span;
    for (let i = 0; i < span; i++) {
        const candidate = TUNNEL_PORT_MIN + (start + i) % span;
        if (candidate !== Number(port) && !reserved.has(candidate) && isFree(candidate))
            return candidate;
    }
    return null;
}

/** Stored form: every known field as a string. */
export function serializeProfile(p) {
    const out = {};
    for (const f of FIELDS)
        out[f] = String(p[f] ?? '');
    return out;
}

function parseLegacyUrl(url) {
    const m = String(url ?? '').trim()
        .match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i);
    if (!m)
        return null;
    return {host: m[1], port: String(parsePort(m[2]) ?? DEFAULT_PORT)};
}

/**
 * Profiles from the 0.1.2 settings. localhost:5476 becomes the local profile;
 * another loopback port is taken for a self-run tunnel (read-only remote).
 * The old token goes to the active endpoint only; a local profile is always
 * included. Ids are deterministic, so both processes migrate alike.
 */
export function profilesFromLegacy(endpoint, endpoints = [], token = '') {
    const active = String(endpoint ?? '').trim().replace(/\/+$/, '');
    const urls = [];
    for (const u of [active, ...endpoints]) {
        const v = String(u ?? '').trim().replace(/\/+$/, '');
        if (v && !urls.includes(v))
            urls.push(v);
    }
    const profiles = [];
    let activeId = '';
    urls.forEach((url, i) => {
        const parsed = parseLegacyUrl(url);
        if (!parsed)
            return;
        const local = isLoopbackHost(parsed.host) && Number(parsed.port) === DEFAULT_PORT;
        const p = normalizeProfile({
            id: `legacy-${i}`,
            name: local ? 'This computer' : `${parsed.host}:${parsed.port}`,
            host: parsed.host,
            port: parsed.port,
            token: url === active ? token : '',
            kind: local ? KIND.LOCAL : KIND.REMOTE
        });
        profiles.push(p);
        if (url === active)
            activeId = p.id;
    });
    if (!profiles.some(p => p.kind === KIND.LOCAL))
        profiles.unshift(defaultLocalProfile());
    return {profiles, activeId: activeId || profiles[0].id};
}

export function defaultLocalProfile() {
    return normalizeProfile({
        id: 'local', name: 'This computer', host: 'localhost',
        port: String(DEFAULT_PORT), kind: KIND.LOCAL
    });
}

/** The active profile, falling back to the first one. */
export function findActive(profiles, activeId) {
    return profiles.find(p => p.id === activeId) ?? profiles[0] ?? null;
}
