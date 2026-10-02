# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
