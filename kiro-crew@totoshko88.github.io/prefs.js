/* prefs.js — Adwaita preferences for the Kiro Crew extension. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

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

        // Open the dashboard in the browser. The browser session's auth cookie
        // outlives the extension, so this is the reliable way to reach a live
        // session and read a fresh token. Dashboard access tokens are
        // short-lived (~1 hour), so an expired-token (dim red) icon is normal
        // after a while — reopen the dashboard and paste a new token here.
        const openRow = new Adw.ActionRow({
            title: _('Open dashboard'),
            subtitle: _('Access tokens expire after about an hour — reopen to copy a fresh one.'),
        });
        const openBtn = new Gtk.Button({
            label: _('Open'),
            valign: Gtk.Align.CENTER,
        });
        openBtn.connect('clicked', () => {
            const base = settings.get_string('endpoint').trim().replace(/\/+$/, '');
            const uri = base || 'http://localhost:5476';
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (e) {
                logError(e, 'kiro-crew: failed to open dashboard');
            }
        });
        openRow.add_suffix(openBtn);
        openRow.activatable_widget = openBtn;
        conn.add(openRow);

        // Fetch a token automatically via the gateway's loopback-only local
        // bootstrap (reads ~/.kiro/crew/.local_secret, GET /api/token/local).
        // Legal same-host path — not the forbidden CLI mint.
        const fetchRow = new Adw.ActionRow({
            title: _('Fetch token automatically'),
            subtitle: _('Uses the local gateway bootstrap on this machine.'),
        });
        const fetchBtn = new Gtk.Button({
            label: _('Fetch'),
            valign: Gtk.Align.CENTER,
        });
        fetchBtn.connect('clicked', () => {
            fetchBtn.sensitive = false;
            fetchBtn.label = _('Fetching…');
            const done = (ok) => {
                fetchBtn.sensitive = true;
                fetchBtn.label = ok ? _('Done') : _('Failed');
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    fetchBtn.label = _('Fetch');
                    return GLib.SOURCE_REMOVE;
                });
            };
            try {
                const home = GLib.get_home_dir();
                const sp = GLib.build_filenamev([home, '.kiro', 'crew', '.local_secret']);
                const [okr, bytes] = Gio.File.new_for_path(sp).load_contents(null);
                if (!okr) {
                    done(false);
                    return;
                }
                const secret = new TextDecoder('utf-8').decode(bytes).trim();
                const base = settings.get_string('endpoint').trim().replace(/\/+$/, '') ||
                    'http://localhost:5476';
                const session = new Soup.Session({ timeout: 10 });
                const msg = Soup.Message.new('GET', `${base}/api/token/local`);
                msg.get_request_headers().append('X-Local-Secret', secret);
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            const b = s.send_and_read_finish(res);
                            if (msg.get_status() !== Soup.Status.OK) {
                                done(false);
                                return;
                            }
                            const data = JSON.parse(
                                new TextDecoder('utf-8').decode(b.get_data()));
                            if (data.token) {
                                settings.set_string('token', data.token);
                                token.text = data.token;
                                done(true);
                            } else {
                                done(false);
                            }
                        } catch (e) {
                            logError(e, 'kiro-crew: token fetch parse failed');
                            done(false);
                        }
                    });
            } catch (e) {
                logError(e, 'kiro-crew: token fetch failed');
                done(false);
            }
        });
        fetchRow.add_suffix(fetchBtn);
        fetchRow.activatable_widget = fetchBtn;
        conn.add(fetchRow);

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
