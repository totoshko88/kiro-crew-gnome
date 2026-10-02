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
    STATE, ICON_NAME, STYLE_CLASS, aggregateState, slotState, targetSlotKey, slotName,
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

const DOT_CLASS = {
    error: 'kiro-crew-dot kiro-crew-error',
    attention: 'kiro-crew-dot kiro-crew-attention',
    busy: 'kiro-crew-dot kiro-crew-busy',
    idle: 'kiro-crew-dot kiro-crew-idle',
    offline: 'kiro-crew-dot kiro-crew-error',
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

        this.button = new PanelMenu.Button(0.0, 'Kiro Crew', false);

        this._icon = new St.Icon({
            gicon: this._gicon(ICON_NAME.offline),
            style_class: STYLE_CLASS.offline,
        });
        this.button.add_child(this._icon);

        // Left-click opens the relevant target directly, without the menu
        // flashing. We intercept the press and route it ourselves.
        this.button.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                this._openTarget();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;  // secondary → menu
        });

        this._buildMenu();

        this._client = new GatewayClient(() => ({
            endpoint: this._settings.get_string('endpoint'),
            token: this._settings.get_string('token'),
        }));
        this._client.connect({
            onSlots: (slots) => this._onSlots(slots),
            onNotification: (n) => this._onNotification(n),
            onOnline: (ok) => this._onOnline(ok),
            onAuthError: (bad) => {
                this._recompute();
                if (bad)
                    this._tryLocalToken();
            },
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'endpoint' || key === 'token')
                this._client.reconnectNow();
            if (key === 'max-sessions' || key === 'show-previews')
                this._refreshSessions();
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
            .then((token) => {
                if (token && token !== this._settings.get_string('token')) {
                    // Writing the setting triggers the 'changed' handler, which
                    // reconnects the client with the new token.
                    this._settings.set_string('token', token);
                }
            })
            .catch((e) => logError(e, 'kiro-crew: local token fetch failed'))
            .finally(() => {
                this._mintingToken = false;
            });
    }

    _gicon(name) {
        const path = this._ext.dir.get_child('icons').get_child(`${name}.svg`);
        return Gio.icon_new_for_string(path.get_path());
    }

    // ---- menu ------------------------------------------------------------

    _buildMenu() {
        const menu = this.button.menu;

        this._header = new PopupMenu.PopupMenuItem('', {
            reactive: false, style_class: 'kiro-crew-header',
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
                p.catch((e) => logError(e, 'kiro-crew: openPreferences failed'));
        });
        menu.addMenuItem(settings);

        this.button.menu.connect('open-state-changed', (_m, isOpen) => {
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
        this._client.fetchSessions(max, wantPreview).then((data) => {
            this._renderSessions(data?.sessions ?? [], wantPreview);
        });
    }

    _renderSessions(sessions, wantPreview) {
        this._sessionSection.removeAll();
        if (!this._client.online) {
            const item = new PopupMenu.PopupMenuItem(_('Gateway offline'), {
                reactive: false,
            });
            this._sessionSection.addMenuItem(item);
            return;
        }
        if (sessions.length === 0) {
            const item = new PopupMenu.PopupMenuItem(_('No recent sessions'), {
                reactive: false,
            });
            this._sessionSection.addMenuItem(item);
            return;
        }
        // /api/sessions keys carry a surface prefix ("dashboard_chat-8-…"),
        // while live ws slot keys are the bare id ("chat-8-…"). Normalize both
        // through slotName() so the status dot matches the live slot.
        const liveByKey = new Map(this._slots.map((s) => [slotName(s.key), s]));
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
                x_expand: true,
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
            authError: this._client.authError,
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

    _startPoll() {
        const interval = this._settings.get_int('poll-interval');
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                // Only poll as a liveness fallback when the WS is down.
                if (!this._client.online) {
                    this._client.fetchStatus().then((s) => {
                        if (s)
                            this._client.reconnectNow();
                    });
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _notify(title, body) {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Kiro Crew',
                iconName: ICON_NAME.error,
            });
            Main.messageTray.add(this._notifSource);
        }
        const n = new MessageTray.Notification({
            source: this._notifSource,
            title,
            body,
        });
        this._notifSource.addNotification(n);
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._client?.destroy();
        this._client = null;
        this._notifSource?.destroy();
        this._notifSource = null;
        this.button?.destroy();
        this.button = null;
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
