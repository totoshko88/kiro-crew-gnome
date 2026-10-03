/**
 * state.js — pure helpers that reduce the gateway's live slot list into a
 * single indicator state. No GJS imports here, so it stays trivially testable.
 *
 * Indicator states, highest priority first:
 *   'stopped'   faded    — the gateway was stopped on purpose (service
 *                          inactive, or stopped from the menu).
 *   'auth'      dim red  — the token was rejected (401/403).
 *   'offline'   red      — the gateway is unreachable but was not stopped.
 *   'error'     red      — a critical notification, or a slot whose
 *                          mcp_report carries an error.
 *   'attention' amber    — a slot needs_input / has_options (agent asked a
 *                          question) or pending_approval (tool approval).
 *   'busy'      purple   — a slot is working: its own turn, a staged
 *                          orchestration, background subagents, or a queue.
 *   'idle'      normal   — gateway online, nothing happening.
 */

export const STATE = Object.freeze({
    STOPPED: 'stopped',
    OFFLINE: 'offline',
    AUTH: 'auth',
    ERROR: 'error',
    ATTENTION: 'attention',
    BUSY: 'busy',
    IDLE: 'idle'
});

// Priority order used to pick the aggregate when several slots disagree.
const PRIORITY = {
    stopped: 7,
    offline: 6,
    auth: 5,
    error: 4,
    attention: 3,
    busy: 2,
    idle: 1
};

export const ICON_NAME = Object.freeze({
    stopped: 'kiro-crew-stopped-symbolic',
    offline: 'kiro-crew-error-symbolic',
    auth: 'kiro-crew-error-symbolic',
    error: 'kiro-crew-error-symbolic',
    attention: 'kiro-crew-attention-symbolic',
    busy: 'kiro-crew-busy-symbolic',
    idle: 'kiro-crew-idle-symbolic'
});

// CSS style class applied to the St.Icon so stylesheet.css can tint it.
export const STYLE_CLASS = Object.freeze({
    stopped: 'kiro-crew-icon kiro-crew-stopped',
    offline: 'kiro-crew-icon kiro-crew-error',
    auth: 'kiro-crew-icon kiro-crew-auth',
    error: 'kiro-crew-icon kiro-crew-error',
    attention: 'kiro-crew-icon kiro-crew-attention',
    busy: 'kiro-crew-icon kiro-crew-busy',
    idle: 'kiro-crew-icon kiro-crew-idle'
});

/** Does this slot's mcp_report describe a failure? Defensive — shape varies. */
function reportHasError(report) {
    if (!report || typeof report !== 'object')
        return false;
    const status = String(report.status ?? report.state ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'failure')
        return true;
    const sev = String(report.severity ?? report.level ?? '').toLowerCase();
    return sev === 'error' || sev === 'critical';
}

/**
 * Is this slot doing work? Mirrors the dashboard sidebar's "working" lane:
 * `running` is only the main agent's own turn. A session that handed work to
 * background subagents (`subagents_running`), is running a staged plan
 * (`orchestrating`), or has queued prompts (`queue_depth`) is still working
 * even while `running` is false between turns.
 */
function slotIsWorking(slot) {
    return Boolean(slot.running || slot.orchestrating || slot.subagents_running ||
        (Number(slot.queue_depth) || 0) > 0);
}

/**
 * Reduce one slot to its own state (ignoring gateway-level signals). This is
 * the ONE rule for both the menu dots and the ghost, so the ghost is always
 * the worst dot.
 *
 * Amber is strictly "an agent is blocked on you": a tool approval or a
 * question. NOT `has_options` — those are the quick-reply suggestion chips the
 * agent leaves after a finished turn, set on nearly every idle session — and
 * NOT `interrupted`, which needs no action to keep anything going.
 */
export function slotState(slot) {
    if (!slot || typeof slot !== 'object')
        return STATE.IDLE;
    if (reportHasError(slot.mcp_report))
        return STATE.ERROR;
    if (slot.pending_approval || slot.needs_input)
        return STATE.ATTENTION;
    if (slotIsWorking(slot))
        return STATE.BUSY;
    return STATE.IDLE;
}

/**
 * Aggregate the whole picture into one state.
 * @param {object} o
 * @param {boolean} o.online          gateway reachable
 * @param {Array}   o.slots           live slot dicts from the ws "slots" frame
 * @param {boolean} o.criticalNotice  a critical notification is active
 * @param {boolean} o.authError       last connect/request got 401/403
 * @param {boolean} o.stopped         the gateway was stopped on purpose
 * @returns {string} one of STATE.*
 */
export function aggregateState({
    online, slots = [], criticalNotice = false, authError = false, stopped = false
}) {
    // A deliberately stopped gateway is not a fault: show the faded ghost, not
    // red, and ignore the stale slot list and token errors of the dead socket.
    if (stopped)
        return STATE.STOPPED;
    // A bad/expired token is not a gateway fault and not an agent problem.
    // Show the muted "auth" state (dim red) so it reads as "fix your token",
    // not as a hard error or an offline gateway.
    if (authError)
        return STATE.AUTH;
    if (!online)
        return STATE.OFFLINE;
    let best = STATE.IDLE;
    const bump = s => {
        if (PRIORITY[s] > PRIORITY[best])
            best = s;
    };
    if (criticalNotice)
        bump(STATE.ERROR);
    for (const slot of slots)
        bump(slotState(slot));
    return best;
}

/**
 * Derive the dashboard SPA session id (`sid`) from a stored session key.
 * The dashboard opens a conversation via /chat?sid=<id>. /api/sessions returns
 * the history stem, where the server's safe-key mapped the surface prefix's ":"
 * to "_", so the raw key carries a prefix the sid param rejects
 * ("dashboard_chat-8-… not found"). Strip it to the bare slot id:
 *   "dashboard:chat-8-1"            -> "chat-8-1"   (live key, ":" form)
 *   "dashboard_chat-8-1"            -> "chat-8-1"   (history stem, "_" form)
 *   "dashboard_dashboard_chat-8-1"  -> "chat-8-1"   (resume round-trip stem)
 *   "slack:1712793600.1"            -> "1712793600.1"
 * A key with no known prefix is returned unchanged.
 */
const SURFACES = 'dashboard|slack|cron|discord|telegram|webex|teams|whatsapp|imessage|feishu';
export function slotName(key) {
    let s = String(key ?? '');
    // Collapse a doubled resume stem first.
    s = s.replace(/^dashboard_dashboard_/, '');
    // Strip a "<surface>:" prefix (live key form).
    s = s.replace(/^[a-z]+:/, '');
    // Strip a single "<surface>_" safe-key stem (history file form).
    s = s.replace(new RegExp(`^(${SURFACES})_`), '');
    return s;
}

/**
 * Recency of a slot in epoch ms, for "most recently active wins". The gateway
 * sends ISO-8601 strings (or "" for a never-run session); numbers are accepted
 * too. Unknown/empty sorts last.
 */
export function slotRecency(slot) {
    for (const v of [slot?.last_activity_ts, slot?.last_turn_ts, slot?.last_ts]) {
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string' && v) {
            const t = Date.parse(v);
            if (Number.isFinite(t))
                return t;
        }
    }
    return -Infinity;
}

/**
 * Pick the slot the icon's left-click should jump to, given the aggregate.
 * Returns the slot key, or null to open the dashboard home instead.
 */
export function targetSlotKey(aggregate, slots = []) {
    const want = {
        [STATE.ERROR]: s => slotState(s) === STATE.ERROR,
        [STATE.ATTENTION]: s => slotState(s) === STATE.ATTENTION,
        [STATE.BUSY]: s => slotState(s) === STATE.BUSY
    }[aggregate];
    if (!want)
        return null;
    const matches = slots.filter(want);
    if (matches.length === 0)
        return null;
    // Most recently active wins.
    let best = matches[0];
    for (const s of matches) {
        if (slotRecency(s) > slotRecency(best))
            best = s;
    }
    return best.key ?? null;
}

/**
 * How many sessions would be cut short by stopping the gateway right now:
 * those working or waiting on the user mid-turn.
 */
export function activeSessionCount(slots = []) {
    let n = 0;
    for (const s of slots) {
        const st = slotState(s);
        if (st === STATE.BUSY || st === STATE.ATTENTION)
            n++;
    }
    return n;
}

/**
 * Does this endpoint URL point at this machine? Gateway Stop/Start drives the
 * LOCAL service, so it is only offered when the configured endpoint is
 * loopback — never for a remote gateway picked in the endpoint switcher.
 */
export function isLoopbackEndpoint(url) {
    const m = String(url ?? '').trim().match(/^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/:?#]*)/i);
    if (!m)
        return false;
    const host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Build the menu's session rows so the ghost always matches a visible dot.
 * `sessions` are the recent /api/sessions entries; `slots` the live slots.
 * Any non-idle live slot that is not among the recent sessions (the ghost is
 * computed over ALL slots) is pinned on top, most recently active first.
 * Titles prefer the live slot's title, then the session's, then the slot id.
 * @returns {Array<{key: string, title: string, state: string}>}
 */
export function menuRows(sessions = [], slots = []) {
    const liveByKey = new Map(slots.map(s => [slotName(s.key), s]));
    const listed = new Set(sessions.map(s => slotName(s.key)));
    const pinned = slots
        .filter(s => !listed.has(slotName(s.key)) && slotState(s) !== STATE.IDLE)
        .sort((a, b) => slotRecency(b) - slotRecency(a))
        .map(s => ({key: s.key, title: s.title || slotName(s.key), state: slotState(s)}));
    const recent = sessions.map(sess => {
        const live = liveByKey.get(slotName(sess.key));
        return {
            key: sess.key,
            // The live title is current (renames land there first), and
            // /api/sessions echoes the raw storage key for an untitled chat.
            title: live?.title || sess.title || slotName(sess.key),
            state: live ? slotState(live) : STATE.IDLE
        };
    });
    return [...pinned, ...recent];
}
