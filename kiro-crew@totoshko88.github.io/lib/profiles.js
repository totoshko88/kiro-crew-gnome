/**
 * profiles.js — the gateway profile model. Pure JavaScript, shared by both
 * processes and covered by tests/test-profiles.js.
 *
 * A profile is a dict of strings:
 *   id, name    key and label
 *   port        the local gateway's port on this computer
 *   token       that gateway's access token
 *
 * Every profile is a gateway running on this computer, reached on 127.0.0.1.
 * Another machine is not an extension concern: connect it in the Kiro Crew
 * dashboard under Settings → Remote Crew, which opens and supervises the
 * tunnel itself. The extension never spawns ssh, sudo or curl.
 */

export const DEFAULT_PORT = 5476;

const FIELDS = ['id', 'name', 'port', 'token'];

/** Port number 1-65535, or null. */
function parsePort(value) {
    const s = String(value ?? '').trim();
    if (!/^\d{1,5}$/.test(s))
        return null;
    const n = Number(s);
    return n >= 1 && n <= 65535 ? n : null;
}

/** Fill defaults. Pure. */
export function normalizeProfile(raw = {}) {
    const p = {};
    for (const f of FIELDS)
        p[f] = String(raw[f] ?? '').trim();
    p.port = String(parsePort(p.port) ?? DEFAULT_PORT);
    return p;
}

/** First problem with a profile as entered, or null when it can be saved. */
export function profileError(p) {
    if (!String(p.name ?? '').trim())
        return 'name';
    if (parsePort(p.port) === null)
        return 'port';
    return null;
}

/**
 * Base URL of the profile's gateway on this computer. Reached on 127.0.0.1,
 * not "localhost", which may resolve to ::1 where another service could listen.
 */
export function profileBaseUrl(p) {
    return `http://127.0.0.1:${p.port}`;
}

/** "127.0.0.1:5476". */
export function profileSummary(p) {
    return `127.0.0.1:${p.port}`;
}

/** Stored form: every known field as a string. */
export function serializeProfile(p) {
    const out = {};
    for (const f of FIELDS)
        out[f] = String(p[f] ?? '');
    return out;
}

function isLoopbackHost(host) {
    const a = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return a === 'localhost' || a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/** A loopback endpoint's port, or null for a non-loopback (old remote) one. */
function parseLegacyUrl(url) {
    const m = String(url ?? '').trim()
        .match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i);
    if (!m || !isLoopbackHost(m[1]))
        return null;
    return {port: String(parsePort(m[2]) ?? DEFAULT_PORT)};
}

/**
 * Profiles from the 0.1.2 settings. Each saved endpoint on this computer
 * becomes a local profile; the old token goes to the active endpoint only.
 * Ids are deterministic, so both processes migrate alike. Endpoints that are
 * not loopback (old remote entries) are dropped — remotes now live in the
 * dashboard's Remote Crew, not in the extension.
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
        const p = normalizeProfile({
            id: `legacy-${i}`,
            name: Number(parsed.port) === DEFAULT_PORT ? 'This computer' : `127.0.0.1:${parsed.port}`,
            port: parsed.port,
            token: url === active ? token : ''
        });
        profiles.push(p);
        if (url === active)
            activeId = p.id;
    });
    if (profiles.length === 0)
        profiles.push(defaultLocalProfile());
    return {profiles, activeId: activeId || profiles[0].id};
}

export function defaultLocalProfile() {
    return normalizeProfile({id: 'local', name: 'This computer', port: String(DEFAULT_PORT)});
}

/** The active profile, falling back to the first one. */
export function findActive(profiles, activeId) {
    return profiles.find(p => p.id === activeId) ?? profiles[0] ?? null;
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
 * The port the local kirocrew.service listens on, resolved like systemd does:
 * the EnvironmentFile overrides the unit's Environment=, else the default.
 * @param {string[]} environment the unit's Environment= entries
 * @param {string} envFile text of /etc/kirocrew/kirocrew.env, '' if absent
 */
export function unitPort(environment = [], envFile = '') {
    return portFromAssignments(String(envFile).split('\n')) ??
        portFromAssignments(environment) ?? DEFAULT_PORT;
}
