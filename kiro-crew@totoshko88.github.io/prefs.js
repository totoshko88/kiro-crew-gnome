/* prefs.js — Adwaita preferences for the Kiro Crew extension. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KiroCrewPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Connection ---------------------------------------------------
        const conn = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('The extension cannot create a token itself. Open your Kiro Crew dashboard, copy an access token, and paste it below.'),
        });
        page.add(conn);

        const endpoint = new Adw.EntryRow({ title: _('Gateway URL') });
        endpoint.text = settings.get_string('endpoint');
        endpoint.connect('changed', () => {
            settings.set_string('endpoint', endpoint.text.trim());
        });
        conn.add(endpoint);

        const token = new Adw.PasswordEntryRow({ title: _('Access token') });
        token.text = settings.get_string('token');
        token.connect('changed', () => {
            settings.set_string('token', token.text.trim());
        });
        conn.add(token);

        // Saved endpoints (newline-separated, mapped to the string array).
        const endpoints = new Adw.EntryRow({
            title: _('Saved endpoints (comma-separated)'),
        });
        endpoints.text = settings.get_strv('endpoints').join(', ');
        endpoints.connect('changed', () => {
            const list = endpoints.text.split(',')
                .map((s) => s.trim()).filter((s) => s.length > 0);
            settings.set_strv('endpoints', list);
        });
        conn.add(endpoints);

        // --- Browser ------------------------------------------------------
        const browserGroup = new Adw.PreferencesGroup({ title: _('Browser') });
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
            model,
        });
        const current = settings.get_string('browser');
        const idx = ids.indexOf(current);
        browserRow.selected = idx >= 0 ? idx : 0;
        browserRow.connect('notify::selected', () => {
            settings.set_string('browser', ids[browserRow.selected] ?? '');
        });
        browserGroup.add(browserRow);

        // --- Menu ---------------------------------------------------------
        const menuGroup = new Adw.PreferencesGroup({ title: _('Menu') });
        page.add(menuGroup);

        const maxRow = new Adw.SpinRow({
            title: _('Recent sessions shown'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10, step_increment: 1,
                value: settings.get_int('max-sessions'),
            }),
        });
        maxRow.connect('notify::value', () => {
            settings.set_int('max-sessions', maxRow.value);
        });
        menuGroup.add(maxRow);

        const previews = new Adw.SwitchRow({
            title: _('Show message previews'),
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
                value: settings.get_int('poll-interval'),
            }),
        });
        pollRow.connect('notify::value', () => {
            settings.set_int('poll-interval', pollRow.value);
        });
        menuGroup.add(pollRow);
    }
}
