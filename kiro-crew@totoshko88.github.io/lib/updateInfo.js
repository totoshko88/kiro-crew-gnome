/**
 * updateInfo.js — the gateway's update state as the extension uses it. Pure
 * JavaScript, covered by tests/test-updates.js.
 *
 * Two sources share one shape: GET /api/update/check, and the update_* fields
 * of the "dashboard" status frame the gateway pushes over /api/ws every few
 * seconds.
 */

// Update progress steps that end an update (see push_update_progress on the gateway).
const FINAL_STEPS = new Set(['done', 'failed', 'error']);
const FAILED_STEPS = new Set(['failed', 'error']);

/**
 * The update state carried by a status frame, in the shape of
 * GET /api/update/check. Null when the frame has no verdict to show: an older
 * gateway without these fields, or a check that has not succeeded (the
 * gateway sends update_available: null then).
 */
export function updateInfoFromStatus(status) {
    if (status?.update_check_status !== 'succeeded')
        return null;
    const command = typeof status.update_command === 'string' ? status.update_command : '';
    return {
        update_available: status.update_available === true,
        can_apply: status.update_can_apply === true,
        latest_version: String(status.update_latest_version ?? ''),
        latest_version_display: String(status.update_latest_version_display ?? ''),
        channel: String(status.update_channel ?? ''),
        channel_move_pending: status.update_channel_move_pending === true,
        update_required: status.update_required === true,
        update_min_version: String(status.update_min_version ?? ''),
        // Every install shape the gateway knows restarts to finish an update.
        requires_restart: true,
        remediation: command ? {kind: 'command', message: '', command} : null
    };
}

/** Does a status frame carry the update fields at all? */
export function statusHasUpdateFields(status) {
    return Boolean(status && typeof status === 'object' && 'update_check_status' in status);
}

/** {step, detail} of an update in flight, or null when none is. */
export function activeProgress(progress) {
    const step = typeof progress?.step === 'string' ? progress.step : '';
    if (!step || FINAL_STEPS.has(step))
        return null;
    return {step, detail: String(progress.detail ?? '')};
}

export function isFailedStep(step) {
    return FAILED_STEPS.has(step);
}
