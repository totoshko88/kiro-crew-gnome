import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ProfilesGroup} from './prefs/profiles.js';

export default class KiroCrewPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic'
        });
        window.add(page);

        page.add(new ProfilesGroup(window, settings).group);

        const browserGroup = new Adw.PreferencesGroup({title: _('Browser')});
        page.add(browserGroup);

        const apps = Gio.AppInfo.get_all_for_type('x-scheme-handler/https');
        const model = new Gtk.StringList();
        const ids = [''];
        model.append(_('System default'));
        for (const app of apps) {
            const id = app.get_id();
            if (!id)
                continue;
            ids.push(id);
            model.append(app.get_display_name());
        }
        const browserRow = new Adw.ComboRow({
            title: _('Open links with'),
            model
        });
        const current = settings.get_string('browser');
        const idx = ids.indexOf(current);
        browserRow.selected = idx >= 0 ? idx : 0;
        browserRow.connect('notify::selected', () => {
            settings.set_string('browser', ids[browserRow.selected] ?? '');
        });
        browserGroup.add(browserRow);

        const menuGroup = new Adw.PreferencesGroup({title: _('Menu')});
        page.add(menuGroup);

        const maxRow = new Adw.SpinRow({
            title: _('Recent sessions shown'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10, step_increment: 1,
                value: settings.get_int('max-sessions')
            })
        });
        maxRow.connect('notify::value', () => {
            settings.set_int('max-sessions', maxRow.value);
        });
        menuGroup.add(maxRow);

        const previews = new Adw.SwitchRow({
            title: _('Show message previews')
        });
        previews.active = settings.get_boolean('show-previews');
        previews.connect('notify::active', () => {
            settings.set_boolean('show-previews', previews.active);
        });
        menuGroup.add(previews);

        const pollRow = new Adw.SpinRow({
            title: _('Fallback poll interval (seconds)'),
            subtitle: _('Used only while the live connection is down'),
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 300, step_increment: 5,
                value: settings.get_int('poll-interval')
            })
        });
        pollRow.connect('notify::value', () => {
            settings.set_int('poll-interval', pollRow.value);
        });
        menuGroup.add(pollRow);

        const updateGroup = new Adw.PreferencesGroup({
            title: _('Updates'),
            description: _('The release channel of the active gateway, mirrored from it. ' +
                'Changing it asks that gateway to switch; the move takes effect on its next update. ' +
                'Applies to a local profile or one with SSH control.')
        });
        page.add(updateGroup);

        const channels = ['stable', 'insider'];
        const channelModel = new Gtk.StringList();
        channelModel.append(_('Stable (recommended)'));
        channelModel.append(_('Insider (early features)'));
        const channelRow = new Adw.ComboRow({
            title: _('Release channel'),
            subtitle: _('Insider ships features days to weeks early, with the new bugs that come with them.'),
            model: channelModel
        });
        const curChannel = settings.get_string('channel');
        const chIdx = channels.indexOf(curChannel);
        channelRow.selected = chIdx >= 0 ? chIdx : 0;
        channelRow.connect('notify::selected', () => {
            const next = channels[channelRow.selected] ?? 'stable';
            if (next !== settings.get_string('channel'))
                settings.set_string('channel', next);
        });
        updateGroup.add(channelRow);
    }
}
