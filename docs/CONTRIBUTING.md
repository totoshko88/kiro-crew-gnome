# Contributing

Thank you for your interest in contributing!

## Quick Start

```bash
# Fork and clone
git clone https://github.com/YOUR-USERNAME/kiro-crew-gnome.git
cd kiro-crew-gnome

# Install for development
make install
gnome-extensions enable kiro-crew@totoshko88.github.io

# Run the pure-logic tests
make test-logic
```

## Guidelines

### Code Style

- 4 spaces indentation
- JSDoc comments for functions
- Run `npm run lint` before committing (ESLint flat config, GJS globals)

### Architecture

The code is split by the process it runs in, so a reviewer can see at a
glance what may import what:

| Directory | Runs in | May import |
|---|---|---|
| `shell/` | GNOME Shell only | St, Clutter, Shell UI; never GTK/Adw |
| `prefs/` | the preferences process only | GTK, Adw; never St/Clutter/Shell UI |
| `lib/` | both | Gio/GLib at most; no UI toolkit |

| File | Purpose |
|------|---------|
| `extension.js` | Entry point: `enable()` creates the indicator, `disable()` destroys it |
| `shell/indicator.js` | The panel button: icon state, session list, settings wiring, fallback poll |
| `shell/menu.js` | The popup menu (a view: holds no state) |
| `shell/connection.js` | The active profile's client, SSH tunnel, SSH control and token |
| `shell/lifecycle.js` | Stop / Start / Restart and the service state they depend on |
| `shell/updates.js` | Check for updates, Update, release channel |
| `shell/client.js` | Soup HTTP + WebSocket transport (auth, reconnect, local bootstrap) |
| `shell/service.js` | Local `kirocrew.service` over systemd D-Bus (state, port, stop/start) |
| `shell/tunnel.js` | The `ssh -N -L` process of a remote profile (start, backoff restart, stop) |
| `shell/notifier.js`, `shell/confirm.js` | Message-tray source; the "are you sure?" dialog |
| `shell/animator.js` | One-shot icon motion on state changes |
| `lib/state.js` | Pure reducer: slot list → aggregate indicator state |
| `lib/profiles.js` | Pure profile model: kinds, URLs, ssh argv, remote commands, migration |
| `lib/profileStore.js` | Profiles in GSettings (read, write, migrate) |
| `lib/remote.js` | Runs the fixed SSH control commands of a remote profile |
| `lib/cancel.js` | Cancellation helpers |
| `prefs.js` | Preferences window |
| `prefs/profiles.js` | Gateway profile editor |

### Key Principles

- All network I/O must be async (no blocking calls on the main loop)
- Clean up every resource in `disable()` (sources, signals, the WebSocket,
  subprocesses); the class that creates a resource destroys it
- No lifecycle flags such as `_destroyed`: every async operation takes its
  owner's `Gio.Cancellable`, so after `destroy()` it rejects with
  `G_IO_ERROR_CANCELLED` and no code runs past the `await`
  (`logUnlessCancelled()` keeps that silent)
- Respect the process split above (CI checks the imports)
- Follow the [EGO Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- Never mint credentials. The extension is read-only against the gateway; the
  only exceptions are user-initiated actions on a **local** profile:
  Stop/Start (systemd D-Bus, or `POST /api/shutdown` for a hand-run gateway),
  Restart, Update and the release-channel switch, and the same on a remote
  profile with SSH control. Any other remote profile is read-only, and the
  local secret is never sent to a remote gateway
- No local `sudo`; local privileged actions go through polkit. Subprocesses
  are only ssh: the tunnel (`shell/tunnel.js`) and, for a profile with SSH
  control, the fixed commands from `remoteCommand()` (`lib/profiles.js`, run by `lib/remote.js`). Always
  async `Gio.Subprocess` with an argv array (no local shell), killed on
  `disable()`. Remote command strings are built from constants and a parsed
  port only — never from profile text
- Stop/Start target `kirocrew.service` only when its port matches the
  profile's port
- Locality comes from the profile's kind, never from the URL: a tunnel also
  listens on `localhost`
- Animations must be finite (no continuous panel repaint) and respect
  `enable-animations`

## Pull Request Process

1. Create a feature branch from `main`
2. Make changes with clear commits
3. Run `make test-logic` and `bash tests/validate-review-guidelines.sh`
4. Submit the PR with a description

### Commit Format

```
Short summary (50 chars)

Detailed explanation if needed.
- Use present tense
- Reference issues: "Fixes #123"
```

## Testing

```bash
make test-logic                           # pure-gjs state reducer tests
bash tests/validate-review-guidelines.sh  # EGO guideline check
```

## Areas for Contribution

- 🌍 Translations
- 📝 Documentation
- 🐛 Bug fixes
- ✨ New features (discuss first)

## Questions?

Open an issue or email totoshko88@gmail.com

---

By contributing, you agree to license your work under GPL-2.0-or-later.
