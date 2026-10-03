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

| File | Purpose |
|------|---------|
| `kiro-crew@totoshko88.github.io/extension.js` | Lifecycle, top-bar indicator, and menu |
| `kiro-crew@totoshko88.github.io/lib/client.js` | Soup HTTP + WebSocket client (auth, reconnect) |
| `kiro-crew@totoshko88.github.io/lib/service.js` | `kirocrew.service` state and Stop/Start over systemd D-Bus |
| `kiro-crew@totoshko88.github.io/lib/animator.js` | One-shot icon motion on state changes |
| `kiro-crew@totoshko88.github.io/lib/state.js` | Pure reducer: slot list → aggregate indicator state |
| `kiro-crew@totoshko88.github.io/prefs.js` | Adwaita preferences (gateway URL, token) |

### Key Principles

- All network I/O must be async (no blocking calls on the main loop)
- Clean up every resource in `disable()` (sources, signals, the WebSocket)
- No GTK/Adw imports in `extension.js` (it runs in the Shell process)
- Follow the [EGO Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- Never mint credentials. The extension is read-only against the gateway; the
  only exception is the user-initiated Stop/Start of a loopback gateway
  (systemd D-Bus, or `POST /api/shutdown` for a hand-run gateway)
- No subprocesses or `sudo`; privileged actions go through polkit
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
