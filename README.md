# Kiro Crew — GNOME Shell Extension

A top-bar indicator for the local [Kiro Crew](https://github.com/kirodotdev/kirocrew)
gateway. The icon changes color with live agent activity, lists recent sessions,
and opens the dashboard in your browser with one click.

![states](docs/states.png)

## Status colors

| Icon | State | Meaning |
|------|-------|---------|
| grey | idle | Gateway online, nothing running |
| blue | busy | An agent turn is running |
| amber | attention | An agent asked a question or is waiting for tool approval |
| red | problem / offline | A critical notification, an MCP error, or the gateway is unreachable |

Left-click the icon to jump straight to the most relevant session (the one that
needs attention, has a problem, or is active) — or the dashboard home when idle.
Right-click opens the menu with recent sessions and settings.

## Requirements

- GNOME Shell 45–50.
- A running Kiro Crew gateway (default `http://localhost:5476`).
- An access **token**. The extension cannot create one (that surface is
  security-gated); copy a token from your dashboard and paste it in the
  extension's Settings.

## Install (from source)

```sh
git clone https://github.com/totoshko88/kiro-crew-gnome
cd kiro-crew-gnome
make install
# Wayland: log out and back in. X11: Alt+F2, type 'r', Enter.
gnome-extensions enable kiro-crew@totoshko88.github.io
```

Then open **Extensions → Kiro Crew → Settings**, set the gateway URL and paste
your token.

## Development

```sh
make schemas          # compile the GSettings schema in place
make test             # nested Wayland shell (Shell 48 and earlier use --nested)
journalctl -f -o cat /usr/bin/gnome-shell   # watch logs
```

### Layout

```
kiro-crew@totoshko88.github.io/
  extension.js   indicator, menu, lifecycle
  prefs.js       Adwaita preferences
  lib/client.js  Soup HTTP + WebSocket client (auth, reconnect)
  lib/state.js   slot list → aggregate icon state (pure, testable)
  schemas/       GSettings schema
  icons/         four symbolic states
  stylesheet.css status tints
```

## How it reads the gateway

- **Live state** — WebSocket `GET /api/ws?token=…`, frame `type:"slots"`. Each
  slot's `running` / `pending_approval` / `needs_input` / `mcp_report` fields are
  reduced to one indicator state (see `lib/state.js`).
- **Recent sessions** — `GET /api/sessions?limit=N&preview=1`.
- **Health / fallback** — `GET /api/status` polled only while the WebSocket is
  down.

The extension never calls a mutating endpoint and never mints credentials.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
