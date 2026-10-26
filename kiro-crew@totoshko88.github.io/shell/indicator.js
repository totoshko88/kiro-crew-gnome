/**
 * indicator.js — the top-bar ghost: one panel button whose icon reflects the
 * aggregate state of every agent session on the active gateway.
 */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {IconAnimator} from './animator.js';
import {Confirmation} from './confirm.js';
import {GatewayConnection} from './connection.js';
import {GatewayLifecycle} from './lifecycle.js';
import {IndicatorMenu} from './menu.js';
import {Notifier} from './notifier.js';
import {UpdateManager} from './updates.js';
import {logUnlessCancelled} from '../lib/cancel.js';
import {
    STATE, ICON_NAME, STYLE_CLASS, aggregateState, targetSlotKey, activeSessionCount, menuRows
} from '../lib/state.js';

// Opacity of the panel icon while the gateway is stopped on purpose (0-255).
const STOPPED_OPACITY = 115;

// The notification channel of tool approval requests.
const APPROVAL_CHANNEL = 'system.approval';

function stateLabel(state) {
    switch (state) {
        case STATE.STOPPED: return _('Gateway stopped');
        case STATE.OFFLINE: return _('Gateway offline');
        case STATE.AUTH: return _('Token expired — update in Settings');
        case STATE.ERROR: return _('Problem — attention needed');
        case STATE.ATTENTION: return _('Waiting for you');
        case STATE.BUSY: return _('Working…');
        default: return _('Idle');
    }
}

export class Indicator {
    constructor(extension) {
        this._ext = extension;
        this._settings = extension.getSettings();
        this._slots = [];
        this._state = STATE.OFFLINE;
        this._criticalNotice = false;
        this._tunnelNotified = '';
        this._pollId = 0;
        this._giconCache = new Map();

        this.button = new PanelMenu.Button(0.0, 'Kiro Crew', false);
        this._icon = new St.Icon({gicon: this._gicon(ICON_NAME.offline), style_class: STYLE_CLASS.offline});
        this.button.add_child(this._icon);
        this._animator = new IconAnimator(this._icon);
        // Left click opens the session that needs you; the menu is on right click.
        this._buttonPressId = this.button.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._openTarget();
            return Clutter.EVENT_STOP;
        });

        this._notifier = new Notifier(ICON_NAME.error);
        this._confirmation = new Confirmation();
        this._connection = new GatewayConnection(this._settings, {
            onSlots: slots => this._onSlots(slots),
            onNotification: note => this._onNotification(note),
            onStatus: status => this._updates.onStatus(status),
            onUpdateProgress: progress => this._updates.onProgress(progress),
            onOnline: online => this._onOnline(online),
            onAuthError: () => this._recompute(),
            onTunnelState: (state, error) => this._onTunnelState(state, error)
        });
        this._lifecycle = new GatewayLifecycle(this._connection, this._notifier, () => this._recompute());
        this._updates = new UpdateManager(this._connection, this._settings, this._notifier, {
            onChanged: () => this._updateControls(),
            openPage: path => this._openUrl(this._connection.pageUrl(path)),
            confirm: (dialog, onConfirm) => this._confirmation.ask(dialog, onConfirm)
        });
        this._menu = new IndicatorMenu(this.button.menu, {
            openDashboard: () => this._openUrl(this._connection.pageUrl('/')),
            openLogs: () => this._openUrl(this._connection.pageUrl('/logs')),
            selectProfile: id => this._settings.set_string('active-profile', id),
            gatewayAction: action => this._onGatewayAction(action),
            restart: () => this._confirmRestart(),
            reconnect: () => this._connection.client.reconnectNow(),
            update: () => this._updates.activate(),
            settings: () => this._ext.openPreferences(),
            opened: () => {
                this._refreshSessions();
                this._lifecycle.refresh();
            }
        });
        this._menu.setProfiles(this._connection.profiles(), this._connection.profile.id);

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));

        this._connection.start();
        this._startPoll();
        this._recompute();
        this._refreshSessions();
        this._lifecycle.refresh();
    }

    _onSettingChanged(key) {
        switch (key) {
            case 'profiles':
            case 'active-profile':
                this._onProfilesChanged();
                break;
            case 'channel':
                this._updates.onChannelSetting();
                break;
            case 'max-sessions':
            case 'show-previews':
                this._refreshSessions();
                break;
            case 'poll-interval':
                this._startPoll();
                break;
        }
    }

    _onProfilesChanged() {
        const change = this._connection.reload();
        this._menu.setProfiles(this._connection.profiles(), this._connection.profile.id);
        if (change === 'switched') {
            this._lifecycle.reset();
            this._updates.reset();
            this._slots = [];
            this._tunnelNotified = '';
            this._lifecycle.refresh();
        }
        this._recompute();
    }

    _onTunnelState(state, error) {
        // One notification per distinct ssh error, not one per retry.
        if (state === 'down' && error !== this._tunnelNotified) {
            this._tunnelNotified = error;
            this._notifier.notify(_('SSH tunnel to %s is down').replace('%s', this._connection.profile.name), error);
        }
        this._updateHeader();
        if (this._menu.isOpen)
            this._refreshSessions();
    }

    _onSlots(slots) {
        this._slots = slots;
        this._recompute();
        if (this._menu.isOpen)
            this._refreshSessions();
    }

    _onOnline(online) {
        this._lifecycle.onOnline(online);
        if (!online)
            this._slots = [];
        this._recompute();
        this._renderSessions([]);
        if (online)
            this._refreshSessions();
        this._lifecycle.refresh();
    }

    /**
     * A note from the gateway's notification bus. Only critical ones reach
     * the desktop, and a click opens the dashboard page the note links to.
     * A tool approval is critical too, but it already shows as amber on its
     * session, so it does not turn the ghost red.
     */
    _onNotification(note) {
        if (note.priority !== 'critical' || note.silenced)
            return;
        if (note.channel !== APPROVAL_CHANNEL) {
            this._criticalNotice = true;
            this._recompute();
        }
        const path = typeof note.url === 'string' && note.url.startsWith('/') ? note.url : '/';
        const profileId = this._connection.profile.id;
        this._notifier.notify(note.title || 'Kiro Crew', note.body || '', () => {
            this._openUrl(this._connection.pageUrl(path));
            this._ackNotification(note.ts, profileId);
        });
    }

    /**
     * Mark a clicked note read in the dashboard's bell too. Only on the
     * gateway that sent it, and not on a read-only remote one, which the
     * extension never changes.
     */
    _ackNotification(ts, profileId) {
        if (typeof ts !== 'string' || !ts || !this._connection.canControl ||
            this._connection.profile.id !== profileId)
            return;
        this._connection.client.ackNotification(ts)
            .catch(e => logUnlessCancelled(e, 'marking a notification read failed'));
    }

    _recompute() {
        const client = this._connection.client;
        const prev = this._state;
        const next = aggregateState({
            online: client.online,
            slots: this._slots,
            criticalNotice: this._criticalNotice,
            authError: client.authError,
            stopped: this._lifecycle.isStopped()
        });
        // Healthy slots again: the last critical notice no longer applies.
        if (next === STATE.IDLE || next === STATE.BUSY)
            this._criticalNotice = false;
        this._state = next;
        this._icon.gicon = this._gicon(ICON_NAME[next]);
        this._icon.style_class = STYLE_CLASS[next];
        this._icon.opacity = next === STATE.STOPPED ? STOPPED_OPACITY : 255;
        if (prev !== next)
            this._animator.transition(prev, next);
        this._updateHeader();
        this._updateControls();
        if (prev !== next && (prev === STATE.STOPPED || next === STATE.STOPPED) && this._menu.isOpen)
            this._refreshSessions();
    }

    _headerLabel() {
        if (this._state === STATE.STOPPED && this._lifecycle.starting)
            return _('Starting gateway…');
        if (this._state === STATE.STOPPED && this._lifecycle.stopping)
            return _('Stopping gateway…');
        if (this._state === STATE.OFFLINE && this._connection.tunnelDown)
            return _('SSH tunnel down — retrying');
        return stateLabel(this._state);
    }

    _updateHeader() {
        this._menu.setHeader(`Kiro Crew — ${this._headerLabel()}  (${this._connection.profile.name})`);
    }

    _updateControls() {
        const up = this._state !== STATE.STOPPED;
        const online = this._connection.client.online;
        const pending = this._lifecycle.pendingOp;
        this._menu.setGatewayUp(up);
        this._menu.setGatewayItem(this._lifecycle.menuAction());
        if (pending === 'restart') {
            this._menu.setRestartItem({visible: true, label: _('Restarting gateway…'), sensitive: false});
        } else {
            this._menu.setRestartItem({
                visible: this._connection.canControl && online && up && !pending,
                label: _('Restart gateway'),
                sensitive: true
            });
        }
        this._menu.setUpdateItem(this._updates.menuItem(up && online));
    }

    // ---- sessions --------------------------------------------------------

    _refreshSessions() {
        if (this._state === STATE.STOPPED) {
            this._renderSessions([]);
            return;
        }
        const preview = this._settings.get_boolean('show-previews');
        this._connection.client.fetchSessions(this._settings.get_int('max-sessions'), preview)
            .then(data => this._renderSessions(data?.sessions ?? []))
            .catch(e => logUnlessCancelled(e, 'fetching sessions failed'));
    }

    _renderSessions(sessions) {
        if (this._state === STATE.STOPPED) {
            const lines = [{text: this._headerLabel()}];
            if (!this._lifecycle.canStart() && !this._lifecycle.pendingOp)
                lines.push({text: _('Run “kirocrew gateway” to start it again'), hint: true});
            this._menu.showInfo(lines);
            return;
        }
        if (!this._connection.client.online) {
            const lines = [{text: _('Gateway offline')}];
            if (this._connection.tunnelDown) {
                lines[0].text = _('SSH tunnel down — retrying');
                if (this._connection.tunnelError)
                    lines.push({text: this._connection.tunnelError, hint: true});
            }
            this._menu.showInfo(lines);
            return;
        }
        // Active slots missing from the recent list are pinned on top, so the
        // ghost's color always matches a dot shown here.
        const rows = menuRows(sessions, this._slots);
        if (rows.length === 0) {
            this._menu.showInfo([{text: _('No recent sessions')}]);
            return;
        }
        this._menu.showSessions(rows, this._settings.get_boolean('show-previews'),
            key => this._openUrl(this._connection.sessionUrl(key)));
    }

    // ---- gateway actions -------------------------------------------------

    _onGatewayAction(action) {
        if (action === 'start') {
            this._lifecycle.start();
            return;
        }
        if (action !== 'stop')
            return;
        const n = this._busySessions();
        if (n === 0) {
            this._lifecycle.stop();
            return;
        }
        this._confirmation.ask({
            title: _('Stop the Kiro Crew gateway?'),
            description: ngettext(
                '%d session is still working. Stopping the gateway interrupts it.',
                '%d sessions are still working. Stopping the gateway interrupts them.',
                n).replace('%d', String(n)),
            actionLabel: _('Stop')
        }, () => this._lifecycle.stop());
    }

    _confirmRestart() {
        const n = this._busySessions();
        if (n === 0) {
            this._lifecycle.restart();
            return;
        }
        this._confirmation.ask({
            title: _('Restart the Kiro Crew gateway?'),
            description: ngettext(
                '%d session is still working. Restarting the gateway interrupts it.',
                '%d sessions are still working. Restarting the gateway interrupts them.',
                n).replace('%d', String(n)),
            actionLabel: _('Restart')
        }, () => this._lifecycle.restart());
    }

    _busySessions() {
        return this._connection.client.online ? activeSessionCount(this._slots) : 0;
    }

    // ---- links -----------------------------------------------------------

    _openTarget() {
        // Nothing to open while the gateway is stopped: the menu has Start.
        if (this._state === STATE.STOPPED) {
            this.button.menu.toggle();
            return;
        }
        const key = targetSlotKey(this._state, this._slots);
        this._openUrl(key ? this._connection.sessionUrl(key) : this._connection.pageUrl('/'));
    }

    _openUrl(url) {
        const browser = this._settings.get_string('browser');
        // The shell's app lookup, not Gio.DesktopAppInfo, which GLib 2.86
        // moved to GioUnix (it warns on every access there).
        const app = browser ? Shell.AppSystem.get_default().lookup_app(browser) : null;
        const context = global.create_app_launch_context(0, -1);
        try {
            if (app)
                app.get_app_info().launch_uris([url], context);
            else
                Gio.AppInfo.launch_default_for_uri(url, context);
        } catch (e) {
            logError(e, 'kiro-crew: failed to open URL');
        }
    }

    _gicon(name) {
        let icon = this._giconCache.get(name);
        if (!icon) {
            icon = Gio.icon_new_for_string(this._ext.dir.get_child('icons').get_child(`${name}.svg`).get_path());
            this._giconCache.set(name, icon);
        }
        return icon;
    }

    // ---- fallback poll ---------------------------------------------------

    _startPoll() {
        this._stopPoll();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(1, this._settings.get_int('poll-interval')), () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    /**
     * While the socket is down: notice a service started or stopped outside
     * the menu, and pick up a gateway that came back (also one started by
     * hand while the socket was held closed).
     */
    _poll() {
        const client = this._connection.client;
        if (client.online)
            return;
        if (this._connection.canControl)
            this._lifecycle.refresh();
        if (this._lifecycle.pendingOp)
            return;
        client.fetchStatus().then(status => {
            if (!status || this._lifecycle.pendingOp)
                return;
            if (client.paused)
                client.resume();
            else
                client.reconnectNow();
        }).catch(e => logUnlessCancelled(e, 'status poll failed'));
    }

    destroy() {
        this._stopPoll();
        this._settings.disconnect(this._settingsChangedId);
        this.button.disconnect(this._buttonPressId);
        this._confirmation.destroy();
        this._lifecycle.destroy();
        this._connection.destroy();
        this._notifier.destroy();
        this._menu.destroy();
        this._animator.destroy();
        this.button.destroy();
        this.button = null;
        this._giconCache.clear();
    }
}
