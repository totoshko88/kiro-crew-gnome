/**
 * service.js — the local kirocrew.service, over systemd's D-Bus API.
 *
 * `kirocrew service install` writes a system unit; a rootless setup may use a
 * user unit with the same name, so both buses are searched. Stop and start of
 * a system unit go through polkit (org.freedesktop.systemd1.manage-units), so
 * those calls allow interactive authorization and GNOME asks for a password.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isCancelled} from '../lib/cancel.js';
import {unitPort} from '../lib/profiles.js';

const UNIT_NAME = 'kirocrew.service';
const SD_DEST = 'org.freedesktop.systemd1';
const SD_PATH = '/org/freedesktop/systemd1';
const SD_MANAGER = 'org.freedesktop.systemd1.Manager';
const SD_UNIT = 'org.freedesktop.systemd1.Unit';
const SD_SERVICE = 'org.freedesktop.systemd1.Service';
// Overrides the unit reads through EnvironmentFile=; they beat its Environment=.
const ENV_FILE = '/etc/kirocrew/kirocrew.env';

const CALL_TIMEOUT_MS = 5000;
// A stop/start can wait behind a polkit prompt the user is still typing into.
const AUTH_CALL_TIMEOUT_MS = 120000;

/** Did the user dismiss the polkit prompt, or was the request refused? */
export function isAuthDenied(error) {
    if (!(error instanceof GLib.Error))
        return false;
    const name = Gio.DBusError.get_remote_error(error) ?? '';
    return name === 'org.freedesktop.DBus.Error.AccessDenied' ||
        name === 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired' ||
        error.matches(Gio.DBusError, Gio.DBusError.ACCESS_DENIED);
}

export class GatewayService {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._conn = null;
        this._unitPath = null;
        this._detecting = null;
    }

    /** Is a kirocrew.service unit known on either bus? */
    get installed() {
        return this._conn !== null;
    }

    /** ActiveState of the unit ("active", "inactive", …), or null if there is none. */
    async activeState() {
        if (!await this._ensureDetected())
            return null;
        try {
            return await this._unitProperty(SD_UNIT, 'ActiveState');
        } catch (e) {
            if (isCancelled(e))
                throw e;
            // Uninstalled since: look again next time.
            this._forget();
            return null;
        }
    }

    /** Port the unit's gateway listens on (KIROCREW_PORT as systemd resolves it). */
    async port() {
        if (!await this._ensureDetected())
            return null;
        let environment = [];
        try {
            environment = await this._unitProperty(SD_SERVICE, 'Environment');
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        return unitPort(environment, await this._readEnvFile());
    }

    stop() {
        return this._job('StopUnit');
    }

    start() {
        return this._job('StartUnit');
    }

    async _job(method) {
        if (!await this._ensureDetected())
            throw new Error('kirocrew.service is not installed');
        await this._call(this._conn, SD_PATH, SD_MANAGER, method,
            new GLib.Variant('(ss)', [UNIT_NAME, 'replace']), '(o)', true);
    }

    _call(conn, path, iface, method, params, replyType, interactive = false) {
        return new Promise((resolve, reject) => {
            conn.call(SD_DEST, path, iface, method, params, new GLib.VariantType(replyType),
                interactive ? Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION : Gio.DBusCallFlags.NONE,
                interactive ? AUTH_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS,
                this._cancellable,
                (c, res) => {
                    try {
                        resolve(c.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _property(conn, path, iface, prop) {
        const reply = await this._call(conn, path, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [iface, prop]), '(v)');
        return reply.recursiveUnpack()[0];
    }

    _unitProperty(iface, prop) {
        return this._property(this._conn, this._unitPath, iface, prop);
    }

    /** One lookup at a time; resolves to whether a unit was found. */
    _ensureDetected() {
        if (this._conn)
            return Promise.resolve(true);
        if (!this._detecting) {
            this._detecting = this._detect().finally(() => {
                this._detecting = null;
            });
        }
        return this._detecting;
    }

    /**
     * LoadUnit rather than GetUnit: an inactive unit may have been unloaded
     * from the manager, and LoadUnit reports "not-found" when none exists.
     */
    async _detect() {
        for (const bus of [Gio.BusType.SYSTEM, Gio.BusType.SESSION]) {
            try {
                // The shell already holds both connections; this returns them.
                const conn = await this._bus(bus);
                const [path] = (await this._call(conn, SD_PATH, SD_MANAGER, 'LoadUnit',
                    new GLib.Variant('(s)', [UNIT_NAME]), '(o)')).deepUnpack();
                if (await this._property(conn, path, SD_UNIT, 'LoadState') === 'loaded') {
                    this._conn = conn;
                    this._unitPath = path;
                    return true;
                }
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                // No systemd on this bus: try the next one.
            }
        }
        return false;
    }

    _bus(type) {
        return new Promise((resolve, reject) => {
            Gio.bus_get(type, this._cancellable, (_o, res) => {
                try {
                    resolve(Gio.bus_get_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _readEnvFile() {
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path(ENV_FILE).load_contents_async(this._cancellable, (f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    resolve(new TextDecoder('utf-8').decode(bytes));
                } catch (e) {
                    if (isCancelled(e))
                        reject(e);
                    else
                        resolve('');
                }
            });
        });
    }

    _forget() {
        this._conn = null;
        this._unitPath = null;
    }

    destroy() {
        this._cancellable.cancel();
        this._forget();
    }
}
