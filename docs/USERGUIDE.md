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

- **Remote gateways.** The automatic path works only for the gateway on this
  computer. A remote gateway's token is pasted into its profile by hand — see
  [Adding a remote gateway](#adding-a-remote-gateway-ssh-tunnel).

---

## 4. Reading the ghost

The icon color is the single most important thing. It's the *worst* thing happening across your whole crew, so you always see the thing that matters most:

| Color | State | What it means | What to do |
|-------|-------|---------------|------------|
| ⚪ grey | idle | Gateway is up, nothing is running | Nothing |
| 🟣 purple | busy | At least one agent is working | Wait, or peek |
| 🟡 amber | attention | An agent is blocked on you: it asked a question or wants a tool approval (reply suggestions after a finished turn don't count) | Click — it needs you |
| 🔴 red | problem | A critical alert, an MCP error, or the gateway is unreachable | Click / investigate |
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
  [Gateway profiles](#gateway-profiles)). Each profile carries its own token;
  a remote one also opens its own SSH tunnel.
- **Stop gateway / Start gateway**, **Restart gateway**, **Check for updates**
  — shown only for a **local** profile (the gateway on this computer):
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
| **Profile name** | Any label, shown in the menu (`This computer`, `Home server`) |
| **Host** | IP or hostname. Use `user@host` when your SSH user on that machine differs (`anton@192.168.0.131`) |
| **Port** | The gateway's port **on that host** (`5476` by default) |
| **Access token** | That gateway's own token. Tokens are per gateway: one never works on another |
| **Gateway runs on** | Shown only for `localhost`: **This computer (local)** or **Another machine (remote)** |

**Local** is the gateway on this computer. It gets the full menu — Stop/Start,
Restart, Check for updates, the release channel — and its token is fetched
automatically through the local bootstrap. Stop/Start go through systemd only
when `kirocrew.service` listens on **this profile's port** (read from the
unit's `KIROCREW_PORT`, `/etc/kirocrew/kirocrew.env` overriding it, default
5476); a local profile on another port never stops that unit.

**Remote** is a gateway on another machine. By default it is **read-only**: you
see its sessions and status, the menu has no gateway controls, and the
extension never sends this computer's local secret to it. Turn on **Allow
control over SSH** in the profile to manage it like a local one (see
[Controlling a remote gateway over SSH](#controlling-a-remote-gateway-over-ssh)).

- **Active profile** picks the one the ghost follows (the menu's **Profile**
  submenu does the same).
- **+** in the group header adds a profile. Edits apply when you press
  **Save**, not while you type.
- **Delete** removes a profile. The last profile, and the last *local*
  profile, can't be deleted — the gateway on this computer always stays
  reachable.
- **Open dashboard** opens the active profile's dashboard — the place to copy a
  fresh token.
- **Fetch** runs the local bootstrap and fills the token — on this computer
  for a local profile, on the remote host over SSH for a profile with SSH
  control. Press **Save** to keep it.

Upgrading from 0.1.2: your old Gateway URL, saved endpoints and token become
profiles on first start. `localhost:5476` becomes the local profile; any other
`localhost` port is assumed to be a tunnel you run yourself and becomes a
read-only remote profile; a LAN address becomes a remote profile with an SSH
tunnel. The old token goes to the profile that was active.

### Adding a remote gateway (SSH tunnel)

A remote gateway is never exposed on the network. The gateway binds to
`localhost` on its machine, and you reach it through an SSH tunnel — the
extension opens and maintains that tunnel for you.

Once, on this computer:

```bash
ssh-copy-id anton@192.168.0.131   # key-based login: the tunnel can't type a password
ssh anton@192.168.0.131 true      # accept the host key once
```

Then in **Settings → Gateway profiles → +**:

1. **Profile name** `Home server`, **Host** `anton@192.168.0.131`,
   **Port** `3676` — the gateway's port **on that machine**. You never enter a
   local port; the extension picks it.
2. **Access token** — open that gateway's dashboard (through the tunnel, or on
   that machine), copy a token, and paste it. **Fetch** can't help here: it
   reads a secret file that only exists on the gateway's own machine.
3. **Save**, then pick the profile under **Active profile** or in the menu.

When the profile is active, the extension runs the equivalent of

```bash
ssh -N -L 127.0.0.1:13676:localhost:3676 anton@192.168.0.131
```

and keeps it open: it restarts the tunnel if it drops, with backoff, and
closes it when you switch profiles or disable the extension. The forward binds
`127.0.0.1` only, so the tunnel isn't reachable from your LAN.

**The local end is never the remote port.** Your own gateway may use the same
number (a local gateway on `3676` and a remote one on `3676`), so the tunnel
uses remote port + 10000 — `3676` → `13676`, `5476` → `15476`. It skips the
ports of your local profiles and any port something on this computer is
already listening on, taking the next free one, and it re-picks on every
(re)start. The active profile's subtitle in Settings shows the port in use
(`→ 127.0.0.1:13676`); **Open dashboard** uses it.

### Controlling a remote gateway over SSH

With **Allow control over SSH** on, the extension uses the same SSH key as the
tunnel to run a short, fixed list of commands on that host. Nothing you type
goes into them — only constants and the profile's port number:

| Action | Command on the remote host |
|---|---|
| Token | `/api/token/local` on its own `127.0.0.1:<port>`, with its own `~/.kiro/crew/.local_secret` — the secret never leaves the host |
| Service state | `systemctl show kirocrew.service` + `/etc/kirocrew/kirocrew.env` (to match the port) |
| Stop / Start / Restart | `sudo -n systemctl stop\|start\|restart kirocrew.service` |
| Update | `~/.local/bin/kirocrew update`, then `sudo -n systemctl restart kirocrew.service` |

The menu then shows Stop/Start, Restart, Check for updates and the release
channel for that profile, and an expired token is refetched on its own, just
like the local gateway.

Prepare the host once:

```bash
# on the remote host, as the user that owns the gateway
KIROCREW_PORT=3676 kirocrew service install   # system unit, survives reboot and logout
sudo loginctl enable-linger "$USER"            # keeps agent runtimes alive without a login
kirocrew config set dashboard.url http://localhost:3676
```

`sudo -n` means no password prompt: Stop/Start/Restart/Update need
passwordless sudo for `systemctl` (or the whole account) on that host. Without
it those actions fail with sudo's error, while the token and the state still
work. If the remote gateway runs by hand rather than as `kirocrew.service`,
there are no Stop/Start items — only Restart and Update over the dashboard API.

Keep the gateway on the remote host bound to `localhost` — that's its default.
Don't expose its port on the LAN (an old `socat` forwarder, a `0.0.0.0` bind):
the tunnel is the only way in.

Already run the tunnel yourself (autossh, a systemd unit)? Make a profile with
**Host** `localhost`, **Port** = your local forward port, and **Gateway runs on**
= **Another machine (remote)**. The extension then opens no tunnel, and still
hides the gateway controls.

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

**"Stop gateway" asks for a password.** That's polkit guarding the system
service: stopping a system unit is an admin action. Cancel and nothing
changes. To avoid the prompt, run the gateway as a user service or by hand.

**Stop/Start is missing from the menu.** It only appears for a **local**
profile, and for a hand-run gateway only while it is reachable. A remote
profile — including a `localhost` one marked *Another machine* — never shows
gateway controls.

**"SSH tunnel down — retrying".** The extension couldn't open or keep the
tunnel for a remote profile; the menu shows ssh's own error under it. The
usual causes:
- `Permission denied (publickey…)` — no key login yet: run `ssh-copy-id`.
- `Host key verification failed` — connect once by hand to accept the key.
- `Address already in use` — something grabbed the local port between the
  check and ssh's own bind; the next retry picks another port by itself.
- `Could not resolve hostname` / `Connection timed out` — wrong host, or the
  machine is off.

**Remote profile is dim red.** Its token expired. With **Allow control over
SSH** it is refetched on its own (or press **Fetch**). Without it, open that
gateway's dashboard, copy a new token, paste it into the profile and **Save**.

**Stop on a remote profile says "sudo: a password is required".** The host
needs passwordless sudo for `systemctl`; see
[Controlling a remote gateway over SSH](#controlling-a-remote-gateway-over-ssh).

**Stop/Start missing for a local profile.** The profile's port doesn't match
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

This extension talks **only** to your gateways: the local one over loopback, a remote one through an SSH tunnel bound to `127.0.0.1`. It reads state (sessions, slots, status, notifications) and opens URLs in your browser. It changes things only when you pick an action — Stop/Start, Restart, Update, or a release-channel switch — and only on the local gateway or on a remote one where you turned on **Allow control over SSH**. Any other remote gateway is read-only. The extension never sends your data anywhere else, never sends this computer's local secret to a remote gateway, and never mints a credential by the security-gated path — it only uses the sanctioned local bootstrap that already trusts same-machine processes.
