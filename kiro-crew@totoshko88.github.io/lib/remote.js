/**
 * remote.js — runs the fixed SSH control commands of a remote profile
 * (remoteCommand() in profiles.js). Used by both the shell and prefs.
 *
 * Each call is one `ssh -n -T -o BatchMode=yes -- host <command>` subprocess,
 * spawned from an argv array. After destroy() pending calls reject with
 * G_IO_ERROR_CANCELLED and their ssh processes are killed.
 */

import Gio from 'gi://Gio';

import {isCancelled} from './cancel.js';
import {sshCommandArgv, parseProbe} from './profiles.js';

function lastLine(text) {
    const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(l => l);
    return lines.length ? lines[lines.length - 1] : '';
}

export class RemoteControl {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._procs = new Set();
        this._probing = null;
    }

    /**
     * Run one action on the profile's host.
     * @returns {Promise<{ok: boolean, stdout: string, error: string}>}
     */
    run(profile, action) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new([...sshCommandArgv(profile, action)],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                // ssh is not installed.
                resolve({ok: false, stdout: '', error: e.message});
                return;
            }
            this._procs.add(proc);
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                this._procs.delete(p);
                let stdout, stderr;
                try {
                    [, stdout, stderr] = p.communicate_utf8_finish(res);
                } catch (e) {
                    if (isCancelled(e))
                        reject(e);
                    else
                        resolve({ok: false, stdout: '', error: e.message});
                    return;
                }
                const ok = p.get_successful();
                resolve({
                    ok,
                    stdout: stdout ?? '',
                    error: ok ? '' : lastLine(stderr) || `ssh exited with status ${p.get_exit_status()}`
                });
            });
        });
    }

    /** Run an action that must succeed; rejects with ssh's last error line. */
    async runChecked(profile, action) {
        const r = await this.run(profile, action);
        if (!r.ok)
            throw new Error(r.error);
        return r.stdout;
    }

    /** Mint a token on the host's own loopback; resolves to the token or ''. */
    async fetchToken(profile) {
        const r = await this.run(profile, 'token');
        if (!r.ok)
            return '';
        try {
            const data = JSON.parse(r.stdout);
            return typeof data.token === 'string' ? data.token : '';
        } catch {
            return '';
        }
    }

    /**
     * kirocrew.service on the host as {loaded, active, port}, or null when
     * the host can't be reached. Overlapping callers share one ssh run.
     */
    probe(profile) {
        this._probing ??= this.run(profile, 'probe')
            .then(r => (r.ok ? parseProbe(r.stdout) : null))
            .finally(() => {
                this._probing = null;
            });
        return this._probing;
    }

    destroy() {
        this._cancellable.cancel();
        // Cancelling only stops the wait; the ssh processes must exit too.
        for (const p of this._procs)
            p.force_exit();
        this._procs.clear();
    }
}
