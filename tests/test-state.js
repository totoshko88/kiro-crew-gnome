#!/usr/bin/env gjs -m
/* Unit tests for lib/state.js. Run: gjs -m tests/test-state.js  */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const stateUrl = `file://${here}/../kiro-crew@totoshko88.github.io/lib/state.js`;

const {
    STATE, aggregateState, slotState, targetSlotKey, slotName,
    slotRecency, activeSessionCount, isLoopbackEndpoint, menuRows
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
eq(aggregateState({online: true, slots: [{needs_input: true}, {mcp_report: {status: 'error'}}]}), STATE.ERROR, 'mcp error top');
eq(aggregateState({online: true, slots: [{running: true}], criticalNotice: true}), STATE.ERROR, 'critical notice error');
eq(aggregateState({online: false, slots: [], authError: true}), STATE.AUTH, 'authError beats offline');
eq(aggregateState({online: true, slots: [{running: true}], authError: true}), STATE.AUTH, 'authError beats busy');
eq(aggregateState({online: true, slots: [{mcp_report: {status: 'error'}}], authError: true}), STATE.AUTH, 'authError beats mcp error');
eq(slotState({running: true}), STATE.BUSY, 'slotState busy');
eq(slotState({mcp_report: {severity: 'critical'}}), STATE.ERROR, 'slotState mcp severity');

// Multi-session: a session whose main turn ended but whose subagents still
// run is working (the 0.1.1 bug showed only the session with running:true).
eq(slotState({running: false, subagents_running: true}), STATE.BUSY, 'subagents_running is busy');
eq(slotState({orchestrating: true}), STATE.BUSY, 'orchestrating is busy');
eq(slotState({queue_depth: 2}), STATE.BUSY, 'queued prompts is busy');
eq(slotState({queue_depth: 0}), STATE.IDLE, 'empty queue is idle');
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

eq(isLoopbackEndpoint('http://localhost:5476'), true, 'loopback localhost');
eq(isLoopbackEndpoint('http://127.0.0.1:5476/'), true, 'loopback 127.0.0.1');
eq(isLoopbackEndpoint('http://[::1]:5476'), true, 'loopback ::1');
eq(isLoopbackEndpoint('https://crew.example.com'), false, 'remote host');
eq(isLoopbackEndpoint('http://localhost.example.com'), false, 'localhost lookalike');
eq(isLoopbackEndpoint(''), false, 'empty endpoint');

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
