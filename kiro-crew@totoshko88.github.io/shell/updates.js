/**
 * updates.js — Check for updates, Update, and the release channel of the
 * active gateway. The gateway runs its own update check and pushes the
 * verdict in its status frame; this follows it, checks on request
 * (GET /api/update/check), and acts on it.
 */

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isCancelled, logUnlessCancelled} from '../lib/cancel.js';
import {usesSshControl} from '../lib/profiles.js';
import {updateInfoFromStatus, statusHasUpdateFields, activeProgress, isFailedStep} from '../lib/updateInfo.js';

const CHANNELS = new Set(['stable', 'insider']);

function versionOf(info) {
    return info.latest_version_display || info.latest_version || '';
}

function progressLabel(step) {
    switch (step) {
        case 'pulling': return _('Updating: downloading…');
        case 'syncing': return _('Updating: syncing…');
        case 'building': return _('Updating: building…');
        case 'installing': return _('Updating: installing…');
        case 'restarting': return _('Updating: restarting…');
        default: return _('Updating…');
    }
}

export class UpdateManager {
    /**
     * @param {GatewayConnection} connection
     * @param {Gio.Settings} settings
     * @param {Notifier} notifier
     * @param {object} hooks onChanged(), openPage(path), confirm(dialog, onConfirm)
     */
    constructor(connection, settings, notifier, hooks) {
        this._connection = connection;
        this._settings = settings;
        this._notifier = notifier;
        this._hooks = hooks;
        this._info = null;
        // {step, detail} of an update the gateway is applying, else null.
        this._progress = null;
        this._checking = false;
        this._applying = false;
        // The minimum version we last told the user about, so a required
        // update is announced once, not on every status frame.
        this._requiredNotified = '';
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
        if (this._progress)
            return {visible: true, label: progressLabel(this._progress.step), sensitive: false};
        if (this._applying)
            return {visible: true, label: _('Updating…'), sensitive: false};
        if (this._checking && !this._info)
            return {visible: true, label: _('Checking for updates…'), sensitive: false};
        const info = this._info;
        if (info?.update_available) {
            const v = versionOf(info);
            // An ellipsis when the click opens the update-command dialog.
            const viaTerminal = !info.can_apply && !usesSshControl(this._connection.profile);
            let label;
            if (!v)
                label = info.update_required ? _('Update required') : _('Update available');
            else if (info.update_required)
                label = (viaTerminal ? _('Update required: %s…') : _('Update required: %s')).replace('%s', v);
            else
                label = (viaTerminal ? _('Update to %s…') : _('Update to %s')).replace('%s', v);
            return {visible: true, label, sensitive: true};
        }
        if (info?.update_required)
            return {visible: true, label: _('Update required'), sensitive: true};
        return {visible: true, label: _('Check for updates'), sensitive: true};
    }

    reset() {
        this._info = null;
        this._progress = null;
        this._requiredNotified = '';
    }

    /**
     * The gateway's status frame (every few seconds over the socket): follow
     * its update verdict and progress without a request of our own. A gateway
     * too old to send them is checked once instead.
     */
    onStatus(status) {
        if (!this._connection.canControl)
            return;
        if (!statusHasUpdateFields(status)) {
            if (!this.known)
                this.refresh();
            return;
        }
        const before = JSON.stringify(this.menuItem(true));
        this._progress = activeProgress(status.update_progress);
        const info = updateInfoFromStatus(status);
        if (info) {
            this._info = info;
            this._mirrorChannel(info.channel);
            this._announceRequired(info);
        }
        if (JSON.stringify(this.menuItem(true)) !== before)
            this._hooks.onChanged();
    }

    /** A live update_progress event: show the step, report a failure once. */
    onProgress({step, detail}) {
        if (!this._connection.canControl)
            return;
        this._progress = activeProgress({step, detail});
        if (isFailedStep(step)) {
            this._notifier.notify(_('Could not update %s').replace('%s', this._connection.profile.name),
                detail || _('See the gateway logs for details.'));
        }
        this._hooks.onChanged();
    }

    _announceRequired(info) {
        if (!info.update_required || !info.update_available) {
            this._requiredNotified = '';
            return;
        }
        const key = info.update_min_version || versionOf(info);
        if (key === this._requiredNotified)
            return;
        this._requiredNotified = key;
        this._notifier.notify(_('Kiro Crew update required'), info.update_min_version
            ? _('The gateway requires version %s or newer. Click to update.').replace('%s', info.update_min_version)
            : _('The gateway requires an update. Click to update.'),
        () => this.activate());
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
     * its host with `kirocrew update`. Any other install is updated from a
     * terminal (see _offerCommand) — the extension runs no installer here.
     */
    async _apply(info) {
        if (this._applying)
            return;
        const conn = this._connection;
        if (!info.can_apply && !usesSshControl(conn.profile)) {
            this._offerCommand(info);
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

    /**
     * An install the gateway cannot update in place (a cli.sh or pipx one)
     * names the command that updates it. Show that command, and copy it to the
     * clipboard only when the user asks; it runs in the user's own terminal.
     * Without a command (a container, a desktop app) open the dashboard's About
     * page, which owns that install's update flow.
     */
    _offerCommand(info) {
        const v = versionOf(info);
        const title = v ? _('Update Kiro Crew to %s').replace('%s', v) : _('Update Kiro Crew');
        const command = info.remediation?.kind === 'command' ? String(info.remediation.command ?? '') : '';
        if (!command) {
            this._notifier.notify(title, info.remediation?.message || _('Open the dashboard to update the gateway.'));
            this._hooks.openPage('/settings/about');
            return;
        }
        this._hooks.confirm({
            title,
            description: `${_('The gateway can’t update itself while it runs. Update it by running this command in a terminal:')}\n\n${command}`,
            actionLabel: _('Copy command')
        }, () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
            this._notifier.notify(_('Update command copied'), info.requires_restart
                ? _('Paste it into a terminal. When it finishes, choose Restart gateway in the Kiro Crew menu.')
                : _('Paste it into a terminal to update the gateway.'));
        });
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
