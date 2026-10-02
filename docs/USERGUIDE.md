<p align="center">
  <img src="logo.png" alt="Kiro Crew logo" width="96">
</p>

# Kiro Crew — User Guide

A top-bar ghost that shows what your whole Kiro Crew is doing and takes you to the session that needs you. This guide takes you from nothing to a working, glowing ghost, and explains every button along the way.

---

## 1. Before you start

You need **two** things:

1. **Kiro Crew itself**, running on this machine. It's the open-source agent
   workspace this extension controls. If you don't have it yet:

   ```bash
   curl -fsSL https://download.crew.kiro.dev/cli.sh | sh
   kirocrew gateway
   ```

   The gateway should now answer at `http://localhost:5476`. Open that in a
   browser once to confirm it loads.

2. **GNOME Shell 45 to 50.** Check with:

   ```bash
   gnome-shell --version
   ```

If both are true, you're ready.

---

## 2. Install the extension

### Option A — from GNOME Extensions (easiest)

Open the extension page and toggle it on:

**[→ extensions.gnome.org/extension/11123/kiro-crew](https://extensions.gnome.org/extension/11123/kiro-crew/)**

That's the whole install. Skip to step 3.

### Option B — from source

```bash
git clone https://github.com/totoshko88/kiro-crew-gnome
cd kiro-crew-gnome
make install
```

`make install` compiles the settings schema and copies the extension into `~/.local/share/gnome-shell/extensions/`.

Now GNOME has to **reload its extension list**:

- **Wayland** (most modern setups): log out and log back in. There is no
  in-place reload on Wayland.
- **X11**: press `Alt`+`F2`, type `r`, press `Enter`.

Not sure which you're on? `echo $XDG_SESSION_TYPE`.

Then enable it:

```bash
gnome-extensions enable kiro-crew@totoshko88.github.io
```

A ghost should appear in your top bar.

---

## 3. First run — the token

To read your crew's state, the extension needs an **access token** for the gateway. You almost never have to deal with this by hand:

- **Automatic (the normal case).** On first run, if no token is set, the
  extension asks the gateway for one through its **loopback-only local
  bootstrap** (`GET /api/token/local`). This only works for a program running on
  *your own machine* under the gateway's own process namespaces — which a GNOME
  extension is. It reads a short local secret from `~/.kiro/crew/.local_secret`
  (a file only your user can read) and gets a fresh token back. No copy-paste.

- **Why tokens expire.** Gateway tokens are **short-lived — about an hour** and
  are tied to one session, on purpose. When yours expires, the ghost turns a
  **dim red** (not the bright red of a real problem) and the menu says
  *"Token expired — update in Settings."* The extension tries to fetch a new one
  automatically; if that works, it goes back to normal on its own.

- **Manual, if you need it.** Open **Settings** (see below) and either press
  **Fetch** (runs the same local bootstrap) or **Open** to open the dashboard
  and copy a token into the field yourself.

---

## 4. Reading the ghost

The icon color is the single most important thing. It's the *worst* thing happening across your whole crew, so you always see the thing that matters most:

| Color | State | What it means | What to do |
|-------|-------|---------------|------------|
| ⚪ grey | idle | Gateway is up, nothing is running | Nothing |
| 🔵 blue | busy | At least one agent is working | Wait, or peek |
| 🟡 amber | attention | An agent asked a question or wants an approval | Click — it needs you |
| 🔴 red | problem | A critical alert, an MCP error, or the gateway is unreachable | Click / investigate |
| 🔴 dim red | auth | Your token expired | Reopen the dashboard, refetch a token |

Priority order (highest wins): **auth → problem → attention → busy → idle.**

### Clicking

- **Left-click the ghost** → jumps straight to the **most relevant session**:
  the one with a problem, else the one needing attention, else the one that's
  active. If everything is idle, it opens the dashboard home instead.
- **Right-click (or just click) → menu** (details below).

---

## 5. The menu

Right-click (secondary button) opens the menu:

- **Recent sessions** (up to 10) — each with a title and a **status dot** in the
  same color scheme as the main icon, reflecting that session's live state.
  Click any one to open it in the browser.
- **Endpoint** — switch between the gateway URLs you saved in Settings (handy if
  you run more than one gateway, e.g. a local one and a container).
- **Reconnect** — force the live connection to reconnect now (useful right after
  you start the gateway, or after a network blip).
- **Settings** — opens the preferences window.

---

## 6. Settings

Open with the menu's **Settings**, or:

```bash
gnome-extensions prefs kiro-crew@totoshko88.github.io
```

**Connection**
- **Gateway URL** — default `http://localhost:5476`.
- **Access token** — usually filled automatically; you can paste one here.
- **Open dashboard** — opens the gateway in your default browser. The browser
  session's login outlives the extension, so this is the reliable place to grab
  a fresh token.
- **Fetch token automatically** — runs the local bootstrap and fills the token
  field. Use it if the ghost is dim-red and hasn't recovered on its own.
- **Saved endpoints** — comma-separated list; these show up in the menu's
  *Endpoint* submenu.

**Browser**
- **Open links with** — system default, or a specific browser for all the
  "open session / open dashboard" actions.

**Menu**
- **Recent sessions shown** — 1 to 10.
- **Show message previews** — show a snippet under each session title.
- **Fallback poll interval** — how often to poll over plain HTTP *only while the
  live WebSocket is down*. Live updates don't poll; this is just the safety net.

---

## 7. Choosing a browser (optional)

By default, clicks open your system default browser. If you keep your Kiro Crew dashboard logged in in one specific browser, set **Settings → Browser → Open links with** to that browser so sessions always open where you're already authenticated.

---

## 8. Troubleshooting

**No ghost after install.** Did you reload the shell? Wayland needs a full log out / log in. Then `gnome-extensions enable kiro-crew@totoshko88.github.io`. Check status:

```bash
gnome-extensions info kiro-crew@totoshko88.github.io
```

`State: ACTIVE` is good. `State: ERROR` means it failed to load — see logs below. `Enabled: Yes` + `State: INACTIVE` usually clears with a real re-login.

**Ghost is dim red.** Token expired. It should refetch automatically; if not, open **Settings** → **Fetch**, or **Open** the dashboard and paste a token.

**Ghost is bright red but the gateway is fine.** That's a *crew* signal: a critical notification or an agent error. Click the ghost to jump to it, or open the dashboard.

**Session dots are all grey even though agents are running.** Make sure the gateway is reachable and the token is valid (dim red = token). If the live connection is down, the menu falls back to polling and dots can lag; use **Reconnect**.

**Reading the logs.**

```bash
journalctl --user -b 0 | grep -i kiro-crew
```

Look for lines mentioning `extension.js` or `prefs.js`.

---

## 9. Uninstall

```bash
gnome-extensions disable kiro-crew@totoshko88.github.io
rm -r ~/.local/share/gnome-shell/extensions/kiro-crew@totoshko88.github.io
```

Then reload the shell (log out / in on Wayland).

---

## 10. Privacy note

This extension talks **only** to your local gateway over loopback. It reads state (sessions, slots, status, notifications) and opens URLs in your browser. It never sends your data anywhere else, never calls a mutating gateway endpoint, and never mints a credential by the security-gated path — it only uses the sanctioned local bootstrap that already trusts same-machine processes.
