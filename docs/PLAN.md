# Kiro Crew — GNOME Shell Extension

A top-bar (tray) indicator for the local [Kiro Crew](https://github.com/kirodotdev/kirocrew)
gateway. Shows a status icon that changes color with live agent activity, and a
dropdown of recent sessions. One click opens the dashboard in the browser.

## Target

- GNOME Shell **45–50** (ESM, `Extension` base class). Developed on Shell 50.1 / gjs 1.88.
- UUID: `kiro-crew@totoshko88.github.io`
- No external npm/node deps — pure GJS using platform GIR libraries
  (`St`, `Gio`, `GLib`, `Soup` 3, `Clutter`, GTK4/Adwaita for prefs).

## Gateway API (verified against kiro_crew source)

Base URL default: `http://localhost:5476`.

**Auth:** every endpoint (even on loopback) requires a token, passed as
`?token=<T>` query param or cookie `mc_token_<port>`. The extension CANNOT mint a
token itself (`kirocrew token` is a credential-mint surface, security-gated). The
user pastes a token into extension Settings; the extension appends `?token=` to
all requests and to the dashboard URL it opens.

**Live state — WebSocket `GET /api/ws?token=<T>`:** primary source. Frame
`{"type":"slots","data":[ slot, … ]}`. Per-slot fields that drive the icon:

| field | meaning |
|---|---|
| `running` | a turn is executing |
| `pending_approval` + `pending_approval_info` | waiting for the user to approve a tool call |
| `needs_input` | the agent asked the user a question |
| `wait_state`, `stopping`, `stop_state` | transient lifecycle |
| `mcp_report` | MCP report payload (may carry an error) |
| `tags` | board tags (`planned/todo/review/done`, + custom) |
| `key`, `title`, `agent`, `linked_session_key`, `last_turn_ts` | identity / routing |

Also delivered over WS: `{"type":"notification", …}` (priority
`critical`/`default`/`passive`).

**Recent sessions — `GET /api/sessions?limit=10&preview=1`:** returns
`{sessions:[{key,title,preview,…}], total, has_more}`. Historical session files
(metadata), NOT live state — the menu cross-references live `slots` by `key` for
each row's status dot.

**System — `GET /api/status`:** uptime, memory, cron, session/subagent counts.
Used for the online/offline health check and the fallback poll.

**Notifications — `GET /api/notifications`:** fallback for `critical` signals.

## Icon state machine

Aggregate every live slot into ONE indicator state. Priority (highest wins):

| state | color | condition | left-click target |
|---|---|---|---|
| `error` | red | gateway offline, OR a `critical` notification, OR any slot `mcp_report` carries an error | problem session, else dashboard |
| `attention` | yellow | any slot `needs_input` or `pending_approval` | that session |
| `busy` | blue | any slot `running` | most-recently-active session |
| `idle` | normal/grey | gateway online, all slots idle | dashboard home |

Priority: `error` > `attention` > `busy` > `idle`.

## Settings (GSettings schema `org.gnome.shell.extensions.kiro-crew`)

- `endpoint` (string, default `http://localhost:5476`) — current gateway base URL.
- `endpoints` (string array) — saved endpoints/ports the user can switch between.
- `token` (string) — dashboard access token (pasted by the user).
- `browser` (string, default `""`) — `.desktop` id of the browser to open, or
  empty = system default (`Gio.AppInfo.launch_default_for_uri`).
- `max-sessions` (int, default 10, max 10) — rows in the session submenu.
- `show-previews` (bool, default true).

## Menu layout

```
● Kiro Crew — <state>              (header: status + current endpoint)
──────────────────────────────────
  <session title 1>   ● (status dot)
  <session title 2>   ●
  … up to max-sessions …
──────────────────────────────────
  Open dashboard                   (opens endpoint?token= in browser)
  Endpoint ▸  [ localhost:5476 ✓ ] (submenu to switch saved endpoints)
  Reconnect
  Settings
```

## Phases

1. **Scaffold + icon + open** — files, `PanelMenu.Button`, static icon, left-click
   opens dashboard; prefs window with endpoint/token/browser; GSettings schema.
2. **Live status + color** — Soup WebSocket client, slot aggregation → icon state,
   reconnect with backoff, offline detection.
3. **Session submenu** — fetch recent sessions, render up to N with live status
   dots, click opens that session.
4. **Polish** — Shell notification on `critical`, multi-endpoint switcher, README,
   LICENSE, i18n scaffold, packaging (`gnome-extensions pack`).

## File layout

```
kiro-crew@totoshko88.github.io/
  metadata.json
  extension.js            # indicator, menu, lifecycle
  prefs.js                # Adwaita preferences
  stylesheet.css          # status colors
  lib/
    client.js             # Soup HTTP + WebSocket, auth, reconnect
    state.js              # slot → aggregate icon state
  schemas/
    org.gnome.shell.extensions.kiro-crew.gschema.xml
  icons/
    kiro-crew-idle-symbolic.svg
    kiro-crew-busy-symbolic.svg
    kiro-crew-attention-symbolic.svg
    kiro-crew-error-symbolic.svg
Makefile                  # build / install / pack
README.md
LICENSE
```

## Non-goals (v1)

- Minting tokens, writing gateway config, or any mutating API call.
- Embedding a web view (we open the system browser).
- Bundling the kiro_crew backend.
