/**
 * client.js — HTTP and WebSocket transport to one Kiro Crew gateway.
 *
 * Live slot and notification frames arrive over /api/ws; everything else is a
 * one-shot HTTP call. Every pending request is tied to one Gio.Cancellable:
 * after destroy() its promise rejects with G_IO_ERROR_CANCELLED, so no caller
 * code runs past the await.
 *
 * Auth (gateway 0.11+): the access token is a short-lived bearer credential
 * sent once as a `?token=` query parameter. The gateway exchanges it for an
 * HttpOnly session cookie (`mc_token_<port>`) that rides a far longer
 * `session_exp`, and from then on every request authenticates by that cookie.
 * A Soup.CookieJar on the session stores and resends it (over HTTP and the
 * WebSocket handshake alike), so the connection no longer dies when the short
 * `exp` lapses. The token is still appended to every URL: it is ignored once
 * the cookie is valid and re-seeds the session if the cookie was lost.
 */

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {isCancelled} from '../lib/cancel.js';
import {refreshDelaySecs} from '../lib/token.js';

const DECODER = new TextDecoder('utf-8');
const ENCODER = new TextEncoder();
const BACKOFF_MAX_S = 30;

export class GatewayClient {
    /**
     * @param {() => {endpoint: string, token: string}} getConfig read on every
     *   request, so a profile switch applies to the next one
     */
    constructor(getConfig) {
        this._getConfig = getConfig;
        this._session = new Soup.Session({timeout: 10});
        // Keep the session cookie the gateway hands back for the short-lived
        // query token, so auth survives that token's `exp` (gateway 0.11+).
        this._cookies = new Soup.CookieJar();
        this._session.add_feature(this._cookies);
        this._cancellable = new Gio.Cancellable();
        this._ws = null;
        this._wsSignalIds = [];
        this._wsCancellable = null;
        this._reconnectId = 0;
        this._refreshId = 0;
        this._backoff = 1;
        this._online = false;
        this._authError = false;
        // A gateway stopped on purpose: keep the socket closed instead of
        // retrying against a port nobody listens on.
        this._paused = false;
        this._cb = null;
    }

    /**
     * @param {object} callbacks onSlots(slots), onNotification(note),
     *   onStatus(status) (the periodic "dashboard" frame),
     *   onUpdateProgress({step, detail}), onOnline(bool), onAuthError(bool)
     */
    start(callbacks) {
        this._cb = callbacks;
        this._openWebsocket();
    }

    get online() {
        return this._online;
    }

    get authError() {
        return this._authError;
    }

    get paused() {
        return this._paused;
    }

    reconnectNow() {
        this._backoff = 1;
        this._cancelReconnect();
        this._openWebsocket();
    }

    /**
     * Forget the session cookie. Called when the gateway changes under us (a
     * profile switch) or a fresh token is adopted, so a cookie minted for the
     * old credential can't shadow the new query token on the next exchange.
     */
    clearSession() {
        for (const cookie of this._cookies.all_cookies())
            this._cookies.delete_cookie(cookie);
    }

    pause() {
        if (this._paused)
            return;
        this._paused = true;
        this._cancelReconnect();
        this._cancelRefresh();
        this._closeWebsocket();
        this._setOnline(false);
    }

    resume() {
        if (!this._paused)
            return;
        this._paused = false;
        this.reconnectNow();
    }

    // ---- HTTP ------------------------------------------------------------

    fetchStatus() {
        return this._json('GET', '/api/status');
    }

    fetchSessions(limit, preview) {
        return this._json('GET', `/api/sessions?limit=${limit}${preview ? '&preview=1' : ''}`);
    }

    fetchUpdateCheck() {
        return this._json('GET', '/api/update/check');
    }

    applyUpdate() {
        return this._json('POST', '/api/update', {});
    }

    switchChannel(channel) {
        return this._json('POST', '/api/update/channel', {channel});
    }

    /** Mark one notification read, by its `ts`, as the dashboard's bell does. */
    async ackNotification(ts) {
        return await this._json('POST', '/api/notifications/ack', {ts}) !== null;
    }

    async restart() {
        return await this._json('POST', '/api/restart', {}) !== null;
    }

    _base() {
        return this._getConfig().endpoint.replace(/\/+$/, '');
    }

    _withToken(url) {
        const {token} = this._getConfig();
        if (!token)
            return url;
        return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    }

    /** Send a message; network errors resolve to status 0, cancellation rejects. */
    _send(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        resolve({
                            status: message.get_status(),
                            text: DECODER.decode(bytes.get_data() ?? new Uint8Array())
                        });
                    } catch (e) {
                        if (isCancelled(e))
                            reject(e);
                        else
                            resolve({status: 0, text: ''});
                    }
                });
        });
    }

    /** Token-authenticated JSON call; resolves to the parsed reply or null. */
    async _json(method, path, body = null) {
        const message = Soup.Message.new(method, this._withToken(`${this._base()}${path}`));
        if (body !== null) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(ENCODER.encode(JSON.stringify(body))));
        }
        const {status, text} = await this._send(message);
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
            this._setAuthError(true);
            return null;
        }
        if (status < 200 || status >= 300)
            return null;
        this._setAuthError(false);
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return null;
        }
    }

    // ---- WebSocket -------------------------------------------------------

    _wsUri() {
        return this._withToken(`${this._base().replace(/^http/, 'ws')}/api/ws`);
    }

    _setOnline(online) {
        if (online === this._online)
            return;
        this._online = online;
        this._cb.onOnline(online);
    }

    _setAuthError(bad) {
        if (bad === this._authError)
            return;
        this._authError = bad;
        this._cb.onAuthError(bad);
    }

    _openWebsocket() {
        if (this._paused)
            return;
        this._cancelRefresh();
        this._closeWebsocket();
        const message = Soup.Message.new('GET', this._wsUri());
        const cancellable = new Gio.Cancellable();
        this._wsCancellable = cancellable;
        this._session.websocket_connect_async(message, null, [], GLib.PRIORITY_DEFAULT, cancellable,
            (session, result) => {
                let ws;
                try {
                    ws = session.websocket_connect_finish(result);
                } catch (e) {
                    // Cancelled: a newer attempt or destroy() owns the state now.
                    if (isCancelled(e))
                        return;
                    // 401/403 on the handshake is a bad token, not a dead gateway.
                    const status = message.get_status();
                    this._setAuthError(status === Soup.Status.UNAUTHORIZED ||
                        status === Soup.Status.FORBIDDEN);
                    this._setOnline(false);
                    this._scheduleReconnect();
                    return;
                }
                // Finished just as a newer attempt or destroy() cancelled it.
                if (cancellable.is_cancelled()) {
                    ws.close(Soup.WebsocketCloseCode.NORMAL, null);
                    return;
                }
                this._wsCancellable = null;
                this._ws = ws;
                this._backoff = 1;
                this._setAuthError(false);
                this._setOnline(true);
                this._scheduleRefresh();
                this._wsSignalIds = [
                    ws.connect('message', (_c, type, bytes) => {
                        if (type === Soup.WebsocketDataType.TEXT)
                            this._handleFrame(DECODER.decode(bytes.get_data()));
                    }),
                    ws.connect('closed', () => {
                        this._disconnectWsSignals();
                        this._ws = null;
                        this._cancelRefresh();
                        this._setOnline(false);
                        this._scheduleReconnect();
                    }),
                    ws.connect('error', () => this._setOnline(false))
                ];
            });
    }

    _handleFrame(text) {
        let frame;
        try {
            frame = JSON.parse(text);
        } catch {
            return;
        }
        if (frame.type === 'slots') {
            this._cb.onSlots(Array.isArray(frame.data) ? frame.data : []);
            return;
        }
        if (!frame.data || typeof frame.data !== 'object')
            return;
        if (frame.type === 'notification')
            this._cb.onNotification(frame.data);
        else if (frame.type === 'dashboard')
            this._cb.onStatus(frame.data);
        else if (frame.type === 'update_progress')
            this._cb.onUpdateProgress(frame.data);
    }

    _scheduleReconnect() {
        if (this._paused || this._reconnectId)
            return;
        const delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_S);
        this._reconnectId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectId = 0;
            this._openWebsocket();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelReconnect() {
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
    }

    /**
     * Refresh the session cookie a little before the short query token's `exp`,
     * so the gateway renews the cookie while the token can still be exchanged —
     * instead of waiting for a 403 after it lapses. A cheap authenticated GET
     * carrying the query token re-runs the token→cookie exchange and extends
     * the cookie's lifetime without disturbing the live WebSocket. Armed on a
     * successful connect, re-armed after each refresh, cancelled on close.
     */
    _scheduleRefresh() {
        this._cancelRefresh();
        const {token} = this._getConfig();
        if (!token)
            return;
        const delay = Math.round(refreshDelaySecs(token, Date.now()));
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._refreshId = 0;
            this._refreshSession();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    /** One refresh ping, then arm the next — only while connected. */
    _refreshSession() {
        if (this._paused || !this._online)
            return;
        // fetchStatus() carries the query token; a 2xx renews the cookie, a
        // 401/403 flips authError and the normal reconnect/mint path recovers.
        this.fetchStatus()
            .then(() => {
                if (this._online && !this._paused)
                    this._scheduleRefresh();
            })
            .catch(() => {});
    }

    _disconnectWsSignals() {
        for (const id of this._wsSignalIds)
            this._ws.disconnect(id);
        this._wsSignalIds = [];
    }

    _closeWebsocket() {
        if (this._wsCancellable) {
            this._wsCancellable.cancel();
            this._wsCancellable = null;
        }
        if (this._ws) {
            // Disconnect first so the old socket's 'closed' can't schedule a
            // reconnect over the socket that replaces it.
            this._disconnectWsSignals();
            if (this._ws.get_state() === Soup.WebsocketState.OPEN)
                this._ws.close(Soup.WebsocketCloseCode.NORMAL, null);
            this._ws = null;
        }
    }

    destroy() {
        this._cancelReconnect();
        this._cancelRefresh();
        this._closeWebsocket();
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
        this._cb = null;
    }
}
