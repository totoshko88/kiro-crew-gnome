/**
 * localBootstrap.js — the requests that carry this computer's local secret
 * (~/.kiro/crew/.local_secret): minting a dashboard token and shutting down a
 * hand-run gateway. Used by both the shell and prefs.
 *
 * The secret goes to the gateway's owner-only unix socket
 * (~/.kiro/crew/dashboard-<port>.sock). Only a process of this user can create
 * it in that 0700 directory, so another local user listening on the port while
 * the gateway is down never receives the secret. A gateway too old to have the
 * socket is reached on 127.0.0.1, never "localhost", which may resolve to ::1.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {isCancelled} from './cancel.js';

const DECODER = new TextDecoder('utf-8');

function crewPath(name) {
    return GLib.build_filenamev([GLib.get_home_dir(), '.kiro', 'crew', name]);
}

export class LocalBootstrap {
    constructor() {
        this._cancellable = new Gio.Cancellable();
    }

    /** Mint a dashboard token; resolves to the token, or '' when refused. */
    async fetchToken(port) {
        const {status, text} = await this._send(port, 'GET', '/api/token/local');
        if (status !== Soup.Status.OK)
            return '';
        try {
            const data = JSON.parse(text);
            return typeof data.token === 'string' ? data.token : '';
        } catch {
            return '';
        }
    }

    /** Shut down a hand-run gateway (no service manager to ask). */
    async shutdown(port) {
        const {status} = await this._send(port, 'POST', '/api/shutdown');
        return status >= 200 && status < 300;
    }

    /** Network errors and a missing secret resolve to status 0; cancellation rejects. */
    async _send(port, method, path) {
        const secret = await this._readSecret();
        if (!secret)
            return {status: 0, text: ''};
        const socketPath = crewPath(`dashboard-${port}.sock`);
        const viaSocket = await this._isSocket(socketPath);
        const session = viaSocket
            ? new Soup.Session({timeout: 10, remote_connectable: Gio.UnixSocketAddress.new(socketPath)})
            : new Soup.Session({timeout: 10});
        // With remote_connectable set, the URL only names the Host header.
        const message = Soup.Message.new(method, `http://${viaSocket ? 'localhost' : `127.0.0.1:${port}`}${path}`);
        message.get_request_headers().append('X-Local-Secret', secret);
        return new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    resolve({status: message.get_status(), text: DECODER.decode(bytes.get_data() ?? new Uint8Array())});
                } catch (e) {
                    if (isCancelled(e))
                        reject(e);
                    else
                        resolve({status: 0, text: ''});
                }
            });
        });
    }

    _readSecret() {
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path(crewPath('.local_secret')).load_contents_async(this._cancellable, (f, res) => {
                try {
                    resolve(DECODER.decode(f.load_contents_finish(res)[1]).trim());
                } catch (e) {
                    if (isCancelled(e))
                        reject(e);
                    else
                        resolve('');
                }
            });
        });
    }

    _isSocket(path) {
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
                    try {
                        resolve(f.query_info_finish(res).get_file_type() === Gio.FileType.SPECIAL);
                    } catch (e) {
                        if (isCancelled(e))
                            reject(e);
                        else
                            resolve(false);
                    }
                });
        });
    }

    destroy() {
        this._cancellable.cancel();
    }
}
