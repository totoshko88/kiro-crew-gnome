/**
 * state.js — pure helpers that reduce the gateway's live slot list into a
 * single indicator state. No GJS imports here, so it stays trivially testable.
 *
 * Indicator states, highest priority first:
 *   'error'     red     — gateway offline, a critical notification, or a slot
 *                         whose mcp_report carries an error.
 *   'attention' yellow  — a slot needs_input (agent asked a question) or
 *                         pending_approval (waiting on tool approval).
 *   'busy'      blue     — a slot has a turn running.
 *   'idle'      normal   — gateway online, nothing happening.
 *   'offline'   red      — special-cased idle while the gateway is unreachable.
 */

export const STATE = Object.freeze({
    OFFLINE: 'offline',
    AUTH: 'auth',
    ERROR: 'error',
    ATTENTION: 'attention',
    BUSY: 'busy',
    IDLE: 'idle',
});

// Priority order used to pick the aggregate when several slots disagree.
const PRIORITY = {
    offline: 6,
    auth: 5,
    error: 4,
    attention: 3,
    busy: 2,
    idle: 1,
};

export const ICON_NAME = Object.freeze({
    offline: 'kiro-crew-error-symbolic',
    auth: 'kiro-crew-error-symbolic',
    error: 'kiro-crew-error-symbolic',
    attention: 'kiro-crew-attention-symbolic',
    busy: 'kiro-crew-busy-symbolic',
    idle: 'kiro-crew-idle-symbolic',
});

// CSS style class applied to the St.Icon so stylesheet.css can tint it.
export const STYLE_CLASS = Object.freeze({
    offline: 'kiro-crew-icon kiro-crew-error',
    auth: 'kiro-crew-icon kiro-crew-auth',
    error: 'kiro-crew-icon kiro-crew-error',
    attention: 'kiro-crew-icon kiro-crew-attention',
    busy: 'kiro-crew-icon kiro-crew-busy',
    idle: 'kiro-crew-icon kiro-crew-idle',
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

/** Reduce one slot to its own state (ignoring gateway-level signals). */
export function slotState(slot) {
    if (!slot || typeof slot !== 'object')
        return STATE.IDLE;
    if (reportHasError(slot.mcp_report))
        return STATE.ERROR;
    if (slot.needs_input || slot.pending_approval)
        return STATE.ATTENTION;
    if (slot.running)
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
 * @returns {string} one of STATE.*
 */
export function aggregateState({ online, slots = [], criticalNotice = false, authError = false }) {
    // A bad/expired token is not a gateway fault and not an agent problem.
    // Show the muted "auth" state (dim red) so it reads as "fix your token",
    // not as a hard error or an offline gateway.
    if (authError)
        return STATE.AUTH;
    if (!online)
        return STATE.OFFLINE;
    let best = STATE.IDLE;
    const bump = (s) => {
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
 * Pick the slot the icon's left-click should jump to, given the aggregate.
 * Returns the slot key, or null to open the dashboard home instead.
 */
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

export function targetSlotKey(aggregate, slots = []) {
    const want = {
        [STATE.ERROR]: (s) => slotState(s) === STATE.ERROR,
        [STATE.ATTENTION]: (s) => slotState(s) === STATE.ATTENTION,
        [STATE.BUSY]: (s) => slotState(s) === STATE.BUSY,
    }[aggregate];
    if (!want)
        return null;
    const matches = slots.filter(want);
    if (matches.length === 0)
        return null;
    // Most recently active wins.
    matches.sort((a, b) => (b.last_turn_ts ?? 0) - (a.last_turn_ts ?? 0));
    return matches[0].key ?? null;
}
