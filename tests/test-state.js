#!/usr/bin/env gjs -m
/* Unit tests for lib/state.js. Run: gjs -m tests/test-state.js  */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const stateUrl = `file://${here}/../kiro-crew@totoshko88.github.io/lib/state.js`;

const {STATE, aggregateState, slotState, targetSlotKey, slotName} = await import(stateUrl);

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

const slots = [
    {key: 'a', needs_input: true, last_turn_ts: 1},
    {key: 'b', needs_input: true, last_turn_ts: 5},
];
eq(targetSlotKey(STATE.ATTENTION, slots), 'b', 'target most recent attention');
eq(targetSlotKey(STATE.IDLE, slots), null, 'target idle null');

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
