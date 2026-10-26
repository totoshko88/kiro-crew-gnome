#!/usr/bin/env gjs -m
/* Unit tests for lib/state.js. Run: gjs -m tests/test-state.js  */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const stateUrl = `file://${here}/../kiro-crew@totoshko88.github.io/lib/state.js`;

const {
    STATE, aggregateState, slotState, slotHint, targetSlotKey, slotName,
    slotRecency, activeSessionCount, menuRows
} = await import(stateUrl);

let fail = 0;
function eq(got, want, msg) {
    if (got !== want) {
        print(`FAIL: ${msg} got=${got} want=${want}`);
        fail++;
    } else {
        print(`ok: ${msg}`);
    }
}

eq(aggregateState({online: false, slots: [{running: true}]}), STATE.OFFLINE, 'offline overrides busy');
eq(aggregateState({online: true, slots: []}), STATE.IDLE, 'idle empty');
eq(aggregateState({online: true, slots: [{running: true}]}), STATE.BUSY, 'busy');
eq(aggregateState({online: true, slots: [{running: true}, {needs_input: true}]}), STATE.ATTENTION, 'attention over busy');
eq(aggregateState({online: true, slots: [{pending_approval: true}]}), STATE.ATTENTION, 'approval attention');
// The gateway's mcp_report: server names in `failed`, details in `failures`.
const failedMcp = {configured: ['a', 'b'], ready: ['a'], failed: ['b'], failures: {b: 'exited'}};
const healthyMcp = {configured: ['a'], ready: ['a'], failed: [], failures: {}, awaiting_auth: []};
eq(aggregateState({online: true, slots: [{needs_input: true}, {mcp_report: failedMcp}]}), STATE.ERROR, 'mcp error top');
eq(aggregateState({online: true, slots: [{running: true}], criticalNotice: true}), STATE.ERROR, 'critical notice error');
eq(aggregateState({online: false, slots: [], authError: true}), STATE.AUTH, 'authError beats offline');
eq(aggregateState({online: true, slots: [{running: true}], authError: true}), STATE.AUTH, 'authError beats busy');
eq(aggregateState({online: true, slots: [{mcp_report: failedMcp}], authError: true}), STATE.AUTH, 'authError beats mcp error');
eq(slotState({running: true}), STATE.BUSY, 'slotState busy');
eq(slotState({mcp_report: failedMcp}), STATE.ERROR, 'slotState failed mcp server');
eq(slotState({mcp_report: healthyMcp}), STATE.IDLE, 'slotState healthy mcp report is idle');
eq(slotState({mcp_report: null}), STATE.IDLE, 'slotState null mcp report is idle');

// Multi-session: a session whose main turn ended but whose subagents still
// run is working (the 0.1.1 bug showed only the session with running:true).
eq(slotState({running: false, subagents_running: true}), STATE.BUSY, 'subagents_running is busy');
eq(slotState({subagents_queued: 1}), STATE.BUSY, 'queued subagents is busy');
eq(slotState({subagents_queued: 0}), STATE.IDLE, 'no queued subagents is idle');
eq(slotState({compacting: true}), STATE.BUSY, 'compaction is busy');
eq(slotState({queue_depth: 2}), STATE.BUSY, 'queued prompts is busy');
eq(slotState({queue_depth: 0}), STATE.IDLE, 'empty queue is idle');
// waiting_for_input means the turn ended and the chat awaits your next message.
eq(slotState({waiting_for_input: true}), STATE.IDLE, 'waiting_for_input alone is idle');

// An MCP server waiting for sign-in blocks the session on you: amber, with a hint.
const authMcp = {configured: ['gh'], ready: [], failed: [], awaiting_auth: ['gh']};
eq(slotState({mcp_report: authMcp}), STATE.ATTENTION, 'mcp awaiting_auth is attention');
eq(slotState({mcp_report: authMcp, running: true}), STATE.ATTENTION, 'mcp sign-in beats busy');
eq(slotState({mcp_report: {...authMcp, failed: ['x']}}), STATE.ERROR, 'failed mcp beats sign-in');
eq(slotHint({mcp_report: authMcp}), 'mcp-auth', 'slotHint mcp-auth');
eq(slotHint({mcp_report: authMcp, needs_input: true}), null, 'question has no sign-in hint');
eq(slotHint({mcp_report: healthyMcp}), null, 'healthy report has no hint');
eq(slotHint({}), null, 'no report has no hint');
{
    const rows = menuRows([{key: 'dashboard_chat-1-1', title: 'A'}],
        [{key: 'chat-1-1', mcp_report: authMcp}, {key: 'chat-2-1', title: 'B', mcp_report: authMcp}]);
    eq(rows.map(r => r.hint).join(','), 'mcp-auth,mcp-auth', 'menuRows carries the hint (pinned + recent)');
    eq(menuRows([{key: 'dashboard_chat-9-1', title: 'Gone'}], [])[0].hint, null, 'menuRows: no live slot, no hint');
}
// has_options = quick-reply suggestion chips after a finished turn: not a block.
eq(slotState({has_options: true, running: false}), STATE.IDLE, 'has_options alone is idle');
eq(slotState({has_options: true, running: true}), STATE.BUSY, 'has_options + running is busy');
eq(slotState({pending_approval: true, subagents_running: true}), STATE.ATTENTION, 'approval beats subagents');
eq(slotState({interrupted: true}), STATE.IDLE, 'interrupted is idle');
eq(aggregateState({online: true, slots: [{interrupted: true}]}), STATE.IDLE, 'interrupted does not tint the ghost');
// The reported case: one running session, many finished ones with chips.
eq(aggregateState({online: true, slots: [
    {key: 'chat-13', running: true},
    {key: 'chat-11', has_options: true},
    {key: 'chat-14', has_options: true},
    {key: 'chat-12'},
]}), STATE.BUSY, 'one running + idle sessions with chips is busy');
eq(aggregateState({online: true, slots: [
    {key: 'a', running: true},
    {key: 'b', running: false, subagents_running: true},
]}), STATE.BUSY, 'two working sessions aggregate busy');
eq(activeSessionCount([
    {running: true}, {subagents_running: true}, {needs_input: true}, {}, {interrupted: true},
]), 3, 'activeSessionCount counts working + waiting');

// Deliberately stopped gateway.
eq(aggregateState({online: false, stopped: true}), STATE.STOPPED, 'stopped beats offline');
eq(aggregateState({online: false, stopped: true, authError: true}), STATE.STOPPED, 'stopped beats auth');
eq(aggregateState({online: true, slots: [{running: true}], stopped: true}), STATE.STOPPED, 'stopped beats stale busy');

// Left-click target: the gateway sends ISO strings ("" for never-run).
const slots = [
    {key: 'a', needs_input: true, last_turn_ts: 1},
    {key: 'b', needs_input: true, last_turn_ts: 5},
];
eq(targetSlotKey(STATE.ATTENTION, slots), 'b', 'target most recent attention (numeric ts)');
eq(targetSlotKey(STATE.IDLE, slots), null, 'target idle null');
const isoSlots = [
    {key: 'old', running: true, last_activity_ts: '2026-10-03T11:22:45.8+00:00'},
    {key: 'new', subagents_running: true, last_activity_ts: '2026-10-03T13:24:48.7+00:00'},
    {key: 'never', running: true, last_activity_ts: '', last_turn_ts: ''},
];
eq(targetSlotKey(STATE.BUSY, isoSlots), 'new', 'target most recent busy (ISO ts)');
eq(slotRecency({last_activity_ts: '', last_turn_ts: '2026-10-03T11:00:00Z'}),
    Date.parse('2026-10-03T11:00:00Z'), 'slotRecency falls back to last_turn_ts');
eq(slotRecency({}), -Infinity, 'slotRecency unknown sorts last');

// Menu rows: same rule as the ghost; off-list active slots pinned on top.
{
    const sessions = [
        {key: 'dashboard_chat-13-1', title: 'Research'},
        {key: 'dashboard_chat-12-1', title: 'dashboard_chat-12-1'},
    ];
    const live = [
        {key: 'chat-13-1', running: true},
        {key: 'chat-12-1', title: 'New Session…', has_options: true},
        {key: 'chat-2-1', title: 'Old', needs_input: true, last_activity_ts: '2026-01-01T00:00:00Z'},
        {key: 'chat-3-1', title: 'Older idle'},
    ];
    const rows = menuRows(sessions, live);
    eq(rows.map(r => r.key).join(','), 'chat-2-1,dashboard_chat-13-1,dashboard_chat-12-1',
        'menuRows pins off-list attention slot, skips off-list idle');
    eq(rows.map(r => r.state).join(','), 'attention,busy,idle', 'menuRows states match slotState');
    eq(rows[2].title, 'New Session…', 'menuRows title falls back to live slot title');
    const worst = aggregateState({online: true, slots: live});
    eq(rows.some(r => r.state === worst), true, 'ghost state is visible as a dot');
}


eq(slotName('dashboard:my-chat'), 'my-chat', 'slotName strips dashboard: prefix');
eq(slotName('dashboard_chat-8-1790892507'), 'chat-8-1790892507', 'slotName strips single dashboard_ stem');
eq(slotName('dashboard_dashboard_my-chat'), 'my-chat', 'slotName strips doubled stem');
eq(slotName('slack:1712793600.123'), '1712793600.123', 'slotName strips slack: prefix');
eq(slotName('slack_1712793600.123'), '1712793600.123', 'slotName strips slack_ stem');
eq(slotName('plain-name'), 'plain-name', 'slotName passthrough no prefix');
eq(slotName(''), '', 'slotName empty');
eq(slotName(null), '', 'slotName null safe');

print(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
if (fail > 0)
    imports.system.exit(1);
