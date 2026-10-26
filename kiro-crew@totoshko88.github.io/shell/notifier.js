/* notifier.js — the extension's message-tray source. */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// GNOME 46 switched Source and Notification to property objects and replaced
// showNotification() with addNotification(); GNOME 45 is positional.
const HAS_MODERN_MESSAGE_TRAY = parseInt(Config.PACKAGE_VERSION) >= 46;

export class Notifier {
    constructor(iconName) {
        this._iconName = iconName;
        this._source = null;
        this._sourceDestroyId = 0;
    }

    /** @param {?Function} onActivated called when the user clicks the notification */
    notify(title, body, onActivated = null) {
        const source = this._ensureSource();
        const notification = HAS_MODERN_MESSAGE_TRAY
            ? new MessageTray.Notification({source, title, body})
            : new MessageTray.Notification(source, title, body);
        // The notification and its handler go with the source in destroy().
        if (onActivated)
            notification.connect('activated', () => onActivated());
        if (HAS_MODERN_MESSAGE_TRAY)
            source.addNotification(notification);
        else
            source.showNotification(notification);
    }

    _ensureSource() {
        if (this._source)
            return this._source;
        const source = HAS_MODERN_MESSAGE_TRAY
            ? new MessageTray.Source({title: 'Kiro Crew', iconName: this._iconName})
            : new MessageTray.Source('Kiro Crew', this._iconName);
        // The tray destroys a source once its last notification is dismissed.
        this._sourceDestroyId = source.connect('destroy', () => {
            this._sourceDestroyId = 0;
            this._source = null;
        });
        Main.messageTray.add(source);
        this._source = source;
        return source;
    }

    destroy() {
        if (!this._source)
            return;
        this._source.disconnect(this._sourceDestroyId);
        this._sourceDestroyId = 0;
        this._source.destroy();
        this._source = null;
    }
}
