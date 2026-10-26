/* menu.js — the indicator's popup menu. Holds no state; the indicator fills it. */

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DOT_CLASS = {
    error: 'kiro-crew-dot kiro-crew-error',
    attention: 'kiro-crew-dot kiro-crew-attention',
    busy: 'kiro-crew-dot kiro-crew-busy',
    idle: 'kiro-crew-dot kiro-crew-idle'
};

// Why a session waits on you, beside its dot (see slotHint() in lib/state.js).
const HINT_TEXT = {
    'mcp-auth': () => _('MCP sign-in needed')
};

function addItem(menu, label, onActivate) {
    const item = new PopupMenu.PopupMenuItem(label);
    item.connect('activate', onActivate);
    menu.addMenuItem(item);
    return item;
}

export class IndicatorMenu {
    /**
     * @param {PopupMenu.PopupMenu} menu the panel button's menu
     * @param {object} actions openDashboard, openLogs, selectProfile(id),
     *   gatewayAction(action), restart, reconnect, update, settings,
     *   openSession(key), opened
     */
    constructor(menu, actions) {
        this._menu = menu;
        this._gatewayAction = null;

        this._header = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'kiro-crew-header'});
        menu.addMenuItem(this._header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sessions = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._sessions);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openItem = addItem(menu, _('Open dashboard'), () => actions.openDashboard());
        this._logsItem = addItem(menu, _('Gateway logs'), () => actions.openLogs());
        this._profiles = new PopupMenu.PopupSubMenuMenuItem(_('Profile'));
        menu.addMenuItem(this._profiles);
        this._selectProfile = id => actions.selectProfile(id);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._gatewayItem = addItem(menu, '', () => actions.gatewayAction(this._gatewayAction));
        this._restartItem = addItem(menu, '', () => actions.restart());
        this._reconnectItem = addItem(menu, _('Reconnect'), () => actions.reconnect());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._updateItem = addItem(menu, '', () => actions.update());
        addItem(menu, _('Settings'), () => actions.settings());

        this._openStateId = menu.connect('open-state-changed', (_m, open) => {
            if (open)
                actions.opened();
        });
    }

    get isOpen() {
        return this._menu.isOpen;
    }

    setHeader(text) {
        this._header.label.text = text;
    }

    setProfiles(profiles, activeId) {
        this._profiles.menu.removeAll();
        for (const p of profiles) {
            const item = new PopupMenu.PopupMenuItem(p.name);
            if (p.id === activeId)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            item.connect('activate', () => this._selectProfile(p.id));
            this._profiles.menu.addMenuItem(item);
        }
    }

    /** Dashboard links and Reconnect need a running gateway. */
    setGatewayUp(up) {
        this._openItem.setSensitive(up);
        this._logsItem.setSensitive(up);
        this._reconnectItem.visible = up;
    }

    /** @param {{label: ?string, action: ?string}} entry label null hides it */
    setGatewayItem({label, action}) {
        this._gatewayAction = action;
        this._setEntry(this._gatewayItem, {visible: label !== null, label: label ?? '', sensitive: action !== null});
    }

    setRestartItem(entry) {
        this._setEntry(this._restartItem, entry);
    }

    setUpdateItem(entry) {
        this._setEntry(this._updateItem, entry);
    }

    _setEntry(item, {visible, label, sensitive}) {
        item.visible = visible;
        if (visible) {
            item.label.text = label;
            item.setSensitive(sensitive);
        }
    }

    /** Replace the session list with informational lines. */
    showInfo(lines) {
        this._sessions.removeAll();
        for (const {text, hint} of lines) {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            if (hint)
                item.label.add_style_class_name('kiro-crew-hint');
            this._sessions.addMenuItem(item);
        }
    }

    /** @param {Array<{key, title, state, hint}>} rows see menuRows() */
    showSessions(rows, noWrap, onActivate) {
        this._sessions.removeAll();
        for (const row of rows) {
            const item = new PopupMenu.PopupMenuItem(row.title || _('(untitled)'));
            // Whichever comes first after the title takes the free space, so
            // the hint and the dot both sit at the right edge.
            const hint = HINT_TEXT[row.hint];
            if (hint) {
                item.add_child(new St.Label({
                    text: hint(),
                    style_class: 'kiro-crew-hint kiro-crew-row-hint',
                    x_align: Clutter.ActorAlign.END,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                }));
            }
            item.add_child(new St.Icon({
                icon_name: 'media-record-symbolic',
                style_class: DOT_CLASS[row.state] ?? DOT_CLASS.idle,
                icon_size: 10,
                x_align: Clutter.ActorAlign.END,
                x_expand: !hint
            }));
            if (noWrap)
                item.label.clutter_text.set_line_wrap(false);
            item.connect('activate', () => onActivate(row.key));
            this._sessions.addMenuItem(item);
        }
    }

    destroy() {
        this._menu.disconnect(this._openStateId);
        this._menu.removeAll();
    }
}
