/* extension.js — Kiro Crew top-bar indicator. */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';

import {GatewayClient} from './lib/client.js';
import {GatewayService, isAuthDenied} from './lib/service.js';
import {IconAnimator} from './lib/animator.js';
import {
    STATE, ICON_NAME, STYLE_CLASS, aggregateState, targetSlotKey,
    slotName, activeSessionCount, isLoopbackEndpoint, menuRows
} from './lib/state.js';

// gettext() may only be called from within the extension lifecycle, never at
// module-evaluation time. Resolve labels lazily so _() runs at render time.
function stateLabel(state) {
    switch (state) {
        case 'stopped': return _('Gateway stopped');
        case 'offline': return _('Gateway offline');
        case 'auth': return _('Token expired — update in Settings');
        case 'error': return _('Problem — attention needed');
        case 'attention': return _('Waiting for you');
        case 'busy': return _('Working…');
        case 'idle': return _('Idle');
        default: return state;
    }
}

// GNOME 46+ MessageTray API (property-object constructors, addNotification).
const HAS_MODERN_MESSAGE_TRAY =
    typeof MessageTray.Source.prototype.addNotification === 'function';

const DOT_CLASS = {
    error: 'kiro-crew-dot kiro-crew-error',
    attention: 'kiro-crew-dot kiro-crew-attention',
    busy: 'kiro-crew-dot kiro-crew-busy',
    idle: 'kiro-crew-dot kiro-crew-idle',
    offline: 'kiro-crew-dot kiro-crew-error'
};

// Opacity of the panel icon while the gateway is stopped (0-255).
const STOPPED_OPACITY = 115;
// Fast re-check cadence while a Stop/Start settles, and how long to wait.
const WATCH_INTERVAL_S = 1;
const STOP_WATCH_S = 30;
const START_WATCH_S = 60;

const Indicator = class {
    constructor(extension) {
        this._ext = extension;
        this._settings = extension.getSettings();
        this._slots = [];
        this._state = STATE.OFFLINE;
        this._criticalNotice = false;
        this._pollId = 0;
        this._watchId = 0;
        this._notifSource = null;
        this._notifSourceDestroyId = 0;
        this._mintingToken = false;
        // Gateway lifecycle. _svcActive is the systemd ActiveState of
        // kirocrew.service (null = unknown / not installed / remote endpoint).
        // _pendingOp is a Stop/Start the user asked for that hasn't settled.
        // _manualStopped marks a hand-run gateway we shut down via the API.
        this._svcActive = null;
        this._pendingOp = null;
        this._manualStopped = false;
        this._dialog = null;
        this._dialogDestroyId = 0;
        // Set in destroy(); async continuations check it so nothing touches
        // destroyed actors or nulled settings after disable().
        this._destroyed = false;
        this._giconCache = new Map();

        this.button = new PanelMenu.Button(0.0, 'Kiro Crew', false);

        this._icon = new St.Icon({
            gicon: this._gicon(ICON_NAME.offline),
            style_class: STYLE_CLASS.offline
        });
        this.button.add_child(this._icon);
        this._animator = new IconAnimator(this._icon);

        // Left-click opens the relevant target directly, without the menu
        // flashing. We intercept the press and route it ourselves.
        this._buttonPressId = this.button.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._openTarget();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;  // secondary → menu
        });

        this._service = new GatewayService();
        this._client = new GatewayClient(() => ({
            endpoint: this._settings.get_string('endpoint'),
            token: this._settings.get_string('token')
        }));

        this._buildMenu();

        this._client.start({
            onSlots: slots => this._onSlots(slots),
            onNotification: n => this._onNotification(n),
            onOnline: ok => this._onOnline(ok),
            onAuthError: bad => {
                this._recompute();
                if (bad)
                    this._tryLocalToken();
            }
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'endpoint') {
                // A different gateway: forget the old one's lifecycle state.
                this._cancelWatch();
                this._pendingOp = null;
                this._manualStopped = false;
                this._svcActive = null;
                if (this._client.paused)
                    this._client.resume();
                else
                    this._client.reconnectNow();
                this._refreshService();
            } else if (key === 'token') {
                this._client.reconnectNow();
            }
            if (key === 'max-sessions' || key === 'show-previews')
                this._refreshSessions();
            if (key === 'poll-interval')
                this._startPoll();
        });

        this._startPoll();
        this._refreshSessions();
        this._refreshService();

        // If no token is configured yet, try the local bootstrap once so a
        // fresh install lights up without a manual paste.
        if (!this._settings.get_string('token').trim())
            this._tryLocalToken();
    }

    /**
     * Try to auto-mint a token via the gateway's loopback-only local bootstrap
     * and store it. Guarded so overlapping auth errors don't stampede the
     * endpoint. A failure is silent — the user can still paste a token by hand.
     */
    _tryLocalToken() {
        if (this._mintingToken)
            return;
        this._mintingToken = true;
        this._client.fetchLocalToken()
            .then(token => {
                if (this._destroyed)
                    return;
                if (token && token !== this._settings.get_string('token')) {
                    // Writing the setting triggers the 'changed' handler, which
                    // reconnects the client with the new token.
                    this._settings.set_string('token', token);
                }
            })
            .catch(e => logError(e, 'kiro-crew: local token fetch failed'))
            .finally(() => {
                this._mintingToken = false;
            });
    }

    _gicon(name) {
        let icon = this._giconCache.get(name);
        if (!icon) {
            const path = this._ext.dir.get_child('icons').get_child(`${name}.svg`);
            icon = Gio.icon_new_for_string(path.get_path());
            this._giconCache.set(name, icon);
        }
        return icon;
    }

    // ---- menu ------------------------------------------------------------

    _buildMenu() {
        const menu = this.button.menu;

        this._header = new PopupMenu.PopupMenuItem('', {
            reactive: false, style_class: 'kiro-crew-header'
        });
        menu.addMenuItem(this._header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sessionSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._sessionSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openItem = new PopupMenu.PopupMenuItem(_('Open dashboard'));
        this._openItem.connect('activate', () => this._openUrl(this._pageUrl('/')));
        menu.addMenuItem(this._openItem);

        this._logsItem = new PopupMenu.PopupMenuItem(_('Gateway logs'));
        this._logsItem.connect('activate', () => this._openUrl(this._pageUrl('/logs')));
        menu.addMenuItem(this._logsItem);

        this._endpointSub = new PopupMenu.PopupSubMenuMenuItem(_('Endpoint'));
        menu.addMenuItem(this._endpointSub);
        this._rebuildEndpointSubmenu();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Stop/Start the local gateway. Label, action and visibility follow
        // the service state — see _updateControls().
        this._gatewayAction = null;
        this._gatewayItem = new PopupMenu.PopupMenuItem('');
        this._gatewayItem.connect('activate', () => {
            if (this._gatewayAction === 'stop')
                this._confirmStop();
            else if (this._gatewayAction === 'start')
                this._startGateway();
        });
        menu.addMenuItem(this._gatewayItem);

        this._reconnectItem = new PopupMenu.PopupMenuItem(_('Reconnect'));
        this._reconnectItem.connect('activate', () => this._client.reconnectNow());
        menu.addMenuItem(this._reconnectItem);

        const settings = new PopupMenu.PopupMenuItem(_('Settings'));
        settings.connect('activate', () => {
            const p = this._ext.openPreferences();
            if (p && typeof p.catch === 'function')
                p.catch(e => logError(e, 'kiro-crew: openPreferences failed'));
        });
        menu.addMenuItem(settings);

        this._menuOpenStateId = this.button.menu.connect('open-state-changed', (_m, isOpen) => {
            if (isOpen) {
                this._refreshSessions();
                this._refreshService();
            }
        });

        this._updateHeader();
        this._updateControls();
    }

    _rebuildEndpointSubmenu() {
        this._endpointSub.menu.removeAll();
        const current = this._settings.get_string('endpoint');
        const list = this._settings.get_strv('endpoints');
        if (!list.includes(current) && current)
            list.unshift(current);
        for (const ep of list) {
            const item = new PopupMenu.PopupMenuItem(ep);
            if (ep === current)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            item.connect('activate', () => {
                this._settings.set_string('endpoint', ep);
                this._rebuildEndpointSubmenu();
            });
            this._endpointSub.menu.addMenuItem(item);
        }
    }

    _headerLabel() {
        if (this._state === STATE.STOPPED) {
            if (this._pendingOp === 'start' || this._svcActive === 'activating')
                return _('Starting gateway…');
            if (this._pendingOp === 'stop' || this._svcActive === 'deactivating')
                return _('Stopping gateway…');
        }
        return stateLabel(this._state);
    }

    _updateHeader() {
        const ep = this._settings.get_string('endpoint')
            .replace(/^https?:\/\//, '');
        this._header.label.text = `Kiro Crew — ${this._headerLabel()}  (${ep})`;
    }

    /** Sync the Stop/Start item and the items that need a live gateway. */
    _updateControls() {
        if (!this._gatewayItem)
            return;
        const stopped = this._state === STATE.STOPPED;
        this._openItem.setSensitive(!stopped);
        this._logsItem.setSensitive(!stopped);
        this._reconnectItem.visible = !stopped;

        let label = null;
        let action = null;
        const mode = this._controlMode();
        if (this._pendingOp === 'stop') {
            label = _('Stopping gateway…');
        } else if (this._pendingOp === 'start') {
            label = _('Starting gateway…');
        } else if (mode === 'service') {
            switch (this._svcActive) {
                case 'inactive':
                case 'failed':
                    label = _('Start gateway');
                    action = 'start';
                    break;
                case 'deactivating':
                    label = _('Stopping gateway…');
                    break;
                case 'active':
                case 'activating':
                case 'reloading':
                    // Stop also works mid auto-restart: it breaks a crash loop.
                    label = _('Stop gateway');
                    action = 'stop';
                    break;
                default:
                    break;  // unknown → hidden
            }
        } else if (mode === 'api' && this._client.online) {
            // Hand-run gateway: stop via its local API.
            label = _('Stop gateway');
            action = 'stop';
        }
        this._gatewayAction = action;
        this._gatewayItem.visible = label !== null;
        if (label !== null) {
            this._gatewayItem.label.text = label;
            this._gatewayItem.setSensitive(action !== null);
        }
    }

    _refreshSessions() {
        if (this._state === STATE.STOPPED) {
            this._renderSessions([], false);
            return;
        }
        const max = this._settings.get_int('max-sessions');
        const wantPreview = this._settings.get_boolean('show-previews');
        this._client.fetchSessions(max, wantPreview).then(data => {
            if (this._destroyed)
                return;
            this._renderSessions(data?.sessions ?? [], wantPreview);
        });
    }

    _addInfoItem(text, styleClass = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this._sessionSection.addMenuItem(item);
    }

    _renderSessions(sessions, wantPreview) {
        this._sessionSection.removeAll();
        if (this._state === STATE.STOPPED) {
            this._addInfoItem(this._headerLabel());
            if (this._controlMode() !== 'service' && !this._pendingOp) {
                // Nothing we can start: tell the user how.
                this._addInfoItem(_('Run “kirocrew gateway” to start it again'),
                    'kiro-crew-hint');
            }
            return;
        }
        if (!this._client.online) {
            this._addInfoItem(_('Gateway offline'));
            return;
        }
        // Same per-slot rule as the ghost (slotState), and any active slot
        // outside the recent list is pinned on top, so the ghost's color is
        // always the worst dot shown here. Keys are normalized via slotName().
        const rows = menuRows(sessions, this._slots);
        if (rows.length === 0) {
            this._addInfoItem(_('No recent sessions'));
            return;
        }
        for (const row of rows) {
            const item = new PopupMenu.PopupMenuItem(row.title || _('(untitled)'));
            const dot = new St.Icon({
                icon_name: 'media-record-symbolic',
                style_class: DOT_CLASS[row.state] ?? DOT_CLASS.idle,
                icon_size: 10,
                x_align: Clutter.ActorAlign.END,
                x_expand: true
            });
            item.add_child(dot);
            if (wantPreview)
                item.label.clutter_text.set_line_wrap(false);
            item.connect('activate', () => this._openUrl(this._sessionUrl(row.key)));
            this._sessionSection.addMenuItem(item);
        }
    }

    // ---- live state ------------------------------------------------------

    _onSlots(slots) {
        this._slots = slots;
        this._recompute();
        if (this.button.menu.isOpen)
            this._refreshSessions();
    }

    _onOnline(ok) {
        if (ok) {
            // The gateway is back: whatever was stopped is running again.
            this._manualStopped = false;
            if (this._pendingOp === 'start')
                this._finishOp();
        } else {
            this._slots = [];
        }
        this._recompute();
        this._renderSessions([], this._settings.get_boolean('show-previews'));
        if (ok)
            this._refreshSessions();
        this._refreshService();
    }

    _onNotification(n) {
        const priority = String(n.priority ?? '').toLowerCase();
        if (priority === 'critical') {
            this._criticalNotice = true;
            this._recompute();
            this._notify(n.title || 'Kiro Crew', n.body || '');
        }
    }

    _isLocal() {
        return isLoopbackEndpoint(this._settings.get_string('endpoint'));
    }

    /**
     * How the local gateway is controlled:
     *   'service' — through systemd (kirocrew.service is installed and is
     *               what runs, or would run, the gateway);
     *   'api'     — a hand-run `kirocrew gateway` (no unit, or the unit is
     *               down while a gateway still answers): POST /api/shutdown;
     *   null      — remote endpoint, or nothing known to control.
     */
    _controlMode() {
        if (!this._isLocal())
            return null;
        const unitDown = this._svcActive === 'inactive' || this._svcActive === 'failed';
        if (this._service.scope && !(unitDown && this._client.online))
            return 'service';
        if (this._client.online || this._manualStopped)
            return 'api';
        return null;
    }

    /** Was the gateway stopped on purpose (or is a Stop/Start settling)? */
    _isStopped() {
        if (!this._isLocal())
            return false;
        if (this._pendingOp)
            return true;
        if (this._controlMode() === 'service')
            return this._svcActive === 'inactive' || this._svcActive === 'deactivating';
        return this._manualStopped && !this._client.online;
    }

    _recompute() {
        const prev = this._state;
        const next = aggregateState({
            online: this._client.online,
            slots: this._slots,
            criticalNotice: this._criticalNotice,
            authError: this._client.authError,
            stopped: this._isStopped()
        });
        // A busy/idle recompute clears a stale critical flag once the gateway
        // reports healthy slots again.
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
        if (prev !== next && (prev === STATE.STOPPED || next === STATE.STOPPED) &&
            this.button.menu.isOpen)
            this._refreshSessions();
    }

    // ---- gateway lifecycle -------------------------------------------------

    /**
     * Re-read the service's ActiveState and hold the live connection closed
     * while it is down on purpose (no reconnect spin against a dead port).
     */
    async _refreshService() {
        if (this._destroyed)
            return;
        if (!this._isLocal()) {
            this._svcActive = null;
            this._recompute();
            return;
        }
        let active = null;
        try {
            active = await this._service.activeState();
        } catch (e) {
            logError(e, 'kiro-crew: reading gateway service state failed');
        }
        if (this._destroyed)
            return;
        this._svcActive = active;
        if (this._controlMode() === 'service') {
            const down = active === 'inactive' || active === 'deactivating';
            if (down && this._pendingOp !== 'start')
                this._client.pause();
            else if (!down && active !== 'failed' && this._client.paused &&
                     this._pendingOp !== 'stop')
                this._client.resume();  // started elsewhere (e.g. systemctl)
        }
        this._recompute();
    }

    _confirmStop() {
        const n = this._client.online ? activeSessionCount(this._slots) : 0;
        if (n === 0) {
            this._stopGateway();
            return;
        }
        this._closeDialog();
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        const description = ngettext(
            '%d session is still working. Stopping the gateway interrupts it.',
            '%d sessions are still working. Stopping the gateway interrupts them.',
            n).replace('%d', String(n));
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Stop the Kiro Crew gateway?'),
            description
        }));
        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
                default: true
            },
            {
                label: _('Stop'),
                action: () => {
                    dialog.close();
                    this._stopGateway();
                }
            }
        ]);
        this._dialog = dialog;
        this._dialogDestroyId = dialog.connect('destroy', () => {
            this._dialogDestroyId = 0;
            this._dialog = null;
        });
        dialog.open();
    }

    _closeDialog() {
        if (!this._dialog)
            return;
        if (this._dialogDestroyId) {
            this._dialog.disconnect(this._dialogDestroyId);
            this._dialogDestroyId = 0;
        }
        this._dialog.destroy();
        this._dialog = null;
    }

    async _stopGateway() {
        if (this._pendingOp)
            return;
        this._pendingOp = 'stop';
        this._recompute();
        const viaService = this._controlMode() === 'service';
        try {
            if (viaService) {
                await this._service.stop();
            } else if (await this._client.shutdownLocal()) {
                this._manualStopped = true;
            } else {
                throw new Error(_('The gateway did not accept the shutdown request.'));
            }
        } catch (e) {
            if (this._destroyed)
                return;
            this._pendingOp = null;
            this._recompute();
            if (!isAuthDenied(e)) {
                logError(e, 'kiro-crew: stopping the gateway failed');
                this._notify(_('Could not stop the gateway'), e.message ?? String(e));
            }
            return;
        }
        if (this._destroyed)
            return;
        this._client.pause();
        this._watch(STOP_WATCH_S, () => (viaService
            ? this._svcActive === 'inactive' || this._svcActive === 'failed'
            : true));
    }

    async _startGateway() {
        if (this._pendingOp)
            return;
        this._pendingOp = 'start';
        this._recompute();
        try {
            await this._service.start();
        } catch (e) {
            if (this._destroyed)
                return;
            this._pendingOp = null;
            this._recompute();
            if (!isAuthDenied(e)) {
                logError(e, 'kiro-crew: starting the gateway failed');
                this._notify(_('Could not start the gateway'), e.message ?? String(e));
            }
            return;
        }
        if (this._destroyed)
            return;
        this._client.resume();
        // Finished by _onOnline() once the socket connects; the watch is the
        // timeout — after it a gateway that never came up shows red.
        this._watch(START_WATCH_S, () => this._client.online);
    }

    /**
     * Re-check the service every second until done() holds or the timeout
     * passes, then settle the pending op.
     */
    _watch(timeoutS, done) {
        this._cancelWatch();
        let ticks = 0;
        this._watchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCH_INTERVAL_S, () => {
            ticks += WATCH_INTERVAL_S;
            this._refreshService().then(() => {
                if (this._destroyed || !this._watchId)
                    return;
                if (done() || ticks >= timeoutS)
                    this._finishOp();
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
        this._recompute();
    }

    // ---- opening links ---------------------------------------------------

    /** Dashboard page URL with the token, e.g. _pageUrl('/logs'). */
    _pageUrl(path) {
        const base = this._settings.get_string('endpoint').replace(/\/+$/, '');
        const token = this._settings.get_string('token');
        // The SPA reads ?token= on any route and keeps the path.
        return token ? `${base}${path}?token=${encodeURIComponent(token)}` : `${base}${path}`;
    }

    _sessionUrl(key) {
        const base = this._settings.get_string('endpoint').replace(/\/+$/, '');
        const token = this._settings.get_string('token');
        // The dashboard SPA opens a conversation via /chat?sid=<slot id>
        // (it reads the "sid" query param on load). The slot id is the stored
        // session key with its surface prefix stripped — see slotName().
        const sid = slotName(key);
        const parts = [`sid=${encodeURIComponent(sid)}`];
        if (token)
            parts.push(`token=${encodeURIComponent(token)}`);
        return `${base}/chat?${parts.join('&')}`;
    }

    _openTarget() {
        // Nothing to open while the gateway is down on purpose: show the
        // menu, where "Start gateway" lives.
        if (this._state === STATE.STOPPED) {
            this.button.menu.toggle();
            return;
        }
        const key = targetSlotKey(this._state, this._slots);
        this._openUrl(key ? this._sessionUrl(key) : this._pageUrl('/'));
    }

    _openUrl(url) {
        const browser = this._settings.get_string('browser');
        try {
            if (browser) {
                const app = Gio.DesktopAppInfo.new(browser);
                if (app) {
                    app.launch_uris([url], null);
                    return;
                }
            }
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError(e, 'kiro-crew: failed to open URL');
        }
    }

    // ---- misc ------------------------------------------------------------

    /** (Re)start the liveness poll; safe to call when the interval changes. */
    _startPoll() {
        this._stopPoll();
        const interval = Math.max(1, this._settings.get_int('poll-interval'));
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                if (this._client.online)
                    return GLib.SOURCE_CONTINUE;
                // Down: notice a service started/stopped outside the menu.
                if (this._isLocal())
                    this._refreshService();
                // A Stop/Start in flight owns the connection until it settles.
                if (this._pendingOp)
                    return GLib.SOURCE_CONTINUE;
                // Liveness fallback while the WS is down. Also probes while
                // paused, so a gateway started by hand is picked up.
                this._client.fetchStatus().then(s => {
                    if (!s || this._destroyed || this._pendingOp)
                        return;
                    if (this._client.paused) {
                        this._manualStopped = false;
                        this._client.resume();
                    } else {
                        this._client.reconnectNow();
                    }
                });
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _ensureNotifSource() {
        if (this._notifSource)
            return this._notifSource;
        // GNOME 46 switched Source/Notification to property objects and
        // replaced showNotification() with addNotification(); 45 is positional.
        const source = HAS_MODERN_MESSAGE_TRAY
            ? new MessageTray.Source({title: 'Kiro Crew', iconName: ICON_NAME.error})
            : new MessageTray.Source('Kiro Crew', ICON_NAME.error);
        // The tray destroys the source once its last notification is
        // dismissed; drop our reference so the next notice makes a fresh one.
        this._notifSourceDestroyId = source.connect('destroy', () => {
            this._notifSourceDestroyId = 0;
            this._notifSource = null;
        });
        Main.messageTray.add(source);
        this._notifSource = source;
        return source;
    }

    _notify(title, body) {
        const source = this._ensureNotifSource();
        if (HAS_MODERN_MESSAGE_TRAY) {
            source.addNotification(new MessageTray.Notification({source, title, body}));
        } else {
            source.showNotification(new MessageTray.Notification(source, title, body));
        }
    }

    _destroyNotifSource() {
        if (!this._notifSource)
            return;
        if (this._notifSourceDestroyId) {
            this._notifSource.disconnect(this._notifSourceDestroyId);
            this._notifSourceDestroyId = 0;
        }
        this._notifSource.destroy();
        this._notifSource = null;
    }

    destroy() {
        this._destroyed = true;
        this._stopPoll();
        this._cancelWatch();
        this._closeDialog();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._buttonPressId) {
            this.button.disconnect(this._buttonPressId);
            this._buttonPressId = 0;
        }
        if (this._menuOpenStateId) {
            this.button.menu.disconnect(this._menuOpenStateId);
            this._menuOpenStateId = 0;
        }

        this._client?.destroy();
        this._client = null;
        this._service?.destroy();
        this._service = null;

        this._destroyNotifSource();

        this._animator?.destroy();
        this._animator = null;

        // These are children of the button/menu and would go down with it,
        // but destroy them explicitly so ownership is unambiguous.
        this._gatewayItem?.destroy();
        this._gatewayItem = null;
        this._reconnectItem?.destroy();
        this._reconnectItem = null;
        this._logsItem?.destroy();
        this._logsItem = null;
        this._openItem?.destroy();
        this._openItem = null;
        this._endpointSub?.destroy();
        this._endpointSub = null;
        this._sessionSection?.destroy();
        this._sessionSection = null;
        this._header?.destroy();
        this._header = null;
        this._icon?.destroy();
        this._icon = null;

        this.button?.destroy();
        this.button = null;

        this._giconCache.clear();
        this._slots = [];
        this._settings = null;
        this._ext = null;
    }
};

export default class KiroCrewExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator.button);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
