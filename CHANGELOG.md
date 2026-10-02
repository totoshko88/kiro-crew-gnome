# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

### Added

- Top-bar indicator for the local Kiro Crew gateway.
- Live icon color reflecting aggregated agent state: idle, busy, needs
  attention (question / approval), and problem (critical notification or
  gateway offline). Priority: error > attention > busy > idle.
- WebSocket transport (`/api/ws`) for live slot updates, with HTTP polling
  fallback (`/api/status`, `/api/sessions`) when the socket drops.
- Left-click opens the most relevant session (problem > question > active),
  otherwise the dashboard; right-click opens a menu listing up to 10 recent
  sessions with live status dots, an endpoint switcher, Reconnect, and
  Settings.
- Adwaita preferences: endpoint URL, access token, saved endpoints, browser
  choice, session count, preview toggle, and poll interval.
- Token is entered manually by the user; the extension never mints
  credentials and never calls a mutating gateway endpoint.
- GSettings schema, four symbolic SVG state icons, and theme-aware CSS tints.
