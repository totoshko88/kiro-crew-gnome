/**
 * tunnel.js — keeps the SSH tunnel of a remote profile open.
 *
 * Owns one `ssh -N -L 127.0.0.1:<local>:localhost:<port> <host>` process:
 * starts it, restarts it with backoff when it exits, kills it on stop(). The
 * local port is re-picked on every start (see pickTunnelPort), so it never
 * shadows a gateway on this computer that uses the same port number.
 *
 * States: 'idle' (no tunnel wanted), 'running' (ssh is up on `port`),
 * 'down' (ssh exited with `error`; a retry is scheduled).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isCancelled} from '../lib/cancel.js';
import {sshArgv, pickTunnelPort} from '../lib/profiles.js';

const RETRY_MIN_S = 2;
const RETRY_MAX_S = 60;
// An ssh that stayed up this long was working: retry fast after it drops.
const STABLE_S = 30;

function lastLine(text) {
    const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(l => l);
    return lines.length ? lines[lines.length - 1] : '';
}

/** Can a listener bind 127.0.0.1:port right now? */
function isPortFree(port) {
    const sock = Gio.Socket.new(Gio.SocketFamily.IPV4,
        Gio.SocketType.STREAM, Gio.SocketProtocol.TCP);
    try {
        // allow_reuse like ssh's own listener: TIME_WAIT leftovers count as free.
        sock.bind(Gio.InetSocketAddress.new_from_string('127.0.0.1', port), true);
        return true;
    } catch {
        return false;
    } finally {
        sock.close();
    }
}

export class SshTunnel {
    /** @param {(state: string, error: string) => void} onStateChanged */
    constructor(onStateChanged) {
        this._onStateChanged = onStateChanged;
        this._profile = null;
        this._reserved = new Set();
        this._port = 0;
        this._proc = null;
        this._cancellable = null;
        this._retryId = 0;
        this._backoff = RETRY_MIN_S;
        this._startedAt = 0;
        this._state = 'idle';
        this._error = '';
    }

    get state() {
        return this._state;
    }

    get error() {
        return this._error;
    }

    /** The tunnel's local port while it is running, else 0. */
    get port() {
        return this._state === 'running' ? this._port : 0;
    }

    /**
     * @param {object} profile a normalized remote profile
     * @param {Set<number>} reserved ports of the gateways on this computer
     */
    start(profile, reserved) {
        this.stop();
        this._profile = profile;
        this._reserved = reserved;
        this._backoff = RETRY_MIN_S;
        this._spawn();
    }

    stop() {
        this._profile = null;
        this._cancelRetry();
        this._kill();
        this._port = 0;
        this._setState('idle', '');
    }

    _spawn() {
        const port = pickTunnelPort(Number(this._profile.port), this._reserved, isPortFree);
        if (port === null) {
            this._setState('down', 'No free local port for the SSH tunnel');
            this._scheduleRetry();
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new([...sshArgv(this._profile, port)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            // ssh is not installed.
            this._setState('down', e.message);
            this._scheduleRetry();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._proc = proc;
        this._cancellable = cancellable;
        this._port = port;
        this._startedAt = GLib.get_monotonic_time();
        this._setState('running', '');
        // Completes only when ssh exits.
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            let stderr = '';
            try {
                [, , stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                // Cancelled by stop(), which already reset the state.
                if (isCancelled(e))
                    return;
            }
            this._proc = null;
            this._cancellable = null;
            if ((GLib.get_monotonic_time() - this._startedAt) / 1e6 >= STABLE_S)
                this._backoff = RETRY_MIN_S;
            this._setState('down', lastLine(stderr) || `ssh exited with status ${p.get_exit_status()}`);
            this._scheduleRetry();
        });
    }

    _scheduleRetry() {
        this._cancelRetry();
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._backoff, () => {
            this._retryId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
        this._backoff = Math.min(this._backoff * 2, RETRY_MAX_S);
    }

    _cancelRetry() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
    }

    _kill() {
        if (this._proc) {
            this._cancellable.cancel();
            this._proc.force_exit();
            this._proc = null;
            this._cancellable = null;
        }
    }

    _setState(state, error) {
        if (state === this._state && error === this._error)
            return;
        this._state = state;
        this._error = error;
        this._onStateChanged(state, error);
    }

    destroy() {
        this._onStateChanged = () => {};
        this.stop();
    }
}
