/**
 * service.js — find and drive the local Kiro Crew gateway service through
 * systemd's D-Bus API. Async only (never blocks the shell main loop), no
 * subprocess, no sudo.
 *
 * `kirocrew service install` registers a SYSTEM unit (kirocrew.service, run as
 * the user); a pod/rootless setup may use a `systemctl --user` unit with the
 * same name. We look on the system bus first, then the session bus.
 *
 * Stopping/starting a system unit is gated by polkit
 * (org.freedesktop.systemd1.manage-units, auth_admin_keep by default), so the
 * call allows interactive authorization: GNOME shows its own password prompt.
 * A user unit needs no authorization.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const UNIT_NAME = 'kirocrew.service';

const SD_DEST = 'org.freedesktop.systemd1';
const SD_PATH = '/org/freedesktop/systemd1';
const SD_MANAGER = 'org.freedesktop.systemd1.Manager';
const SD_UNIT = 'org.freedesktop.systemd1.Unit';

// Plain calls must answer fast; a Stop/Start may sit behind a polkit prompt
// the user is still typing into, so it gets a long timeout.
const CALL_TIMEOUT_MS = 5000;
const AUTH_CALL_TIMEOUT_MS = 120000;

/** Errors that mean "the user dismissed / was refused the polkit prompt". */
export function isAuthDenied(error) {
    const name = Gio.DBusError.get_remote_error(error) ?? '';
    return name === 'org.freedesktop.DBus.Error.AccessDenied' ||
        name === 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired' ||
        error?.matches?.(Gio.DBusError, Gio.DBusError.ACCESS_DENIED) === true;
}

export class GatewayService {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._conn = null;      // Gio.DBusConnection of the bus that has the unit
        this._unitPath = null;  // object path of the loaded unit
        this._scope = null;     // 'system' | 'user' | null
        this._detecting = null; // in-flight detect() promise
    }

    /** 'system', 'user', or null when no installed unit was found. */
    get scope() {
        return this._scope;
    }

    _call(conn, path, iface, method, params, replyType, {
        interactive = false, timeout = CALL_TIMEOUT_MS
    } = {}) {
        const flags = interactive
            ? Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION
            : Gio.DBusCallFlags.NONE;
        return new Promise((resolve, reject) => {
            conn.call(SD_DEST, path, iface, method, params,
                replyType ? new GLib.VariantType(replyType) : null,
                flags, timeout, this._cancellable,
                (c, res) => {
                    try {
                        resolve(c.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _getUnitProperty(conn, path, prop) {
        const reply = await this._call(conn, path,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [SD_UNIT, prop]), '(v)');
        return reply.recursiveUnpack()[0];
    }

    /**
     * Locate an installed kirocrew.service. LoadUnit (not GetUnit) because an
     * inactive unit may have been garbage-collected from the manager; LoadUnit
     * returns a stub with LoadState "not-found" when nothing is installed.
     * Resolves to the scope, or null.
     */
    async detect() {
        // The shell already holds both bus connections; these getters return
        // the shared singletons rather than opening new ones.
        const buses = [['system', () => Gio.DBus.system], ['user', () => Gio.DBus.session]];
        for (const [scope, getBus] of buses) {
            if (this._cancellable.is_cancelled())
                return null;
            try {
                const conn = getBus();
                const reply = await this._call(conn, SD_PATH, SD_MANAGER, 'LoadUnit',
                    new GLib.Variant('(s)', [UNIT_NAME]), '(o)');
                const [path] = reply.deepUnpack();
                const load = await this._getUnitProperty(conn, path, 'LoadState');
                if (load === 'loaded') {
                    this._conn = conn;
                    this._unitPath = path;
                    this._scope = scope;
                    return scope;
                }
            } catch {
                // No such bus / no systemd on it: try the next one.
            }
        }
        this._conn = null;
        this._unitPath = null;
        this._scope = null;
        return null;
    }

    /** detect(), coalescing overlapping callers onto one lookup. */
    _ensureDetected() {
        if (!this._detecting) {
            this._detecting = this.detect().finally(() => {
                this._detecting = null;
            });
        }
        return this._detecting;
    }

    /**
     * The unit's ActiveState ("active", "inactive", "activating",
     * "deactivating", "failed", "reloading"), or null if unknown.
     */
    async activeState() {
        if (!this._conn && !(await this._ensureDetected()))
            return null;
        try {
            return await this._getUnitProperty(this._conn, this._unitPath, 'ActiveState');
        } catch {
            // The unit went away (uninstalled) — rediscover next time.
            this._conn = null;
            this._unitPath = null;
            this._scope = null;
            return null;
        }
    }

    async _job(method) {
        if (!this._conn && !(await this._ensureDetected()))
            throw new Error('kirocrew.service is not installed');
        await this._call(this._conn, SD_PATH, SD_MANAGER, method,
            new GLib.Variant('(ss)', [UNIT_NAME, 'replace']), '(o)',
            {interactive: true, timeout: AUTH_CALL_TIMEOUT_MS});
    }

    /** Queue a stop job. Rejects on polkit refusal or D-Bus error. */
    stop() {
        return this._job('StopUnit');
    }

    /** Queue a start job. Rejects on polkit refusal or D-Bus error. */
    start() {
        return this._job('StartUnit');
    }

    destroy() {
        this._cancellable.cancel();
        this._conn = null;
        this._unitPath = null;
        this._scope = null;
    }
}
