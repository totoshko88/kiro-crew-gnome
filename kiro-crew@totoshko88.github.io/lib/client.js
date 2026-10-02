/**
 * client.js — talks to the Kiro Crew gateway: a WebSocket for live slot/
 * notification frames, plain HTTP GETs for /api/status and /api/sessions,
 * with token auth and reconnect backoff. GJS/libsoup3 only.
 *
 * Emits via the callbacks passed to connect():
 *   onSlots(slotsArray)            latest "slots" frame data
 *   onNotification(noticeObject)   a "notification" frame
 *   onOnline(bool)                 reachability changed
 */

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DECODER = new TextDecoder('utf-8');
const ENCODER = new TextEncoder();

export class GatewayClient {
    /**
     * @param {() => {endpoint: string, token: string}} getConfig
     *   Called lazily so a settings change is picked up on the next connect.
     */
    constructor(getConfig) {
        this._getConfig = getConfig;
        this._session = new Soup.Session({ timeout: 10 });
        this._ws = null;
        this._wsCancellable = null;
        this._reconnectId = 0;
        this._backoff = 1;          // seconds, doubles up to _backoffMax
        this._backoffMax = 30;
        this._online = false;
        this._authError = false;
        this._stopped = true;
        this._cb = {};
    }

    _setAuthError(v) {
        if (v === this._authError)
            return;
        this._authError = v;
        this._cb.onAuthError?.(v);
    }

    _base() {
        const { endpoint } = this._getConfig();
        return (endpoint || 'http://localhost:5476').replace(/\/+$/, '');
    }

    /**
     * Read ~/.kiro/crew/.local_secret (readable only by this user's processes).
     * Returns the trimmed secret, or '' if unavailable.
     */
    _readLocalSecret() {
        try {
            const path = GLib.build_filenamev(
                [GLib.get_home_dir(), '.kiro', 'crew', '.local_secret']);
            const file = Gio.File.new_for_path(path);
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                return '';
            return new TextDecoder('utf-8').decode(bytes).trim();
        } catch {
            return '';
        }
    }

    /**
     * Mint a fresh dashboard token via the gateway's loopback-only local
     * bootstrap (GET /api/token/local with the X-Local-Secret header). This is
     * the sanctioned path for a same-host app — not the forbidden CLI mint — and
     * only succeeds for a process in the gateway's own namespaces (a user-session
     * process like gnome-shell qualifies). Resolves to the token string, or ''.
     */
    async fetchLocalToken() {
        const secret = this._readLocalSecret();
        if (!secret)
            return '';
        const uri = `${this._base()}/api/token/local`;
        const message = Soup.Message.new('GET', uri);
        message.get_request_headers().append('X-Local-Secret', secret);
        return new Promise((resolve) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (message.get_status() !== Soup.Status.OK) {
                            resolve('');
                            return;
                        }
                        const data = JSON.parse(
                            DECODER.decode(bytes.get_data()));
                        resolve(typeof data.token === 'string' ? data.token : '');
                    } catch {
                        resolve('');
                    }
                });
        });
    }

    _withToken(url) {
        const { token } = this._getConfig();
        if (!token)
            return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}token=${encodeURIComponent(token)}`;
    }

    _wsUri() {
        const base = this._base().replace(/^http/, 'ws');
        return this._withToken(`${base}/api/ws`);
    }

    _setOnline(v) {
        if (v === this._online)
            return;
        this._online = v;
        this._cb.onOnline?.(v);
    }

    connect(callbacks) {
        this._cb = callbacks || {};
        this._stopped = false;
        this._openWebsocket();
    }

    _openWebsocket() {
        if (this._stopped)
            return;
        this._closeWebsocket();
        const message = Soup.Message.new('GET', this._wsUri());
        this._wsCancellable = new Gio.Cancellable();
        this._session.websocket_connect_async(
            message,
            null,          // origin
            [],            // protocols
            0,             // io priority
            this._wsCancellable,
            (session, result) => {
                try {
                    this._ws = session.websocket_connect_finish(result);
                } catch (e) {
                    // A 401/403 handshake means the token is bad/expired, not
                    // that the gateway is down — surface it distinctly so the
                    // indicator can show a muted "auth" state, not a hard error.
                    const status = message.get_status?.() ?? 0;
                    this._setAuthError(status === Soup.Status.UNAUTHORIZED ||
                        status === Soup.Status.FORBIDDEN);
                    this._setOnline(false);
                    this._scheduleReconnect();
                    return;
                }
                this._setAuthError(false);
                this._backoff = 1;
                this._setOnline(true);
                this._ws.connect('message', (_c, type, bytes) => {
                    if (type !== Soup.WebsocketDataType.TEXT)
                        return;
                    this._handleFrame(DECODER.decode(bytes.get_data()));
                });
                this._ws.connect('closed', () => {
                    this._setOnline(false);
                    this._ws = null;
                    this._scheduleReconnect();
                });
                this._ws.connect('error', () => {
                    this._setOnline(false);
                });
            }
        );
    }

    _handleFrame(text) {
        let frame;
        try {
            frame = JSON.parse(text);
        } catch {
            return;
        }
        switch (frame.type) {
        case 'slots':
            this._cb.onSlots?.(Array.isArray(frame.data) ? frame.data : []);
            break;
        case 'notification':
            this._cb.onNotification?.(frame);
            break;
        default:
            break;
        }
    }

    _scheduleReconnect() {
        if (this._stopped || this._reconnectId)
            return;
        const delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        this._reconnectId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._reconnectId = 0;
                this._openWebsocket();
                return GLib.SOURCE_REMOVE;
            });
    }

    _closeWebsocket() {
        if (this._wsCancellable) {
            this._wsCancellable.cancel();
            this._wsCancellable = null;
        }
        if (this._ws) {
            try {
                this._ws.close(Soup.WebsocketCloseCode.NORMAL, null);
            } catch { /* already gone */ }
            this._ws = null;
        }
    }

    /** HTTP GET returning parsed JSON, or null on any failure. Async/Promise. */
    async getJson(path) {
        const uri = this._withToken(`${this._base()}${path}`);
        const message = Soup.Message.new('GET', uri);
        return new Promise((resolve) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status === Soup.Status.UNAUTHORIZED ||
                            status === Soup.Status.FORBIDDEN) {
                            this._setAuthError(true);
                            resolve(null);
                            return;
                        }
                        if (status !== Soup.Status.OK) {
                            resolve(null);
                            return;
                        }
                        this._setAuthError(false);
                        const text = DECODER.decode(bytes.get_data());
                        resolve(JSON.parse(text));
                    } catch {
                        resolve(null);
                    }
                });
        });
    }

    async fetchStatus() {
        return this.getJson('/api/status');
    }

    async fetchSessions(limit, preview) {
        const q = `?limit=${encodeURIComponent(limit)}${preview ? '&preview=1' : ''}`;
        return this.getJson(`/api/sessions${q}`);
    }

    reconnectNow() {
        this._backoff = 1;
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._openWebsocket();
    }

    get online() {
        return this._online;
    }

    get authError() {
        return this._authError;
    }

    destroy() {
        this._stopped = true;
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._closeWebsocket();
        if (this._session) {
            try {
                this._session.abort();
            } catch { /* noop */ }
            this._session = null;
        }
        this._cb = {};
    }
}

// Silence unused-import linters where ENCODER may be reserved for future sends.
void ENCODER;
