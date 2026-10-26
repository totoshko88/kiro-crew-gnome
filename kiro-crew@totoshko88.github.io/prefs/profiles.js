/* profiles.js — the "Gateway profiles" group of the preferences window. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {isCancelled} from '../lib/cancel.js';
import {LocalBootstrap} from '../lib/localBootstrap.js';
import {
    KIND, DEFAULT_PORT, normalizeProfile, profileError, profileBaseUrl, profileSummary,
    usesTunnel, usesSshControl, isLoopbackHost
} from '../lib/profiles.js';
import {readProfiles, writeProfiles, readActiveProfile, migrateLegacyProfiles} from '../lib/profileStore.js';
import {RemoteControl} from '../lib/remote.js';

const ERROR_TEXT = {
    name: () => _('Give the profile a name.'),
    host: () => _('Enter an IP address or hostname, optionally as user@host.'),
    port: () => _('The port must be a number from 1 to 65535.')
};

/** @param {number} tunnelPort local port of this profile's open tunnel, or 0 */
function describe(p, tunnelPort) {
    if (p.kind === KIND.LOCAL)
        return _('This computer · %s').replace('%s', profileSummary(p));
    if (!usesTunnel(p))
        return _('Remote, read-only · %s').replace('%s', profileSummary(p));
    const s = (usesSshControl(p) ? _('Remote, controlled over SSH · %s')
        : _('Remote via SSH tunnel, read-only · %s')).replace('%s', profileSummary(p));
    return tunnelPort ? `${s} → 127.0.0.1:${tunnelPort}` : s;
}

export class ProfilesGroup {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._rows = [];
        this._draft = null;
        this._layout = '';
        this._bootstrap = new LocalBootstrap();
        this._remote = new RemoteControl();
        migrateLegacyProfiles(settings);

        this.group = new Adw.PreferencesGroup({
            title: _('Gateway profiles'),
            description: _('One profile per gateway, each with its own token. ' +
                'Local is the gateway on this computer, with full controls. ' +
                'Remote is another machine, reached through an SSH tunnel the extension opens; ' +
                'read-only unless you allow control over SSH.')
        });
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Add a profile')
        });
        addBtn.add_css_class('flat');
        addBtn.connect('clicked', () => this._addDraft());
        this.group.set_header_suffix(addBtn);

        this._activeRow = new Adw.ComboRow({title: _('Active profile')});
        this._activeChangedId = this._activeRow.connect('notify::selected', () => {
            const p = readProfiles(settings)[this._activeRow.selected];
            if (p)
                settings.set_string('active-profile', p.id);
        });
        this.group.add(this._activeRow);
        this.group.add(this._buildOpenRow());

        this._changedId = settings.connect('changed', (_s, key) => {
            if (key === 'profiles' || key === 'active-profile' || key === 'tunnel-port')
                this._refresh(false);
        });
        window.connect('close-request', () => {
            settings.disconnect(this._changedId);
            this._bootstrap.destroy();
            this._remote.destroy();
            return false;
        });
        this._refresh(true);
    }

    _buildOpenRow() {
        const row = new Adw.ActionRow({
            title: _('Open dashboard'),
            subtitle: _('Of the active profile — the place to copy a fresh token.')
        });
        const button = new Gtk.Button({label: _('Open'), valign: Gtk.Align.CENTER});
        button.connect('clicked', () => {
            const p = readActiveProfile(this._settings);
            const tunnelPort = this._settings.get_int('tunnel-port');
            if (usesTunnel(p) && !tunnelPort) {
                this._toast(_('The SSH tunnel for this profile is not open yet.'));
                return;
            }
            try {
                Gio.AppInfo.launch_default_for_uri(profileBaseUrl(p, tunnelPort), null);
            } catch (e) {
                logError(e, 'kiro-crew: failed to open dashboard');
            }
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title}));
    }

    /**
     * Follow a settings change. The rows are rebuilt only when the set of
     * profiles changed and nothing is being edited; otherwise just the
     * untouched token fields follow (the extension refreshes tokens).
     */
    _refresh(force) {
        const profiles = readProfiles(this._settings);
        this._syncActiveRow(profiles);
        const layout = JSON.stringify([this._settings.get_int('tunnel-port'),
            ...profiles.map(p => [p.id, p.name, p.host, p.port, p.kind, p.sshcontrol])]);
        const editing = this._draft !== null || this._rows.some(r => r.dirty);
        if (force || (layout !== this._layout && !editing)) {
            this._layout = layout;
            this._rebuildRows(profiles);
            return;
        }
        for (const r of this._rows) {
            const p = profiles.find(x => x.id === r.id);
            if (p && !r.dirty)
                r.setToken(p.token);
        }
    }

    _syncActiveRow(profiles) {
        const activeId = readActiveProfile(this._settings).id;
        this._activeRow.block_signal_handler(this._activeChangedId);
        this._activeRow.model = Gtk.StringList.new(profiles.map(p => p.name));
        this._activeRow.selected = Math.max(0, profiles.findIndex(p => p.id === activeId));
        this._activeRow.unblock_signal_handler(this._activeChangedId);
    }

    _rebuildRows(profiles) {
        const expanded = new Set(this._rows.filter(r => r.row.expanded).map(r => r.id));
        for (const r of this._rows)
            this.group.remove(r.row);
        const activeId = this._settings.get_string('active-profile');
        this._rows = profiles.map(p => this._buildRow(p, {
            canDelete: profiles.length > 1,
            tunnelPort: p.id === activeId ? this._settings.get_int('tunnel-port') : 0
        }));
        for (const r of this._rows) {
            r.row.expanded = expanded.has(r.id);
            this.group.add(r.row);
        }
    }

    _addDraft() {
        if (!this._draft) {
            this._draft = this._buildRow(normalizeProfile({port: String(DEFAULT_PORT), kind: KIND.REMOTE}),
                {canDelete: true, draft: true});
            this.group.add(this._draft.row);
        }
        this._draft.row.expanded = true;
    }

    _buildRow(p, {canDelete, tunnelPort = 0, draft = false}) {
        // Plain text: names and hosts are user input, and subtitles contain "<port>".
        const row = new Adw.ExpanderRow({
            title: p.name || _('New profile'),
            subtitle: draft ? _('Not saved yet') : describe(p, tunnelPort),
            use_markup: false
        });
        const name = new Adw.EntryRow({title: _('Profile name'), text: p.name});
        const host = new Adw.EntryRow({
            title: _('Host — IP or hostname (user@host for another SSH user)'),
            text: p.host
        });
        const port = new Adw.EntryRow({
            title: _('Port — the gateway’s port on that host'),
            text: p.port,
            input_purpose: Gtk.InputPurpose.DIGITS
        });
        const token = new Adw.PasswordEntryRow({title: _('Access token'), text: p.token});
        const kindRow = new Adw.ComboRow({
            title: _('Gateway runs on'),
            subtitle: _('Choose Remote for a tunnel you run yourself: ' +
                'no gateway controls, and the local secret is never sent to it.'),
            model: Gtk.StringList.new([_('This computer (local)'), _('Another machine (remote)')]),
            selected: p.kind === KIND.REMOTE ? 1 : 0
        });
        const tunnelRow = new Adw.ActionRow({
            title: _('Reached through an SSH tunnel'),
            subtitle_lines: 3,
            use_markup: false
        });
        const sshRow = new Adw.SwitchRow({
            title: _('Allow control over SSH'),
            subtitle: _('Fetch the token and start, stop, restart or update kirocrew.service on that host ' +
                'with fixed SSH commands. Stop, start and update need passwordless sudo there.'),
            active: p.sshcontrol === '1'
        });
        const fetchRow = new Adw.ActionRow({title: _('Fetch token automatically'), use_markup: false});
        const fetchBtn = new Gtk.Button({label: _('Fetch'), valign: Gtk.Align.CENTER});
        fetchRow.add_suffix(fetchBtn);
        fetchRow.activatable_widget = fetchBtn;

        const actionsRow = new Adw.ActionRow();
        const saveBtn = new Gtk.Button({label: _('Save'), valign: Gtk.Align.CENTER, sensitive: draft});
        saveBtn.add_css_class('suggested-action');
        const deleteBtn = new Gtk.Button({
            label: draft ? _('Discard') : _('Delete'),
            valign: Gtk.Align.CENTER,
            sensitive: canDelete
        });
        deleteBtn.add_css_class('destructive-action');
        actionsRow.add_suffix(deleteBtn);
        actionsRow.add_suffix(saveBtn);

        for (const w of [name, host, port, token, kindRow, tunnelRow, sshRow, fetchRow, actionsRow])
            row.add_row(w);

        const edited = () => normalizeProfile({
            id: p.id,
            name: name.text,
            host: host.text,
            port: port.text,
            token: token.text,
            kind: isLoopbackHost(host.text) && kindRow.selected === 0 ? KIND.LOCAL : KIND.REMOTE,
            sshcontrol: sshRow.active ? '1' : ''
        });
        const syncVisibility = () => {
            const c = edited();
            const loopback = isLoopbackHost(c.host);
            kindRow.visible = loopback;
            tunnelRow.visible = !loopback;
            sshRow.visible = !loopback;
            fetchRow.visible = c.kind === KIND.LOCAL || usesSshControl(c);
            fetchRow.subtitle = c.kind === KIND.LOCAL
                ? _('Uses the local gateway bootstrap on this computer.')
                : _('Runs the same bootstrap on that host over SSH; its secret never leaves it.');
            tunnelRow.subtitle = _('Runs ssh -N -L 127.0.0.1:<local port>:localhost:%d %s and keeps it open. ' +
                'The local port is picked automatically and never equals %d. ' +
                'Needs key-based SSH login with the host key already accepted.')
                .replaceAll('%d', c.port).replace('%s', c.host || 'host');
        };

        const entry = {id: p.id, row, dirty: draft};
        const markDirty = () => {
            entry.dirty = true;
            saveBtn.sensitive = true;
            syncVisibility();
        };
        for (const w of [name, host, port])
            w.connect('changed', markDirty);
        const tokenChangedId = token.connect('changed', markDirty);
        kindRow.connect('notify::selected', markDirty);
        sshRow.connect('notify::active', markDirty);
        syncVisibility();

        // A token refreshed elsewhere must not count as an edit.
        entry.setToken = t => {
            if (token.text === t)
                return;
            token.block_signal_handler(tokenChangedId);
            token.text = t;
            token.unblock_signal_handler(tokenChangedId);
        };

        fetchBtn.connect('clicked', () => this._fetchToken(edited(), fetchBtn, token));
        saveBtn.connect('clicked', () => {
            const profile = edited();
            const error = profileError(profile);
            if (error) {
                this._toast(ERROR_TEXT[error]());
                return;
            }
            profile.id ||= GLib.uuid_string_random();
            this._save(profile, entry, draft);
        });
        deleteBtn.connect('clicked', () => {
            if (!draft) {
                this._delete(p.id);
                return;
            }
            this.group.remove(row);
            this._draft = null;
            this._refresh(false);
        });
        return entry;
    }

    _fetchToken(profile, button, tokenField) {
        button.sensitive = false;
        const mint = profile.kind === KIND.LOCAL
            ? this._bootstrap.fetchToken(profile.port)
            : this._remote.fetchToken(profile);
        mint.then(token => {
            button.sensitive = true;
            if (!token) {
                this._toast(profile.kind === KIND.LOCAL
                    ? _('Could not fetch a token from the local gateway.')
                    : _('Could not fetch a token over SSH. Is the gateway running there, and does key login work?'));
                return;
            }
            // An edit like any other: Save stores it.
            tokenField.text = token;
            this._toast(_('Token fetched — press Save to keep it.'));
        }).catch(e => {
            if (isCancelled(e))
                return;
            button.sensitive = true;
            logError(e, 'kiro-crew: token fetch failed');
        });
    }

    _save(profile, entry, draft) {
        const profiles = readProfiles(this._settings);
        const idx = profiles.findIndex(x => x.id === profile.id);
        if (idx >= 0)
            profiles[idx] = profile;
        else
            profiles.push(profile);
        entry.dirty = false;
        if (draft) {
            this.group.remove(entry.row);
            this._draft = null;
        }
        writeProfiles(this._settings, profiles);
        this._refresh(true);
        this._toast(_('Profile “%s” saved.').replace('%s', profile.name));
    }

    _delete(id) {
        const all = readProfiles(this._settings);
        const rest = all.filter(p => p.id !== id);
        if (rest.length === 0)
            return;
        // The gateway on this computer must stay reachable.
        if (all.find(p => p.id === id).kind === KIND.LOCAL && !rest.some(p => p.kind === KIND.LOCAL)) {
            this._toast(_('Keep at least one local profile — add another first.'));
            return;
        }
        writeProfiles(this._settings, rest);
        if (!rest.some(p => p.id === this._settings.get_string('active-profile')))
            this._settings.set_string('active-profile', rest[0].id);
        this._refresh(true);
    }
}
