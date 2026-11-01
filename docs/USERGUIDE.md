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

2. **GNOME Shell 45 to 51.** Check with:

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

- **Gateways on other machines.** The extension talks only to the gateway on this computer. To watch a gateway on another machine, connect it in the Kiro Crew dashboard — see [Reaching a gateway on another machine](#reaching-a-gateway-on-another-machine).

---

## 4. Reading the ghost

The icon color is the single most important thing. It's the *worst* thing happening across your whole crew, so you always see the thing that matters most:

| Color | State | What it means | What to do |
|-------|-------|---------------|------------|
| ⚪ grey | idle | Gateway is up, nothing is running | Nothing |
| 🟣 purple | busy | At least one agent is working | Wait, or peek |
| 🟡 amber | attention | A session is blocked on you: an agent asked a question or wants a tool approval, or an MCP server waits for you to sign in (the menu row says *MCP sign-in needed*). Reply suggestions after a finished turn don't count | Click — it needs you |
| 🔴 red | problem | A critical alert, an MCP server that failed to start in a session, or the gateway is unreachable | Click / investigate |
| 🔴 dim red | auth | Your token expired | Reopen the dashboard, refetch a token |
| 💤 faded, eyes closed | stopped | You stopped the gateway (or it is stopping / starting) | Menu → **Start gateway** when you need it |

Priority order (highest wins): **stopped → auth → problem → attention → busy → idle.**

"Working" counts every way a session can be busy, the same way the dashboard
sidebar does: the agent's own turn, a staged plan, background subagents, or
queued prompts. So a session that handed work to subagents stays purple even
while its main agent waits for them.

The ghost also moves a little when its state changes: it floats when work
starts, hops when an agent needs you, gives a small hop when work finishes,
and shakes its head when something breaks. Each motion plays once. Turn
animations off in GNOME Settings → Accessibility and the ghost stays still.

### Clicking

- **Left-click the ghost** → jumps straight to the **most relevant session**:
  the one with a problem, else the one needing attention, else the one that's
  active (the most recently active one if several match). If everything is
  idle, it opens the dashboard home instead. While the gateway is stopped,
  left-click opens the menu, since there is nothing to open in the browser.
- **Right-click → menu** (details below).

---

## 5. The menu

Right-click (secondary button) opens the menu:

- **Recent sessions** (up to 10) — each with a title and a **status dot** in the
  same color scheme as the main icon, reflecting that session's live state.
  Click any one to open it in the browser. The dots follow the same rule as
  the ghost, so the ghost's color is always the worst dot you see. An active
  session that isn't among the recent ones is pinned to the top.
- **Open dashboard** — the dashboard home.
- **Gateway logs** — the dashboard's live log viewer.
- **Profile** — switch between your gateway profiles (see
  [Gateway profiles](#gateway-profiles)). Each profile carries its own token.
- **Stop gateway / Start gateway**, **Restart gateway**, **Check for updates**
  — for the gateway on this computer:
  - Installed as a service (`kirocrew service install`): stops and starts
    `kirocrew.service` through systemd. For the system service GNOME asks for
    your password (polkit); it remembers it for a few minutes. A stopped
    service stays stopped until you start it or the machine reboots — the
    service stays enabled.
  - Started by hand (`kirocrew gateway`): **Stop** asks the gateway to shut
    down cleanly. There is no Start for this case — run `kirocrew gateway`
    again; the ghost notices on its own.
  - If sessions are still working, you are asked to confirm first, because
    stopping interrupts them.
- **Check for updates** turns into **Update to _x.y.z_** when a release is
  out. What it does depends on how Kiro Crew is installed:
  - A git checkout: the gateway updates itself and restarts.
  - A `cli.sh` or pipx install (the usual one): the gateway can't replace
    itself while it runs, so the item reads **Update to _x.y.z_…** and opens
    a dialog with the gateway's own update command (the installer, on your
    release channel). **Copy command** puts it on the clipboard; paste it into
    a terminal, and when it finishes pick **Restart gateway**. The extension
    never runs the installer itself.
  - A container or the desktop app: you're pointed at the dashboard's
    *Settings → About*, which owns that update.

  The item follows the gateway on its own: it changes when a release appears,
  shows the step while an update runs (*Updating: building…*), and reads
  **Update required: _x.y.z_** when the gateway demands a minimum version —
  you also get one notification about that.
- **Reconnect** — force the live connection to reconnect now (useful after a
  network blip). Hidden while the gateway is stopped.
- **Settings** — opens the preferences window.

---

## 6. Settings

Open with the menu's **Settings**, or:

```bash
gnome-extensions prefs kiro-crew@totoshko88.github.io
```

### Gateway profiles

A **profile** is one gateway. Each profile has:

| Field | What to enter |
|---|---|
| **Profile name** | Any label, shown in the menu (`This computer`, `Gateway on 3676`) |
| **Port** | The gateway's port on this computer (`5476` by default) |
| **Access token** | That gateway's own token. Tokens are per gateway: one never works on another |

Every profile is a gateway on this computer, reached on `127.0.0.1`. It gets the full menu — Stop/Start, Restart, Check for updates, the release channel — and its token is fetched automatically through the local bootstrap. Stop/Start go through systemd only when `kirocrew.service` listens on **this profile's port** (read from the unit's `KIROCREW_PORT`, `/etc/kirocrew/kirocrew.env` overriding it, default 5476); a profile on another port never stops that unit. More than one profile is useful when you run several gateways on this machine on different ports.

- **Active profile** picks the one the ghost follows (the menu's **Profile** submenu does the same).
- **+** in the group header adds a profile. Edits apply when you press **Save**, not while you type.
- **Delete** removes a profile. The last one can't be deleted — the gateway on this computer always stays reachable.
- **Open dashboard** opens the active profile's dashboard — the place to copy a fresh token.
- **Fetch** runs the local bootstrap on this computer and fills the token. Press **Save** to keep it.

Upgrading from an earlier version: your old Gateway URL, saved endpoints and token become local profiles on first start, and the old token goes to the profile that was active. Profiles for other machines that earlier versions managed over SSH are removed — those gateways now live in the dashboard's Remote Crew (see below) — and the extension shows a one-time notice when it removes any.

### Reaching a gateway on another machine

The extension no longer opens SSH tunnels or runs commands on other hosts — that is not allowed for a GNOME Shell extension, and the Kiro Crew gateway does it better itself. Connect the other machine in the Kiro Crew dashboard instead:

1. Open the dashboard on this computer and go to **Settings → Remote Crew → Add remote crew**.
2. Choose the connection method — an **SSH tunnel** (give the SSH host and the remote port) or **AWS SSM Session Manager** (give the SSM target, and an AWS profile/region if needed).
3. **Save**, then **Connect**. The gateway opens and keeps that tunnel itself, binding to loopback, and the remote crew appears in your Sessions list with its own Online / Reconnecting / Error / Offline badge.

For a richer view where a peer crew's session opens as a live window, turn on **Settings → Developer → Feature Previews → Remote crew sessions** in the dashboard. Nothing about the remote machine is stored on this computer.

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

**Ghost is bright red but the gateway is fine.** That's a *crew* signal: a critical notification (it also pops up on the desktop; click it to open the page it points to and mark it read in the dashboard's bell), or an MCP server that failed to start in a session. Click the ghost to jump to that session, or open the dashboard. A tool approval is critical on the gateway too, but it shows as amber, not red.

**"Stop gateway" asks for a password.** That's polkit guarding the system
service: stopping a system unit is an admin action. Cancel and nothing
changes. To avoid the prompt, run the gateway as a user service or by hand.

**Stop/Start is missing from the menu.** For a hand-run gateway it appears only while the gateway is reachable.

**Stop/Start missing even so.** The profile's port doesn't match
the port `kirocrew.service` listens on, so the extension won't touch that unit.
Fix the profile's port, or the unit's `KIROCREW_PORT`.

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

This extension talks **only** to the Kiro Crew gateway on this computer, over loopback. It reads state (sessions, slots, status, notifications) and opens URLs in your browser. It changes things only when you pick an action — Stop/Start, Restart, Update, or a release-channel switch. It never spawns `ssh`, `sudo` or `curl`, never reaches another machine itself, never sends your data anywhere else, and never mints a credential by the security-gated path — it only uses the sanctioned local bootstrap that already trusts same-machine processes. A gateway on another machine is connected in the dashboard's Remote Crew, which keeps that connection itself.
