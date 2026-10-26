#!/usr/bin/env gjs -m
/* Unit tests for lib/updateInfo.js. Run: gjs -m tests/test-updates.js  */

import GLib from 'gi://GLib';

const here = GLib.path_get_dirname(
    import.meta.url.replace('file://', ''));
const url = `file://${here}/../kiro-crew@totoshko88.github.io/lib/updateInfo.js`;

const {updateInfoFromStatus, statusHasUpdateFields, activeProgress, isFailedStep} = await import(url);

let fail = 0;
function eq(got, want, msg) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
        print(`FAIL: ${msg} got=${g} want=${w}`);
        fail++;
    } else {
        print(`ok: ${msg}`);
    }
}

// A status frame from a cli.sh install on insider (kirocrew 0.11.0rc1), trimmed.
const COMMAND = "set -e; _kc_body=\"$(curl -fsSL --proto '=https' https://download.crew.kiro.dev/cli.sh)\"; " +
    "test -n \"$_kc_body\"; printf '%s\\n' \"$_kc_body\" | sh -s -- --channel insider";
const status = {
    uptime: '8m 59s',
    update_available: true,
    update_can_apply: false,
    update_check_status: 'succeeded',
    update_command: COMMAND,
    update_latest_version: '0.11.0rc2',
    update_latest_version_display: '0.11.0rc2',
    update_channel: 'insider',
    update_channel_move_pending: false,
    update_managed_by: 'kirocrew',
    update_required: false,
    update_min_version: '',
    update_progress: null
};

const info = updateInfoFromStatus(status);
eq(info.update_available, true, 'available');
eq(info.can_apply, false, 'cli.sh install cannot apply');
eq(info.latest_version_display, '0.11.0rc2', 'version');
eq(info.channel, 'insider', 'channel');
eq(info.remediation, {kind: 'command', message: '', command: COMMAND}, 'update command as remediation');
eq(info.requires_restart, true, 'requires restart');
eq(info.update_required, false, 'not required');

eq(updateInfoFromStatus({...status, update_command: ''}).remediation, null, 'no command, no remediation');
eq(updateInfoFromStatus({...status, update_required: true, update_min_version: '0.11.0'}).update_min_version,
    '0.11.0', 'required floor');
// Before a check succeeds the gateway sends update_available: null.
eq(updateInfoFromStatus({...status, update_check_status: 'checking', update_available: null}), null, 'checking: no verdict');
eq(updateInfoFromStatus({...status, update_check_status: 'failed'}), null, 'failed check: no verdict');
eq(updateInfoFromStatus({uptime: '1m'}), null, 'older gateway: no verdict');
eq(updateInfoFromStatus(null), null, 'null status');

eq(statusHasUpdateFields(status), true, 'has update fields');
eq(statusHasUpdateFields({uptime: '1m'}), false, 'older gateway has none');
eq(statusHasUpdateFields(null), false, 'null has none');

eq(activeProgress(null), null, 'no progress');
eq(activeProgress({step: 'building', detail: 'pip'}), {step: 'building', detail: 'pip'}, 'building is active');
eq(activeProgress({step: 'restarting'}), {step: 'restarting', detail: ''}, 'restarting is active');
eq(activeProgress({step: 'done', detail: ''}), null, 'done ends it');
eq(activeProgress({step: 'failed', detail: 'x'}), null, 'failed ends it');
eq(activeProgress({step: 'error'}), null, 'error ends it');
eq(activeProgress({step: ''}), null, 'empty step');
eq(isFailedStep('failed'), true, 'failed is a failure');
eq(isFailedStep('error'), true, 'error is a failure');
eq(isFailedStep('done'), false, 'done is not');

print(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
if (fail > 0)
    imports.system.exit(1);
