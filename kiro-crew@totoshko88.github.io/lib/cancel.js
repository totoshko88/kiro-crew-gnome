/* cancel.js — cancellation helpers shared by the shell and prefs processes. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** True for the error an operation fails with once its Gio.Cancellable is cancelled. */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Log a failed async operation, except a cancellation during teardown. */
export function logUnlessCancelled(error, context) {
    if (!isCancelled(error))
        logError(error, `kiro-crew: ${context}`);
}
