# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Security Measures

This extension implements several security measures:

- **Read-only by default**: The extension reads gateway state (status,
  sessions, live slot updates, and the gateway's own update check). The
  exceptions all change only the gateway's own running state or update
  settings, each gated behind an explicit menu or Settings action for a
  **local** profile (the gateway on this computer):
  - **Stop / Start gateway** for a service install drives `kirocrew.service`
    through systemd's D-Bus API (`StopUnit` / `StartUnit`). For a system unit
    systemd checks polkit (`org.freedesktop.systemd1.manage-units`), so GNOME
    asks for an administrator password; the extension holds no privilege of
    its own and runs no subprocess or `sudo`.
  - **Stop gateway** for a hand-run gateway calls `POST /api/shutdown`, which
    the gateway accepts only with the per-user local secret (see below for
    how the secret is sent).
  - **Restart gateway** calls the gateway's own in-place restart
    (`POST /api/restart`) with the dashboard token.
  - **Update** asks the gateway to apply an update it manages
    (`POST /api/update`). For an install the gateway can't update in place
    (a `cli.sh` or pipx install), the extension runs no installer: it shows
    the command the gateway names for that install
    (`remediation.command` of `GET /api/update/check`) in a dialog, and
    writes it to the clipboard only when you press **Copy command**. You run
    it in your own terminal. Without such a command it opens the dashboard's
    About page. The clipboard is never read.
  - **Release channel** switch calls `POST /api/update/channel` with the
    dashboard token.
  - **Clicking a desktop notification** marks that one note read
    (`POST /api/notifications/ack` with its `ts`), on the gateway that sent
    it. Nothing else about the note changes.
  - Every one is offered only for a local profile, and none runs a
    subprocess. "Local" is the profile's kind, not its URL: an SSH tunnel also
    listens on `localhost`, so a URL check would aim these actions at the wrong
    gateway.
- **Remote gateways are reached over SSH, read-only unless you opt in**: a
  remote profile gets no gateway control by default, and the extension never
  sends this computer's local secret (`~/.kiro/crew/.local_secret`) to it. For
  a remote host the extension runs the tunnel as a long-lived subprocess:
  `ssh -N -n -o BatchMode=yes -o ExitOnForwardFailure=yes -L
  127.0.0.1:<local>:localhost:<port> -- <host>`. `<local>` is picked
  automatically and is never the port of a gateway on this computer, so a
  tunnel can't stand in for the local gateway; the client reaches it on
  `127.0.0.1` explicitly.
  - It is an argv array passed to `Gio.Subprocess` — no shell, so nothing in
    a profile can be interpreted as a command. The host is validated (it must
    start with a letter or digit, so it can't be read as an ssh option) and
    follows `--`.
  - The forward binds `127.0.0.1` only; the remote gateway is never exposed
    on your LAN.
  - `BatchMode` means key-based login only; the extension never handles a
    password or a passphrase. Your own `~/.ssh/config`, keys and `known_hosts`
    apply as usual.
  - The process is killed on a profile switch and on `disable()`.
- **SSH control is opt-in per profile** (**Allow control over SSH**). It then
  runs short `ssh -n -T -o BatchMode=yes -o ConnectTimeout=10 -- <host>
  <command>` subprocesses, where `<command>` is one of a fixed set built from
  constants and the profile's validated port number — never text from a
  profile field — because ssh passes it to the remote login shell as a string:
  the token bootstrap on the host's own loopback (its secret is read and used
  on the host and never comes back), `systemctl show kirocrew.service`,
  `sudo -n systemctl stop|start|restart kirocrew.service`, and
  `kirocrew update`. `sudo -n` never prompts; without passwordless sudo those
  actions just fail. In-flight commands are killed on `disable()`.
- **Service control is tied to the port**: Stop/Start drive `kirocrew.service`
  (local over D-Bus, remote over SSH) only when the unit listens on the
  profile's port, so a profile for one gateway can never stop another.
- **Tokens come only from the local bootstrap or a paste**: the extension
  never uses the gateway's security-gated token creation. For a local profile
  it calls `GET /api/token/local` with the local secret; you can also paste a
  token in Settings.
- **The local secret reaches only this user's gateway**: requests carrying
  `~/.kiro/crew/.local_secret` (the token bootstrap and the hand-run Stop) go
  to the gateway's unix socket `~/.kiro/crew/dashboard-<port>.sock`. Only a
  process of this user can create it in that `0700` directory, so another
  local user listening on the gateway's port while it is down never receives
  the secret. A gateway too old to have the socket is reached on
  `127.0.0.1`, never `localhost`, which may resolve to `::1`.
- **Tokens stored in GSettings, never logged**: Access tokens are kept in the
  extension's GSettings and are never written to the journal or any log. Each
  gateway issues its own token, so each profile stores its own (the `profiles`
  key); a token is only ever sent to the gateway of the profile it belongs to.
- **No telemetry**: No user data is collected or transmitted anywhere.
- **Async network I/O**: All HTTP/WebSocket calls are asynchronous; no blocking
  operations run on the GNOME Shell main loop.

## Reporting a Vulnerability

If you discover a security vulnerability:

1. **Do NOT** open a public issue
2. Email: totoshko88@gmail.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

You can expect:
- Acknowledgment within 48 hours
- Status update within 7 days
- Credit in release notes (if desired)

## Scope

Security issues in scope:
- Credential (token) exposure or logging
- Leakage of gateway session data
- Any path that could cause the extension to call a mutating endpoint, or to
  stop/start the gateway, without an explicit user action
- Any path that sends the local secret to a remote gateway, runs a command
  other than the documented ssh tunnel, or exposes a tunnel beyond `127.0.0.1`

Out of scope:
- Kiro Crew gateway vulnerabilities (report to the gateway project)
- GNOME Shell vulnerabilities (report to GNOME)
