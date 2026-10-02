/* extension.js — Kiro Crew top-bar indicator. */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {GatewayClient} from './lib/client.js';
import {
    STATE, ICON_NAME, STYLE_CLASS, aggregateState, slotState, targetSlotKey, slotName
} from './lib/state.js';

// gettext() may only be called from within the extension lifecycle, never at
// module-evaluation time. Resolve labels lazily so _() runs at render time.
function stateLabel(state) {
    switch (state) {
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

const Indicator = class {
    constructor(extension) {
        this._ext = extension;
        this._settings = extension.getSettings();
        this._slots = [];
        this._state = STATE.OFFLINE;
        this._criticalNotice = false;
        this._pollId = 0;
        this._notifSource = null;
        this._notifSourceDestroyId = 0;
        this._mintingToken = false;
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

        // Left-click opens the relevant target directly, without the menu
        // flashing. We intercept the press and route it ourselves.
        this._buttonPressId = this.button.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._openTarget();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;  // secondary → menu
        });

        this._buildMenu();

        this._client = new GatewayClient(() => ({
            endpoint: this._settings.get_string('endpoint'),
            token: this._settings.get_string('token')
        }));
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
            if (key === 'endpoint' || key === 'token')
                this._client.reconnectNow();
            if (key === 'max-sessions' || key === 'show-previews')
                this._refreshSessions();
            if (key === 'poll-interval')
                this._startPoll();
        });

        this._startPoll();
        this._refreshSessions();

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

        const open = new PopupMenu.PopupMenuItem(_('Open dashboard'));
        open.connect('activate', () => this._openUrl(this._dashboardUrl()));
        menu.addMenuItem(open);

        this._endpointSub = new PopupMenu.PopupSubMenuMenuItem(_('Endpoint'));
        menu.addMenuItem(this._endpointSub);
        this._rebuildEndpointSubmenu();

        const reconnect = new PopupMenu.PopupMenuItem(_('Reconnect'));
        reconnect.connect('activate', () => this._client.reconnectNow());
        menu.addMenuItem(reconnect);

        const settings = new PopupMenu.PopupMenuItem(_('Settings'));
        settings.connect('activate', () => {
            const p = this._ext.openPreferences();
            if (p && typeof p.catch === 'function')
                p.catch(e => logError(e, 'kiro-crew: openPreferences failed'));
        });
        menu.addMenuItem(settings);

        this._menuOpenStateId = this.button.menu.connect('open-state-changed', (_m, isOpen) => {
            if (isOpen)
                this._refreshSessions();
        });

        this._updateHeader();
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

    _updateHeader() {
        const label = stateLabel(this._state);
        const ep = this._settings.get_string('endpoint')
            .replace(/^https?:\/\//, '');
        this._header.label.text = `Kiro Crew — ${label}  (${ep})`;
    }

    _refreshSessions() {
        const max = this._settings.get_int('max-sessions');
        const wantPreview = this._settings.get_boolean('show-previews');
        this._client.fetchSessions(max, wantPreview).then(data => {
            if (this._destroyed)
                return;
            this._renderSessions(data?.sessions ?? [], wantPreview);
        });
    }

    _renderSessions(sessions, wantPreview) {
        this._sessionSection.removeAll();
        if (!this._client.online) {
            const item = new PopupMenu.PopupMenuItem(_('Gateway offline'), {
                reactive: false
            });
            this._sessionSection.addMenuItem(item);
            return;
        }
        if (sessions.length === 0) {
            const item = new PopupMenu.PopupMenuItem(_('No recent sessions'), {
                reactive: false
            });
            this._sessionSection.addMenuItem(item);
            return;
        }
        // /api/sessions keys carry a surface prefix ("dashboard_chat-8-…"),
        // while live ws slot keys are the bare id ("chat-8-…"). Normalize both
        // through slotName() so the status dot matches the live slot.
        const liveByKey = new Map(this._slots.map(s => [slotName(s.key), s]));
        for (const sess of sessions) {
            const title = sess.title || sess.key || _('(untitled)');
            const item = new PopupMenu.PopupMenuItem(title);

            const live = liveByKey.get(slotName(sess.key));
            const st = live ? slotState(live) : STATE.IDLE;
            const dot = new St.Icon({
                icon_name: 'media-record-symbolic',
                style_class: DOT_CLASS[st] ?? DOT_CLASS.idle,
                icon_size: 10,
                x_align: Clutter.ActorAlign.END,
                x_expand: true
            });
            item.add_child(dot);

            if (wantPreview && sess.preview) {
                item.label.clutter_text.set_line_wrap(false);
                item.label.text = `${title}`;
            }
            item.connect('activate', () => this._openUrl(this._sessionUrl(sess.key)));
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
        this._recompute();
        this._renderSessions([], this._settings.get_boolean('show-previews'));
        if (ok)
            this._refreshSessions();
    }

    _onNotification(n) {
        const priority = String(n.priority ?? '').toLowerCase();
        if (priority === 'critical') {
            this._criticalNotice = true;
            this._recompute();
            this._notify(n.title || 'Kiro Crew', n.body || '');
        }
    }

    _recompute() {
        const next = aggregateState({
            online: this._client.online,
            slots: this._slots,
            criticalNotice: this._criticalNotice,
            authError: this._client.authError
        });
        // A busy/idle recompute clears a stale critical flag once the gateway
        // reports healthy slots again.
        if (next === STATE.IDLE || next === STATE.BUSY)
            this._criticalNotice = false;
        this._state = next;
        this._icon.gicon = this._gicon(ICON_NAME[next]);
        this._icon.style_class = STYLE_CLASS[next];
        this._updateHeader();
    }

    // ---- opening links ---------------------------------------------------

    _dashboardUrl() {
        const base = this._settings.get_string('endpoint').replace(/\/+$/, '');
        const token = this._settings.get_string('token');
        return token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
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
        const key = targetSlotKey(this._state, this._slots);
        this._openUrl(key ? this._sessionUrl(key) : this._dashboardUrl());
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
                // Only poll as a liveness fallback when the WS is down.
                if (!this._client.online) {
                    this._client.fetchStatus().then(s => {
                        if (s && !this._destroyed)
                            this._client.reconnectNow();
                    });
                }
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

        this._destroyNotifSource();

        // These are children of the button/menu and would go down with it,
        // but destroy them explicitly so ownership is unambiguous.
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
