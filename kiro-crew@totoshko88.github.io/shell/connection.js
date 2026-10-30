/**
 * connection.js — the link to the active gateway profile: its client, its SSH
 * tunnel (remote profiles), its SSH control commands, and its token.
 */

import {GatewayClient} from './client.js';
import {SshTunnel} from './tunnel.js';
import {LocalBootstrap} from '../lib/localBootstrap.js';
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
     * @param {object} handlers onSlots, onNotification, onStatus,
     *   onUpdateProgress, onOnline, onAuthError, onTunnelState — forwarded
     *   from the client and the tunnel
     */
    constructor(settings, handlers) {
        this._settings = settings;
        this._handlers = handlers;
        migrateLegacyProfiles(settings);
        this._profile = readActiveProfile(settings);
        this._key = connectionKey(this._profile);
        this._mintingToken = false;
        this._bootstrap = new LocalBootstrap();
        this._remote = new RemoteControl();
        this._tunnel = new SshTunnel((state, error) => this._onTunnelState(state, error));
        this._client = new GatewayClient(() => ({endpoint: this.baseUrl, token: this._profile.token}));
    }

    start() {
        this._client.start({
            onSlots: slots => this._handlers.onSlots(slots),
            onNotification: note => this._handlers.onNotification(note),
            onStatus: status => this._handlers.onStatus(status),
            onUpdateProgress: progress => this._handlers.onUpdateProgress(progress),
            onOnline: online => this._handlers.onOnline(online),
            onAuthError: bad => {
                this._handlers.onAuthError(bad);
                if (bad)
                    this.tryToken();
            },
            onReauth: () => this._reauth()
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
            // A different gateway: drop the old one's session cookie so it
            // can't shadow the new profile's token on the next exchange.
            this._client.clearSession();
            if (this._client.paused)
                this._client.resume();
            else
                this._client.reconnectNow();
            if (!this._profile.token)
                this.tryToken();
            return 'switched';
        }
        if (this._profile.token !== prev.token) {
            // A fresh token for the same gateway: exchange it for a new
            // cookie rather than riding the stale one.
            this._client.clearSession();
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
            return Promise.resolve(false);
        const id = this._profile.id;
        this._mintingToken = true;
        const mint = this.isLocal
            ? this._bootstrap.fetchToken(this._profile.port)
            : this._remote.fetchToken(this._profile);
        // Storing the token rewrites the profile; reload() then reconnects.
        // Resolves true when the profile token changed (a reconnect is already
        // on its way), false otherwise (the caller may need to reconnect).
        return mint.then(token => {
            this._mintingToken = false;
            if (this._profile.id !== id)
                return false;
            if (token) {
                if (token !== this._profile.token) {
                    setProfileToken(this._settings, id, token);
                    return true;
                }
                return false;
            }
            // A local mint the gateway refused on owner-provenance grounds
            // (gateway 0.11+) can't be retried into success — the shell is not
            // the owner process the gateway will mint for. Tell the caller so
            // it can point the user at the dashboard's CLI login link once,
            // instead of looping. A network error ('' with no refusal code)
            // is left to the normal reconnect path.
            const code = this.isLocal ? this._bootstrap.lastCode : '';
            if (code && code !== 'unreachable' && this._handlers.onMintRefused)
                this._handlers.onMintRefused(code);
            return false;
        }).catch(e => {
            this._mintingToken = false;
            logUnlessCancelled(e, 'token fetch failed');
            return false;
        });
    }

    /**
     * A reconnect tick while the gateway keeps rejecting our token: get a fresh
     * one and reconnect with it. For a controllable profile that means minting
     * (tryToken rewrites the profile, and reload() reconnects); either way we
     * always reconnect so the backoff loop never stalls on a mint that minted
     * nothing. Called from the client's reconnect timer, so it replaces the
     * plain reconnect that tick rather than adding a second one.
     */
    _reauth() {
        // Try for a fresh token first (controllable profiles). If the mint
        // produced a new one, reload() is already reconnecting with it, so we
        // don't reconnect again here. If it produced nothing — the same token,
        // a refusal, a network error, or a read-only remote — reconnect anyway
        // so the backoff loop keeps turning and never stalls on a stale token.
        if (this.canControl && !this._mintingToken) {
            this.tryToken().then(changed => {
                if (!changed)
                    this._client.reconnectNow();
            });
            return;
        }
        this._client.reconnectNow();
    }

    /** Shut down a hand-run gateway on this computer through its local bootstrap. */
    shutdownLocal() {
        return this._bootstrap.shutdown(this._profile.port);
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
        this._bootstrap.destroy();
        this._client.destroy();
    }
}
