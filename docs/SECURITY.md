# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Security Measures

This extension implements several security measures:

- **Read-only by default**: The extension reads gateway state (status,
  sessions, live slot updates). The one exception is the gateway's lifecycle,
  and only on an explicit menu action:
  - **Stop / Start gateway** for a service install drives `kirocrew.service`
    through systemd's D-Bus API (`StopUnit` / `StartUnit`). For a system unit
    systemd checks polkit (`org.freedesktop.systemd1.manage-units`), so GNOME
    asks for an administrator password; the extension holds no privilege of
    its own and runs no subprocess or `sudo`.
  - **Stop gateway** for a hand-run gateway calls `POST /api/shutdown`, which
    the gateway accepts only from loopback with the per-user local secret.
  - Both are offered only for a loopback endpoint, never for a remote gateway.
  It calls no other mutating endpoint.
- **Never mints credentials**: Token creation is a security-gated surface on the
  gateway; the extension cannot and does not create tokens. You paste an existing
  token into Settings.
- **Token stored in GSettings, never logged**: The access token is kept in the
  extension's GSettings and is never written to the journal or any log.
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

Out of scope:
- Kiro Crew gateway vulnerabilities (report to the gateway project)
- GNOME Shell vulnerabilities (report to GNOME)
