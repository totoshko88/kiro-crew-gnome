# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2]

### Fixed

- With several sessions open, the ghost and the menu dots tracked only the session whose main agent was mid-turn. A session counts as working the same way the dashboard sidebar counts it: its own turn, a staged plan, background subagents, or queued prompts. Amber means only that an agent is blocked on you (a question or a tool approval). The quick-reply suggestions an agent leaves after a finished turn don't count.
- The ghost and the menu dots use one rule, so the ghost's color is always the worst dot in the menu. An active session outside the recent list is pinned to the top of the menu, so the reason for the color is always visible.
- Untitled sessions in the menu show their live title (for example "New Session…") instead of the raw storage key.
- Left-click now jumps to the most recently active matching session. The gateway sends ISO timestamps, which the old numeric sort could not compare, so the pick was effectively arbitrary.

### Added

- **Stop gateway / Start gateway** in the menu, for a gateway on this machine. A service install (`kirocrew.service`, system or user unit) is controlled through systemd's D-Bus API, with GNOME's polkit password prompt for a system unit. A hand-run `kirocrew gateway` is stopped through its loopback-only `POST /api/shutdown`. If sessions are still working, you're asked to confirm first.
- New **stopped** state: a faded ghost with closed eyes, so a gateway you turned off on purpose no longer looks like a red outage. While it's stopped the extension stops reconnecting, hides Reconnect, and left-click opens the menu. It notices when the gateway is started outside the menu.
- **Gateway logs** menu item, which opens the dashboard's live log viewer.
- Short one-shot icon motion on state changes, modelled on the dashboard companion's moves: float when work starts, hop when an agent needs you, a small hop when work finishes, and a head shake on a problem. It respects GNOME's animation setting and never loops.

### Changed

- The "working" color is now Kiro purple (`#8e48ff`, the dashboard's accent) instead of blue, for the ghost and the menu dots.

### Security

- The extension can now change one thing: the gateway's running state, and only on an explicit menu action for a loopback endpoint. See [SECURITY.md](docs/SECURITY.md).

## [0.1.1]

Hotfix addressing the EGO review warnings plus lifecycle bugs found along the way.

### Fixed

- The local secret (`~/.kiro/crew/.local_secret`) is now read asynchronously, so the shell main loop never blocks on file IO (EGO-X-004).
- `disable()` now explicitly destroys and releases every object created in `enable()` (icon, header, session section, endpoint submenu, settings) and disconnects every signal it connected (EGO-L-002, EGO-L-003, EGO-L-005).
- Network replies that arrive after `disable()` no longer touch destroyed actors or released settings.
- Reconnecting (endpoint/token change, Reconnect) no longer races the previous WebSocket: its handlers are disconnected before closing, so it can't drop the new socket or schedule a duplicate reconnect. A cancelled handshake is no longer treated as a failure.
- Critical notifications keep working after the user dismisses them (the destroyed notification source is recreated).
- Critical notifications on GNOME 45, which uses the older positional MessageTray API.
- Changing the fallback poll interval in Settings now takes effect without re-enabling the extension.

### Changed

- The release zip no longer ships `schemas/gschemas.compiled`; GNOME 45+ compiles the schema on install (EGO-P-006).
- CI guards against synchronous file IO in shell code and a compiled schema in the zip; the release workflow fetches tags so the EGO version bump sees previous releases.

## [0.1.0]

### Added

- Top-bar ghost indicator for the local Kiro Crew gateway.
- Live icon color reflecting the aggregate agent state across all sessions: grey (idle), blue (busy), amber (needs attention — a question or an approval), red (problem or gateway offline), and dim red (access token expired). Priority: auth > error > attention > busy > idle.
- WebSocket transport (`/api/ws`) for live slot updates, with HTTP polling fallback (`/api/status`, `/api/sessions`) only while the socket is down.
- Left-click opens the most relevant session (problem, then question, then active), or the dashboard when everything is idle.
- Right-click menu listing up to 10 recent sessions with live status dots, an endpoint switcher, Reconnect, and Settings.
- Automatic token bootstrap: the extension fetches a short-lived token from the gateway's loopback-only `/api/token/local` endpoint on startup and when a token expires. You can also fetch or paste one manually in Settings.
- Adwaita preferences: gateway URL, access token, Fetch-token and Open-dashboard buttons, saved endpoints, browser choice, recent-session count, message previews, and the fallback poll interval.
- GSettings schema, four symbolic SVG state icons, and theme-aware CSS tints.

### Security

- Talks only to the local gateway over loopback, never calls a mutating endpoint, and never mints a credential through the security-gated path — only the sanctioned same-machine local bootstrap.
