/**
 * client.js — talks to the Kiro Crew gateway: a WebSocket for live slot/
 * notification frames, plain HTTP GETs for /api/status and /api/sessions,
 * with token auth and reconnect backoff. GJS/libsoup3 only.
 *
 * Emits via the callbacks passed to start():
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
        this._session = new Soup.Session({timeout: 10});
        this._ws = null;
        this._wsSignalIds = [];
        this._wsCancellable = null;
        // Cancels in-flight file reads (local secret) on destroy().
        this._ioCancellable = new Gio.Cancellable();
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
        const {endpoint} = this._getConfig();
        return (endpoint || 'http://localhost:5476').replace(/\/+$/, '');
    }

    /**
     * Read ~/.kiro/crew/.local_secret (readable only by this user's processes).
     * Async (never blocks the shell main loop). Resolves to the trimmed
     * secret, or '' if unavailable or cancelled.
     */
    _readLocalSecret() {
        const path = GLib.build_filenamev(
            [GLib.get_home_dir(), '.kiro', 'crew', '.local_secret']);
        const file = Gio.File.new_for_path(path);
        return new Promise(resolve => {
            file.load_contents_async(this._ioCancellable, (f, result) => {
                try {
                    const [, bytes] = f.load_contents_finish(result);
                    resolve(DECODER.decode(bytes).trim());
                } catch {
                    resolve('');
                }
            });
        });
    }

    /**
     * Mint a fresh dashboard token via the gateway's loopback-only local
     * bootstrap (GET /api/token/local with the X-Local-Secret header). This is
     * the sanctioned path for a same-host app — not the forbidden CLI mint — and
     * only succeeds for a process in the gateway's own namespaces (a user-session
     * process like gnome-shell qualifies). Resolves to the token string, or ''.
     */
    async fetchLocalToken() {
        const secret = await this._readLocalSecret();
        if (!secret || !this._session)
            return '';
        const uri = `${this._base()}/api/token/local`;
        const message = Soup.Message.new('GET', uri);
        message.get_request_headers().append('X-Local-Secret', secret);
        return new Promise(resolve => {
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
        const {token} = this._getConfig();
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

    /**
     * Start the live connection. Named start() (not connect()) so it is not
     * mistaken for a GObject signal connection.
     *
     * @param {object} callbacks see the module header
     */
    start(callbacks) {
        this._cb = callbacks || {};
        this._stopped = false;
        this._openWebsocket();
    }

    _openWebsocket() {
        if (this._stopped || !this._session)
            return;
        this._closeWebsocket();
        const message = Soup.Message.new('GET', this._wsUri());
        const cancellable = new Gio.Cancellable();
        this._wsCancellable = cancellable;
        this._session.websocket_connect_async(
            message,
            null,          // origin
            [],            // protocols
            0,             // io priority
            cancellable,
            (session, result) => {
                let ws;
                try {
                    ws = session.websocket_connect_finish(result);
                } catch (e) {
                    // Cancelled = superseded by a newer attempt or destroy();
                    // that attempt owns the state now, so do nothing here.
                    if (cancellable.is_cancelled() ||
                        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
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
                // Completed, but a newer attempt or destroy() raced us.
                if (cancellable !== this._wsCancellable || this._stopped) {
                    try {
                        ws.close(Soup.WebsocketCloseCode.NORMAL, null);
                    } catch { /* already gone */ }
                    return;
                }
                this._ws = ws;
                this._setAuthError(false);
                this._backoff = 1;
                this._setOnline(true);
                this._wsSignalIds = [
                    ws.connect('message', (_c, type, bytes) => {
                        if (type !== Soup.WebsocketDataType.TEXT)
                            return;
                        this._handleFrame(DECODER.decode(bytes.get_data()));
                    }),
                    ws.connect('closed', () => {
                        // Only the current socket may drive state; handlers
                        // of a replaced socket are disconnected beforehand.
                        this._disconnectWsSignals();
                        this._ws = null;
                        this._setOnline(false);
                        this._scheduleReconnect();
                    }),
                    ws.connect('error', () => {
                        this._setOnline(false);
                    })
                ];
            }
        );
    }

    _disconnectWsSignals() {
        if (this._ws) {
            for (const id of this._wsSignalIds)
                this._ws.disconnect(id);
        }
        this._wsSignalIds = [];
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
            // Disconnect first so the old socket's async 'closed' cannot
            // clobber a newer socket or schedule a duplicate reconnect.
            this._disconnectWsSignals();
            try {
                this._ws.close(Soup.WebsocketCloseCode.NORMAL, null);
            } catch { /* already gone */ }
            this._ws = null;
        }
    }

    /** HTTP GET returning parsed JSON, or null on any failure. Async/Promise. */
    async getJson(path) {
        if (!this._session)
            return null;
        const uri = this._withToken(`${this._base()}${path}`);
        const message = Soup.Message.new('GET', uri);
        return new Promise(resolve => {
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
        // Drop callbacks first: anything that completes during teardown
        // (cancelled reads, aborted requests) must not reach the indicator.
        this._cb = {};
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._ioCancellable?.cancel();
        this._ioCancellable = null;
        this._closeWebsocket();
        if (this._session) {
            try {
                this._session.abort();
            } catch { /* noop */ }
            this._session = null;
        }
    }
}

// Silence unused-import linters where ENCODER may be reserved for future sends.
void ENCODER;
