/**
 * lifecycle.js — Stop, Start and Restart of the active gateway, and the
 * service state they depend on.
 *
 * Control modes:
 *   'service'  the local kirocrew.service over systemd D-Bus
 *   'ssh'      the remote host's kirocrew.service, `sudo -n systemctl` over SSH
 *   'api'      a hand-run local `kirocrew gateway` (POST /api/shutdown)
 *   null       a read-only remote profile, or nothing known to control
 * A unit is only controlled when it listens on the profile's port, so a
 * profile for one gateway can never stop another.
 */

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GatewayService, isAuthDenied} from './service.js';
import {isCancelled, logUnlessCancelled} from '../lib/cancel.js';
import {usesSshControl} from '../lib/profiles.js';

const WATCH_INTERVAL_S = 1;
const STOP_WATCH_S = 30;
const START_WATCH_S = 60;

const DOWN = new Set(['inactive', 'failed']);

export class GatewayLifecycle {
    /**
     * @param {GatewayConnection} connection
     * @param {Notifier} notifier
     * @param {() => void} onChanged called whenever anything shown changes
     */
    constructor(connection, notifier, onChanged) {
        this._connection = connection;
        this._notifier = notifier;
        this._onChanged = onChanged;
        this._service = new GatewayService();
        this._svcActive = null;
        this._svcPort = null;
        this._pendingOp = null;
        this._manualStopped = false;
        this._watchId = 0;
        this._watchBusy = false;
    }

    /** 'stop', 'start', 'restart' while one settles, else null. */
    get pendingOp() {
        return this._pendingOp;
    }

    get starting() {
        return this._pendingOp === 'start' || this._svcActive === 'activating';
    }

    get stopping() {
        return this._pendingOp === 'stop' || this._svcActive === 'deactivating';
    }

    controlMode() {
        const conn = this._connection;
        const portMatches = this._svcPort === Number(conn.profile.port);
        if (usesSshControl(conn.profile))
            return this._svcActive !== null && portMatches ? 'ssh' : null;
        if (!conn.isLocal)
            return null;
        // A unit that is down while a gateway still answers on this port means
        // the gateway was started by hand: control that one through its API.
        if (this._service.installed && portMatches && !(DOWN.has(this._svcActive) && conn.client.online))
            return 'service';
        if (conn.client.online || this._manualStopped)
            return 'api';
        return null;
    }

    /** Was the gateway stopped on purpose, or is a Stop/Start settling? */
    isStopped() {
        if (!this._connection.canControl)
            return false;
        if (this._pendingOp)
            return true;
        const mode = this.controlMode();
        if (mode === 'service' || mode === 'ssh')
            return this._svcActive === 'inactive' || this._svcActive === 'deactivating';
        return this._manualStopped && !this._connection.client.online;
    }

    /** Can the menu offer a Start for a stopped gateway? */
    canStart() {
        const mode = this.controlMode();
        return mode === 'service' || mode === 'ssh';
    }

    /** The Stop/Start menu entry right now: {label, action}, label null = hidden. */
    menuAction() {
        if (this._pendingOp === 'stop')
            return {label: _('Stopping gateway…'), action: null};
        if (this._pendingOp === 'start')
            return {label: _('Starting gateway…'), action: null};
        const mode = this.controlMode();
        if (mode === 'service' || mode === 'ssh') {
            switch (this._svcActive) {
                case 'inactive':
                case 'failed':
                    return {label: _('Start gateway'), action: 'start'};
                case 'deactivating':
                    return {label: _('Stopping gateway…'), action: null};
                case 'active':
                case 'activating':
                case 'reloading':
                // Stop also breaks an auto-restart crash loop.
                    return {label: _('Stop gateway'), action: 'stop'};
                default:
                    return {label: null, action: null};
            }
        }
        if (mode === 'api' && this._connection.client.online)
            return {label: _('Stop gateway'), action: 'stop'};
        return {label: null, action: null};
    }

    /** Forget everything about the previous gateway after a profile switch. */
    reset() {
        this._cancelWatch();
        this._pendingOp = null;
        this._manualStopped = false;
        this._svcActive = null;
        this._svcPort = null;
    }

    onOnline(online) {
        if (!online)
            return;
        this._manualStopped = false;
        if (this._pendingOp === 'start' || this._pendingOp === 'restart')
            this._finishOp();
    }

    /** Re-read the service state in the background. */
    refresh() {
        this._refresh().catch(e => logUnlessCancelled(e, 'reading gateway service state failed'));
    }

    async _refresh() {
        const conn = this._connection;
        if (!conn.canControl) {
            this._svcActive = null;
            this._svcPort = null;
            this._onChanged();
            return;
        }
        const id = conn.profile.id;
        let active = null;
        let port = null;
        try {
            if (conn.isLocal) {
                active = await this._service.activeState();
                port = active === null ? null : await this._service.port();
            } else {
                const probe = await conn.remote.probe(conn.profile);
                if (probe?.loaded) {
                    active = probe.active;
                    port = probe.port;
                }
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
            logError(e, 'kiro-crew: reading gateway service state failed');
        }
        // The user switched profiles while this was in flight.
        if (conn.profile.id !== id)
            return;
        this._svcActive = active;
        this._svcPort = port;
        if (this.canStart()) {
            // Hold the socket closed while the gateway is down on purpose, and
            // reconnect when it was started elsewhere (e.g. systemctl).
            const down = active === 'inactive' || active === 'deactivating';
            if (down && this._pendingOp !== 'start')
                conn.client.pause();
            else if (!down && active !== 'failed' && conn.client.paused && this._pendingOp !== 'stop')
                conn.client.resume();
        }
        this._onChanged();
    }

    async stop() {
        if (this._pendingOp)
            return;
        const conn = this._connection;
        const mode = this.controlMode();
        this._pendingOp = 'stop';
        this._onChanged();
        try {
            if (mode === 'service')
                await this._service.stop();
            else if (mode === 'ssh')
                await conn.remote.runChecked(conn.profile, 'stop');
            else if (await conn.shutdownLocal())
                this._manualStopped = true;
            else
                throw new Error(_('The gateway did not accept the shutdown request.'));
        } catch (e) {
            this._failOp(e, _('Could not stop the gateway'));
            return;
        }
        conn.client.pause();
        this._watch(STOP_WATCH_S, () => mode === 'api' || DOWN.has(this._svcActive));
    }

    async start() {
        if (this._pendingOp)
            return;
        const conn = this._connection;
        const mode = this.controlMode();
        this._pendingOp = 'start';
        this._onChanged();
        try {
            if (mode === 'ssh')
                await conn.remote.runChecked(conn.profile, 'start');
            else
                await this._service.start();
        } catch (e) {
            this._failOp(e, _('Could not start the gateway'));
            return;
        }
        conn.client.resume();
        // onOnline() settles it once the socket connects; after the timeout a
        // gateway that never came up shows as offline.
        this._watch(START_WATCH_S, () => conn.client.online);
    }

    /** Restart in place through the gateway's own API (any layout). */
    async restart() {
        if (this._pendingOp)
            return;
        const client = this._connection.client;
        this._pendingOp = 'restart';
        this._onChanged();
        let accepted;
        try {
            accepted = await client.restart();
        } catch (e) {
            this._failOp(e, _('Could not restart the gateway'));
            return;
        }
        if (!accepted) {
            this._failOp(new Error(_('The gateway did not accept the restart request.')),
                _('Could not restart the gateway'));
            return;
        }
        client.reconnectNow();
        this._watch(START_WATCH_S, () => client.online);
    }

    _failOp(error, title) {
        if (isCancelled(error))
            return;
        this._pendingOp = null;
        this._onChanged();
        // A dismissed polkit prompt is the user's choice, not an error.
        if (isAuthDenied(error))
            return;
        logError(error, `kiro-crew: ${title}`);
        this._notifier.notify(title, error.message);
    }

    /** Poll the service every second until done() holds or the timeout ends. */
    _watch(timeoutS, done) {
        this._cancelWatch();
        let elapsed = 0;
        this._watchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCH_INTERVAL_S, () => {
            elapsed += WATCH_INTERVAL_S;
            // An SSH probe can take longer than a tick; never stack them.
            if (this._watchBusy)
                return GLib.SOURCE_CONTINUE;
            this._watchBusy = true;
            this._refresh().then(() => {
                this._watchBusy = false;
                if (this._watchId && (done() || elapsed >= timeoutS))
                    this._finishOp();
            }).catch(e => {
                this._watchBusy = false;
                logUnlessCancelled(e, 'reading gateway service state failed');
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelWatch() {
        if (this._watchId) {
            GLib.source_remove(this._watchId);
            this._watchId = 0;
        }
    }

    _finishOp() {
        this._cancelWatch();
        this._pendingOp = null;
        this._onChanged();
    }

    destroy() {
        this._cancelWatch();
        this._service.destroy();
    }
}
