/**
 * state.js — reduces the gateway's live slots to one indicator state. Pure
 * JavaScript, covered by tests/test-state.js.
 *
 * States, highest priority first: stopped (on purpose), auth (token
 * rejected), offline, error (critical notice or an MCP server that failed),
 * attention (a question, an approval, or an MCP sign-in waits on you), busy,
 * idle.
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

export const STYLE_CLASS = Object.freeze({
    stopped: 'kiro-crew-icon kiro-crew-stopped',
    offline: 'kiro-crew-icon kiro-crew-error',
    auth: 'kiro-crew-icon kiro-crew-auth',
    error: 'kiro-crew-icon kiro-crew-error',
    attention: 'kiro-crew-icon kiro-crew-attention',
    busy: 'kiro-crew-icon kiro-crew-busy',
    idle: 'kiro-crew-icon kiro-crew-idle'
});

function nonEmptyList(value) {
    return Array.isArray(value) && value.length > 0;
}

/** Did an MCP server of this session fail to start? `failed` lists their names. */
function reportHasError(report) {
    return nonEmptyList(report?.failed);
}

/** Does an MCP server of this session wait for you to sign in? */
function reportAwaitsAuth(report) {
    return nonEmptyList(report?.awaiting_auth);
}

/** Why a slot waits on you, when the menu should say so: 'mcp-auth' or null. */
export function slotHint(slot) {
    if (!slot || reportHasError(slot.mcp_report) || slot.pending_approval || slot.needs_input)
        return null;
    return reportAwaitsAuth(slot.mcp_report) ? 'mcp-auth' : null;
}

/**
 * Is this slot working? Its own turn, background subagents running or queued,
 * queued prompts, or a compaction holding the session — `running` alone is
 * only the main agent's turn.
 */
function slotIsWorking(slot) {
    return Boolean(slot.running || slot.subagents_running || slot.compacting ||
        (Number(slot.subagents_queued) || 0) > 0 || (Number(slot.queue_depth) || 0) > 0);
}

/**
 * One slot's own state. The menu dots and the ghost share this rule, so the
 * ghost is always the worst dot. Attention means the session is blocked on
 * you: a question, a tool approval, or an MCP server waiting for your sign-in.
 * `has_options` (quick-reply chips left on finished turns) and `interrupted`
 * don't count.
 */
export function slotState(slot) {
    if (!slot || typeof slot !== 'object')
        return STATE.IDLE;
    if (reportHasError(slot.mcp_report))
        return STATE.ERROR;
    if (slot.pending_approval || slot.needs_input || reportAwaitsAuth(slot.mcp_report))
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
    // Stopped on purpose is not a fault, whatever the dead socket left behind.
    if (stopped)
        return STATE.STOPPED;
    // A rejected token reads as "fix your token", not as an outage.
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
 * The dashboard's `sid` for a session key. /api/sessions returns history
 * stems where the surface prefix's ":" became "_", and /chat?sid= accepts
 * only the bare slot id:
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

/** Last activity in epoch ms (the gateway sends ISO-8601); unknown sorts last. */
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

/** Key of the slot a left click opens for this aggregate, or null for the dashboard. */
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

/** Sessions a stop or restart would interrupt: working or waiting on you. */
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
 * Menu rows from the recent sessions and the live slots. A busy live slot
 * missing from the recent list is pinned on top, so the ghost's state always
 * matches a visible dot.
 * @returns {Array<{key: string, title: string, state: string, hint: ?string}>}
 *   hint: see slotHint()
 */
export function menuRows(sessions = [], slots = []) {
    const liveByKey = new Map(slots.map(s => [slotName(s.key), s]));
    const listed = new Set(sessions.map(s => slotName(s.key)));
    const pinned = slots
        .filter(s => !listed.has(slotName(s.key)) && slotState(s) !== STATE.IDLE)
        .sort((a, b) => slotRecency(b) - slotRecency(a))
        .map(s => ({key: s.key, title: s.title || slotName(s.key), state: slotState(s), hint: slotHint(s)}));
    const recent = sessions.map(sess => {
        const live = liveByKey.get(slotName(sess.key));
        return {
            key: sess.key,
            // The live title is current (renames land there first), and
            // /api/sessions echoes the raw storage key for an untitled chat.
            title: live?.title || sess.title || slotName(sess.key),
            state: live ? slotState(live) : STATE.IDLE,
            hint: live ? slotHint(live) : null
        };
    });
    return [...pinned, ...recent];
}
