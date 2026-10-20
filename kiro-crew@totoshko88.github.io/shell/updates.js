/**
 * updates.js — Check for updates, Update, and the release channel of the
 * active gateway. The gateway runs its own update check; this reads it
 * (GET /api/update/check) and acts on it.
 */

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isCancelled, logUnlessCancelled} from '../lib/cancel.js';
import {usesSshControl} from '../lib/profiles.js';

const CHANNELS = new Set(['stable', 'insider']);

function versionOf(info) {
    return info.latest_version_display || info.latest_version || '';
}

export class UpdateManager {
    /**
     * @param {GatewayConnection} connection
     * @param {Gio.Settings} settings
     * @param {Notifier} notifier
     * @param {object} hooks onChanged(), openDashboard()
     */
    constructor(connection, settings, notifier, hooks) {
        this._connection = connection;
        this._settings = settings;
        this._notifier = notifier;
        this._hooks = hooks;
        this._info = null;
        this._checking = false;
        this._applying = false;
        // The channel we just wrote to mirror the gateway; its 'changed'
        // echo must not be sent back to the gateway as a switch.
        this._mirroredChannel = null;
    }

    get known() {
        return this._info !== null;
    }

    /** The update menu entry: {visible, label, sensitive}. */
    menuItem(gatewayUp) {
        if (!gatewayUp || !this._connection.canControl)
            return {visible: false, label: '', sensitive: false};
        if (this._applying)
            return {visible: true, label: _('Updating…'), sensitive: false};
        if (this._checking && !this._info)
            return {visible: true, label: _('Checking for updates…'), sensitive: false};
        if (this._info?.update_available) {
            const v = versionOf(this._info);
            return {visible: true, label: v ? _('Update to %s').replace('%s', v) : _('Update available'), sensitive: true};
        }
        return {visible: true, label: _('Check for updates'), sensitive: true};
    }

    reset() {
        this._info = null;
    }

    /** Re-read the gateway's update state in the background. */
    refresh() {
        if (this._checking || !this._connection.canControl || !this._connection.client.online)
            return;
        this._check().catch(e => logUnlessCancelled(e, 'update check failed'));
    }

    /** The menu entry was activated: update if one is known, else check now. */
    activate() {
        if (this._info?.update_available)
            this._apply(this._info).catch(e => logUnlessCancelled(e, 'update failed'));
        else if (!this._checking)
            this._checkAndReport().catch(e => logUnlessCancelled(e, 'update check failed'));
    }

    /** The 'channel' setting changed: ask the gateway to switch, unless it is our own echo. */
    onChannelSetting() {
        const channel = this._settings.get_string('channel');
        if (channel === this._mirroredChannel) {
            this._mirroredChannel = null;
            return;
        }
        if (!this._connection.canControl || !this._connection.client.online)
            return;
        this._switchChannel(channel).catch(e => logUnlessCancelled(e, 'switching channel failed'));
    }

    async _check() {
        this._checking = true;
        this._hooks.onChanged();
        let info;
        try {
            info = await this._connection.client.fetchUpdateCheck();
        } finally {
            this._checking = false;
        }
        if (info) {
            this._info = info;
            this._mirrorChannel(info.channel);
        }
        this._hooks.onChanged();
        return info;
    }

    async _checkAndReport() {
        const info = await this._check();
        if (!info) {
            this._notifier.notify(_('Update check failed'),
                _('Could not reach the gateway to check for updates.'));
        } else if (info.update_available) {
            const v = versionOf(info);
            this._notifier.notify(_('Update available'),
                v ? _('Version %s is available.').replace('%s', v) : _('A newer version is available.'));
        } else {
            this._notifier.notify(_('Kiro Crew is up to date'),
                _('You are on the latest %s release.').replace('%s', info.channel));
        }
    }

    /**
     * Apply an update. A gateway that manages its own install applies it
     * (POST /api/update); a wheel/venv install with SSH control is updated on
     * its host with `kirocrew update`; otherwise the dashboard, which owns
     * that install's update flow, is opened — the extension runs no installer.
     */
    async _apply(info) {
        if (this._applying)
            return;
        const conn = this._connection;
        if (!info.can_apply && !usesSshControl(conn.profile)) {
            const v = versionOf(info);
            this._notifier.notify(v ? _('Update to %s available').replace('%s', v) : _('Update available'),
                info.remediation?.message || _('Open the dashboard to update the gateway.'));
            this._hooks.openDashboard();
            return;
        }
        const name = conn.profile.name;
        this._applying = true;
        this._hooks.onChanged();
        try {
            if (info.can_apply) {
                if (await conn.client.applyUpdate() === null)
                    throw new Error(_('The gateway did not accept the update request.'));
            } else {
                await conn.remote.runChecked(conn.profile, 'update');
            }
        } catch (e) {
            this._applying = false;
            if (isCancelled(e))
                throw e;
            this._hooks.onChanged();
            this._notifier.notify(_('Could not update %s').replace('%s', name), e.message);
            return;
        }
        this._applying = false;
        this._info = null;
        this._hooks.onChanged();
        this._notifier.notify(_('Updating %s').replace('%s', name),
            _('The gateway is applying the update and will restart.'));
        conn.client.reconnectNow();
    }

    async _switchChannel(channel) {
        const reply = await this._connection.client.switchChannel(channel);
        if (reply === null) {
            this._notifier.notify(_('Could not switch channel'),
                _('The gateway did not accept the channel change.'));
            return;
        }
        this._info = reply;
        this._hooks.onChanged();
        this._notifier.notify(_('Release channel: %s').replace('%s', channel),
            reply.channel_move_pending
                ? _('The switch takes effect on the next update.')
                : _('Channel switched.'));
    }

    /** The gateway owns its channel; show the truth in the preferences. */
    _mirrorChannel(channel) {
        if (!CHANNELS.has(channel) || channel === this._settings.get_string('channel'))
            return;
        this._mirroredChannel = channel;
        this._settings.set_string('channel', channel);
    }
}
