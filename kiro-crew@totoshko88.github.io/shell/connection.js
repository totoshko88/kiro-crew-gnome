/**
 * connection.js — the link to the active gateway profile: its client, its SSH
 * tunnel (remote profiles), its SSH control commands, and its token.
 */

import {GatewayClient} from './client.js';
import {SshTunnel} from './tunnel.js';
import {RemoteControl} from '../lib/remote.js';
import {logUnlessCancelled} from '../lib/cancel.js';
import {KIND, profileBaseUrl, usesTunnel, usesSshControl, reservedPorts} from '../lib/profiles.js';
import {slotName} from '../lib/state.js';
import {readProfiles, readActiveProfile, migrateLegacyProfiles, setProfileToken} from '../lib/profileStore.js';

/** What, when it changes, makes the profile a different gateway. */
function connectionKey(p) {
    return [p.id, p.kind, p.host, p.port].join('|');
}

export class GatewayConnection {
    /**
     * @param {Gio.Settings} settings
     * @param {object} handlers onSlots, onNotification, onOnline, onAuthError,
     *   onTunnelState — forwarded from the client and the tunnel
     */
    constructor(settings, handlers) {
        this._settings = settings;
        this._handlers = handlers;
        migrateLegacyProfiles(settings);
        this._profile = readActiveProfile(settings);
        this._key = connectionKey(this._profile);
        this._mintingToken = false;
        this._remote = new RemoteControl();
        this._tunnel = new SshTunnel((state, error) => this._onTunnelState(state, error));
        this._client = new GatewayClient(() => ({endpoint: this.baseUrl, token: this._profile.token}));
    }

    start() {
        this._client.start({
            onSlots: slots => this._handlers.onSlots(slots),
            onNotification: frame => this._handlers.onNotification(frame),
            onOnline: online => this._handlers.onOnline(online),
            onAuthError: bad => {
                this._handlers.onAuthError(bad);
                if (bad)
                    this.tryToken();
            }
        });
        this._openTunnel();
        if (!this._profile.token)
            this.tryToken();
    }

    get profile() {
        return this._profile;
    }

    get client() {
        return this._client;
    }

    get remote() {
        return this._remote;
    }

    get baseUrl() {
        return profileBaseUrl(this._profile, this._tunnel.port);
    }

    get tunnelDown() {
        return usesTunnel(this._profile) && this._tunnel.state === 'down';
    }

    get tunnelError() {
        return this._tunnel.error;
    }

    /**
     * Is this the gateway on this computer? Taken from the profile's kind,
     * never from the URL: a tunnel listens on localhost too.
     */
    get isLocal() {
        return this._profile.kind === KIND.LOCAL;
    }

    /** May its token and service be handled (locally, or over SSH)? */
    get canControl() {
        return this.isLocal || usesSshControl(this._profile);
    }

    profiles() {
        return readProfiles(this._settings);
    }

    /** Dashboard URL with the token, e.g. pageUrl('/logs'). */
    pageUrl(path) {
        return this._withToken(`${this.baseUrl}${path}`);
    }

    /** The dashboard opens a conversation at /chat?sid=<slot id>. */
    sessionUrl(key) {
        return this._withToken(`${this.baseUrl}/chat?sid=${encodeURIComponent(slotName(key))}`);
    }

    _withToken(url) {
        const token = this._profile.token;
        if (!token)
            return url;
        return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    }

    /**
     * Re-read the active profile after a settings change.
     * @returns {'switched'|'token'|null} a different gateway, a new token for
     *   the same one, or nothing that matters for the connection
     */
    reload() {
        const prev = this._profile;
        this._profile = readActiveProfile(this._settings);
        const key = connectionKey(this._profile);
        if (key !== this._key) {
            this._key = key;
            this._openTunnel();
            if (this._client.paused)
                this._client.resume();
            else
                this._client.reconnectNow();
            if (!this._profile.token)
                this.tryToken();
            return 'switched';
        }
        if (this._profile.token !== prev.token) {
            this._client.reconnectNow();
            return 'token';
        }
        return null;
    }

    /**
     * Mint a token without a paste: the local bootstrap for the gateway on
     * this computer, or the same bootstrap run on the remote host over SSH
     * (its secret never leaves that host). A read-only remote profile gets
     * neither, so this computer's secret is never sent to another gateway.
     */
    tryToken() {
        if (this._mintingToken || !this.canControl)
            return;
        const id = this._profile.id;
        this._mintingToken = true;
        const mint = this.isLocal
            ? this._client.fetchLocalToken()
            : this._remote.fetchToken(this._profile);
        // Storing the token rewrites the profile; reload() then reconnects.
        mint.then(token => {
            this._mintingToken = false;
            if (token && this._profile.id === id && token !== this._profile.token)
                setProfileToken(this._settings, id, token);
        }).catch(e => {
            this._mintingToken = false;
            logUnlessCancelled(e, 'token fetch failed');
        });
    }

    _openTunnel() {
        if (usesTunnel(this._profile))
            this._tunnel.start(this._profile, reservedPorts(this.profiles()));
        else
            this._tunnel.stop();
    }

    _onTunnelState(state, error) {
        // Published for the preferences window (Open dashboard, subtitles).
        if (this._settings.get_int('tunnel-port') !== this._tunnel.port)
            this._settings.set_int('tunnel-port', this._tunnel.port);
        if (state === 'running')
            this._client.reconnectNow();
        this._handlers.onTunnelState(state, error);
    }

    destroy() {
        // The tunnel goes first: no ssh process may outlive disable().
        this._tunnel.destroy();
        if (this._settings.get_int('tunnel-port') !== 0)
            this._settings.set_int('tunnel-port', 0);
        this._remote.destroy();
        this._client.destroy();
    }
}
