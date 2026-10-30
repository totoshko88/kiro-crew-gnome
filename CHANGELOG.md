# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5]

Keeps the ghost connected across the short-lived access tokens that Kiro Crew gateway 0.11 introduced.

### Fixed

- **The ghost sat on "Gateway offline" against a healthy gateway, reconnecting in a loop.** This was the main breakage after the Kiro Crew gateway reached 0.11. Soup caps an incoming WebSocket frame at 128 KiB by default, and the gateway's live `slots`/`dashboard` frames now exceed that (observed ~136 KiB). The very first frame tripped Soup's *payload larger than max-incoming-payload-size*, which closed the socket immediately; the extension read that as the gateway dropping, went offline, reconnected, and hit the same wall — so it never stayed connected and the ghost blinked red. The extension now lifts the incoming-payload limit on each WebSocket, so large frames are accepted and the connection stays up. This is independent of the token work below.

- **The ghost turned red a few minutes after the gateway started or restarted** (including right after a gateway update), reading "Token expired — update in Settings" even though the gateway was healthy. Since gateway 0.11 the access token is a short-lived bearer credential (its `exp` is only minutes out); the extension sent it as a query parameter on every request and never kept the HttpOnly session cookie the gateway hands back in exchange, so once that `exp` passed every request and the WebSocket were rejected with 403. The extension now keeps that cookie (a `Soup.CookieJar` on the transport session), so the connection authenticates by the long-lived session the cookie carries and survives the token's short `exp`. The token still rides every URL, so the first request re-seeds the session and a lost cookie re-exchanges on its own. The cookie is dropped when the profile switches or a fresh token is adopted, so one gateway's session can never shadow another's.

- **A local token the gateway won't mint is handled gracefully instead of looping silently.** Gateway 0.11 only issues a local token to a request it can verify as the owner's own process, over its owner-only unix socket. When the gateway refuses (it told us so, with code `member_owner_token_refused`), the extension no longer keeps trying in vain: it notifies you once — *Kiro Crew needs a fresh sign-in* — and a click opens the dashboard so you can sign in. A plain network error still falls through to the normal reconnect.

- **The token is re-minted on every reconnect attempt while it's rejected, not just once.** Previously the extension asked for a fresh token only at the instant the first rejection was seen; if that single mint failed or raced, the stale token was retried forever and the ghost sat on *Gateway offline* while the gateway was healthy. Each reconnect tick now mints a fresh token first (for a local or SSH-controlled gateway) and reconnects with it, and always reconnects even when the mint produced nothing, so the backoff loop can't stall on an expired token.

### Added

- **The session cookie is now refreshed before it would lapse, not after.** A short while before the access token's `exp`, the extension makes one cheap authenticated request that re-exchanges the token and extends the session cookie, without disturbing the live WebSocket. This keeps the session healthy proactively instead of relying on recovery after a 403, and re-arms itself for as long as the connection stays up.

### Changed

- **A brief token rejection no longer reads as a hard error.** A gateway restart, or the few seconds while the session cookie re-exchanges, can momentarily reject the token. The menu header now says *Reconnecting…* for a short grace window and only escalates to *Token expired — update in Settings* once the rejection clearly persists, so a normal restart no longer flashes an alarming message.
- **The one-shot 0.1.2 migration keys are cleared once they've been read.** After the old `endpoint`/`endpoints`/`token` settings are migrated into profiles they are reset to their defaults, so a stale endpoint (e.g. a `localhost:3676` left over from an earlier setup) or a leftover access token no longer lingers in GSettings where it could mislead a diagnosis. Only a value that still differs from its default is touched, so a clean install writes nothing.

## [0.1.4]

Catches up with Kiro Crew gateway 0.11.

### Fixed

- **Update did nothing useful on a `cli.sh` or pipx install** (the usual one). The gateway can't replace itself while it runs, so it answers the update check with the command that updates that install (the installer, on your release channel); the extension ignored it, showed "Re-run the installer to upgrade." and opened the dashboard home. **Update to _x.y.z_…** now opens a dialog with that command and a **Copy command** button; paste it into a terminal, then pick **Restart gateway**. The extension still never runs the installer. An install with no such command (a container, the desktop app) opens the dashboard's *Settings → About* instead of the home page.
- **Critical notifications never reached the desktop.** The gateway sends a note inside the WebSocket frame's `data`, and the extension read the frame itself, so it never saw a critical one. They now pop up again, and a click opens the dashboard page the note links to. Notes the gateway silenced (a muted session) are skipped. A tool approval is critical on the gateway too; it pops up but leaves the ghost amber, not red.
- **A failed MCP server never turned the session red.** The gateway reports failed servers as a `failed` list in `mcp_report`; the extension looked for `status` / `severity` fields the gateway doesn't send.
- Background subagents that are queued but not yet running (`subagents_queued`), and a compaction holding a session, count as working. The check for an `orchestrating` field the gateway doesn't send is gone.
- Opening a link with a browser chosen in Settings logged a `Gio.DesktopAppInfo has been moved` warning on GNOME 49+ (GLib 2.86). The extension now finds the browser through the shell's app system and launches with a shell launch context.

### Security

- The local secret (`~/.kiro/crew/.local_secret`) travels over the gateway's owner-only unix socket (`~/.kiro/crew/dashboard-<port>.sock`) for the token bootstrap and a hand-run Stop, following the gateway's own CLI, which since 0.11 proves the gateway before it sends the secret. Before, it went to `localhost:<port>`, so another local user listening on that port (or on `::1`) while the gateway was down could receive it. A gateway without the socket is reached on `127.0.0.1`. The shell and the preferences window share this code now (`lib/localBootstrap.js`).
- Clipboard use is declared in the extension description: the extension only writes the update command, on **Copy command**, and never reads the clipboard.

### Added

- **Update state follows the gateway live.** The gateway pushes its update verdict in the status frame it sends over the WebSocket every few seconds, and the extension reads it from there: the update item changes on its own when a release appears, with no update-check request when the menu opens or the gateway reconnects. **Check for updates** still asks the gateway right away. A gateway too old to send these fields is checked once, as before.
- **Update required.** When the gateway reports that a minimum version is required (a security-policy pin or a breaking-change floor), the item reads **Update required: _x.y.z_** and one notification says so; clicking it starts the update.
- **Update progress.** While a git checkout updates itself, the item shows the gateway's step (downloading, building, installing, restarting), and a failed update is reported with the gateway's own error.
- **MCP sign-in.** A session whose MCP server waits for you to sign in turns amber, and its menu row says *MCP sign-in needed*. A failed MCP server still turns it red.
- **Clicked notifications are marked read** in the dashboard's notification bell (`POST /api/notifications/ack`), for a local profile or one with SSH control.

### Changed

- `metadata.json` no longer carries the integer `version`: the review guidelines mark it deprecated, set by extensions.gnome.org on upload. The release workflow no longer bumps it.

## [0.1.3]

### Added

- **Gateway update lifecycle in the menu.** A **Check for updates** item reads the gateway's own update state (`GET /api/update/check`); when a newer release is out it becomes **Update to _x.y.z_**. If the gateway can apply the update itself it does so (`POST /api/update`) and restarts; otherwise (a pipx, package, or Docker install it does not manage) the extension points you at the dashboard, which owns that install's update flow — the extension never runs the installer.
- **Restart gateway** menu item for a reachable local gateway, through the gateway's own in-place restart (`POST /api/restart`). Works for a hand-run or pipx-managed gateway, not only a systemd unit. If sessions are still working, you're asked to confirm first.
- **Release channel** switcher in Settings (**Stable** / **Insider**). The extension mirrors the local gateway's current channel into the setting, so it shows the truth (a gateway installed on insider reads as Insider). Changing it asks the running gateway to switch channels (`POST /api/update/channel`); the move takes effect on the gateway's next update. A new `channel` GSettings key records the choice.
- **Gateway profiles.** Each gateway is a profile with a name, host, port and its own access token (new `profiles` and `active-profile` GSettings keys). Switch between them from **Settings → Gateway profiles** or the menu's **Profile** submenu; the token always travels with its gateway. Edits apply on **Save**, not on every keystroke.
- **Remote gateways over SSH.** A profile on another machine is reached through an SSH tunnel the extension opens and keeps alive itself (`ssh -N -L 127.0.0.1:<local>:localhost:<port> user@host`, key-based login), restarting it with backoff if it drops and closing it on a profile switch or disable. You enter only the remote port. The local end is never that port: it is remote port + 10000 (`3676` → `13676`), skipping the ports of your local profiles and anything already listening here, and re-picked on every start — so a local gateway and a remote one can both use `3676`. The menu shows *SSH tunnel down — retrying* with ssh's own error when it can't connect.
- **Control a remote gateway over SSH** (opt-in per profile, **Allow control over SSH**). The token is minted on the remote host's own loopback (its secret never leaves it) and refetched on its own when it expires; Stop/Start/Restart drive the host's `kirocrew.service` with `sudo -n systemctl`; Update runs `kirocrew update` there. Only a fixed set of commands built from constants and the profile's port is ever sent.
- **Local / remote switch for `localhost` profiles.** A tunnel you run yourself also listens on `localhost`, so a `localhost` profile can be marked **Another machine (remote)**: no gateway controls, no tunnel opened, and the local secret is never sent to it.
- GNOME Shell **51** added to the supported versions.

### Changed

- The code is split into modules by process: `extension.js` is only `enable()`/`disable()`, shell-only code lives in `shell/`, preferences-only code in `prefs/`, and code both use in `lib/` (no UI imports, checked in CI). The indicator, menu, gateway connection, lifecycle and updates are separate classes, each cleaning up what it creates.
- Async work is cancelled instead of guarded: each owner passes its `Gio.Cancellable` to every request, D-Bus call and ssh command, so after `disable()` they reject with `G_IO_ERROR_CANCELLED` and nothing runs past the `await`. The `_destroyed` flag is gone.
- Whether a gateway is "this computer" now comes from its profile's kind, not from its URL being `localhost`. Update, channel, restart and stop/start are offered only for a local profile; a remote profile is read-only.
- The 0.1.2 settings (Gateway URL, saved endpoints, token) are migrated to profiles on first start. `localhost:5476` becomes the local profile, any other `localhost` port a read-only remote profile, and a LAN address a remote profile with an SSH tunnel. The old token goes to the profile that was active; tokens for other gateways need to be pasted once.

### Fixed

- With a tunnel on `localhost`, the extension took the remote gateway for the local one: it offered Stop/Restart/Update for it (Stop would have stopped this computer's `kirocrew.service`), mirrored the remote gateway's channel, and on an expired token sent this computer's local secret to the remote gateway.
- A tunnel on the same local port as a gateway on this computer could shadow it, and `localhost` resolves to `::1` first, so the client could reach a local service instead of the tunnel. The tunnel's local end is now separate from every local profile's port, and the client talks to it on `127.0.0.1`.
- Stop/Start drove `kirocrew.service` for any local profile, whatever its port, so a profile pointing at another port (for example a migrated `localhost:3676`) stopped the real gateway on 5476. The unit is now controlled only when its port (`KIROCREW_PORT`, with `/etc/kirocrew/kirocrew.env` overriding it, default 5476) matches the profile's.
- The last local profile could be deleted, leaving the gateway on this computer out of reach. It can't be any more.
- An ssh or API failure during Stop/Start threw a TypeError while checking for a dismissed polkit prompt, so the error notification never appeared.
- Switching gateways lost the token. Editing the URL saved and swapped tokens on every keystroke, and the extension and the preferences window both rewrote the same keys, so one could store a token under the wrong URL or overwrite it with an empty one.

### Security

- The new update, channel and restart actions run only for a **local** profile, with the dashboard token, and only on an explicit menu or Settings action. A remote profile gets no gateway controls, and the local secret is never sent to it.
- The one subprocess is the SSH tunnel of a remote profile: an argv array (no shell), a validated host after `--`, a forward bound to `127.0.0.1` only, and `BatchMode` so it never handles a password. See [SECURITY.md](docs/SECURITY.md).

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
