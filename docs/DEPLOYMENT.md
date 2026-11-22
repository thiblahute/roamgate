# Installation and Deployment

Configuration reference for Roamgate. For a guided walkthrough and private
remote access, see the [tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server, or let Roamgate [set one up](#managed-herdr-setup).
  Roamgate uses Herdr's default sockets (`~/.config/herdr/herdr.sock` and
  `herdr-client.sock`; named pipes under `%APPDATA%\herdr\` on Windows).
- Release binaries need nothing else. Source builds need
  [Bun](https://bun.sh) 1.4.4+.
- On Windows, local Git features need [Git for Windows](https://gitforwindows.org/)
  on PATH.

### Herdr compatibility

| Herdr                            | Support                              |
| -------------------------------- | ------------------------------------ |
| 0.7.0–0.8.2 (protocols 14–20)    | Legacy terminal mode                 |
| 0.9.0 and 0.9.4 (protocol 22)    | Endpoint terminal mode (recommended) |
| Protocol 21 and unknown versions | Rejected                             |

Do not downgrade a live Herdr server. The [plugin](#herdr-plugin) and tab
reordering need Herdr 0.7.2+. `ROAMGATE_DISABLE_ENDPOINT=1` forces legacy mode.

Known limitations:
- Endpoint mode shares pane focus, layout, and terminal size between clients;
  only workspace/tab selection is per browser. Legacy mode shares everything and
  may take over the terminal from another client.
- Creating tabs or workspaces needs a connected terminal (except the first
  workspace in an empty session) and keeps Herdr's `terminal.new_cwd` policy.
- Pixel mouse reporting and enhanced Kitty keyboard modes are not supported.
- **OSC 52 clipboard writes** go only to the browser that typed into that
  session in the last 30 seconds. Herdr does not say which pane produced a
  write, so a late write can reach the wrong recent typist. Clipboard reads are
  disabled. OSC 52 is unavailable in protocol 22 legacy mode.
- Closing a workspace never closes its linked group. To do that, inspect the
  group and run `herdr --session <name> workspace close <workspace_id> --group`.

See [endpoint contracts](./ARCHITECTURE.md#terminal-endpoints).

## Install a release

Releases include Linux, macOS, and Windows binaries for x86-64 and ARM64.

On Linux/macOS, the checksum-verifying installer writes `~/.local/bin/roamgate`:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/latest/download/install-roamgate.sh \
  | sh
```

Add `~/.local/bin` to PATH, then run `roamgate` and open the printed URL.
`roamgate update` updates (or rerun the installer); `roamgate rollback` restores
the previous binary (`roamgate.previous`).

On Windows, download `roamgate-windows-<arch>.tar.xz` and its `.sha256` from the
[latest release](https://github.com/powerfooI/roamgate/releases/latest), verify
with `Get-FileHash`, extract with `tar.exe`, and run `roamgate.exe`.

Installer settings go on the `sh` side of the pipe (`curl ... | <setting> sh`):

| Installer setting | Example / behavior                                                   |
| ----------------- | -------------------------------------------------------------------- |
| Pin a version     | `ROAMGATE_VERSION=X.Y.Z sh` (no `v`; empty means latest)             |
| Install directory | `sudo env ROAMGATE_INSTALL_DIR=/usr/local/bin sh`                    |
| Release mirror    | `ROAMGATE_RELEASE_BASE_URL=<https URL of a flat asset directory> sh` |

## Managed Herdr setup

```bash
roamgate herdr setup
roamgate herdr status
```

If Herdr is missing, setup downloads Herdr 0.9.4, verifies its pinned SHA-256,
and installs it (`~/.local/bin/herdr`, or `%APPDATA%\roamgate\herdr\0.9.4` on
Windows x64). An existing Herdr on PATH is used as is. Setup then runs
`herdr server` as a user service: `roamgate-herdr.service` (Linux),
`dev.roamgate.herdr` (macOS), or a per-user scheduled task (Windows). The web UI
offers the same **Set up Herdr / Start Herdr** action when the local server is
unreachable.

Only the default local setup is supported; for SSH, named sessions, or custom
sockets, start Herdr yourself.

To remove the service:

```bash
systemctl --user disable --now roamgate-herdr.service  # Linux
launchctl bootout gui/$(id -u)/dev.roamgate.herdr      # macOS
# Windows: find the task name (dev.roamgate.herdr-<key>) in herdr-task.ps1
schtasks /End /TN "<task-name>"
schtasks /Delete /TN "<task-name>" /F
```

Then delete its definition (`~/.config/systemd/user/roamgate-herdr.service` plus
`systemctl --user daemon-reload`, `~/Library/LaunchAgents/dev.roamgate.herdr.plist`,
or `%APPDATA%\roamgate\herdr-task.ps1`).

## Transition from Herdr Studio / herdr-gui

**Herdr Studio / herdr-gui 0.6.2 and earlier cannot auto-update to Roamgate.**
Their update channel no longer receives fixes. Service, data, and plugin
migration needs Roamgate **0.7.1+**.
1. Back up the executable, service definition, and config, keeping permissions:
   `~/.config/herdr-gui/`, plus `%APPDATA%\herdr-gui\` on Windows (Windows
   also keeps settings and connections in `~/.config/herdr-gui/`).
2. Stop and uninstall the old service with `herdr-gui service uninstall` (or the
   old binary's `service uninstall`). Stop any unmanaged processes too. Never
   leave both services enabled.
3. Install Roamgate and run `roamgate service install`. It refuses to run while
   a legacy service exists, even with `--force`.
4. Check status, login, and connections. To roll back, uninstall with the new
   binary and restore the old binary and service.

On first use, Roamgate copies missing tokens, settings, and connections into
`~/.config/roamgate` (`%APPDATA%\roamgate` on Windows), and service install
copies `herdr-gui.env` to `roamgate.env`. Existing new files always win. The
copy is one-way; stop old processes first. Files at custom
`HERDR_GUI_SETTINGS_PATH`/`HERDR_GUI_CONNECTIONS_PATH` locations are not copied.
Browser preferences carry over only when the URL (host and port) is unchanged.
Migrate the [plugin](#herdr-plugin) separately.

After an in-place update from 0.7.0, the new CLI manages an old service only if
it is the single unmodified generated definition for this executable. Otherwise
(custom, ambiguous, or missing definitions), use the previous binary or the
native service manager.

### Repository and website addresses

The project lives at [powerfooI/roamgate](https://github.com/powerfooI/roamgate)
and <https://roamgate.dev/>. Old `powerfooI/herdr-studio` URLs redirect.

### Install historical Herdr Studio

The [legacy installer](../scripts/install-herdr-gui.sh) installs `herdr-gui`
only and must be pinned to a historical tag:

```bash
curl -fsSL \
  https://github.com/powerfooI/roamgate/releases/download/v0.6.2/install-herdr-gui.sh \
  | HERDR_GUI_VERSION=0.6.2 sh
```

## Herdr plugin

The plugin (ID `roamgate`; `herdr.studio` in 0.7.0) needs Herdr 0.7.2+ and Git.
It uses the standalone executable, so Bun is not required.

Install a published release (0.7.1 or newer):

```bash
herdr plugin install powerfooI/roamgate --ref vX.Y.Z
```

The installer verifies the package checksum, version, and platform before
replacing the executable. To upgrade, run the same command with the new tag;
`herdr plugin update` stays on the original tag.

For an unreleased checkout, build before linking, and rebuild after updates:

```bash
git clone https://github.com/powerfooI/roamgate.git
cd roamgate
bun scripts/studio-plugin.ts build-source
herdr plugin link .
```

Plugin actions manage the same [user service](#run-as-a-user-service):

```bash
herdr plugin action invoke roamgate.start      # install/start
herdr plugin action invoke roamgate.url        # login URL
herdr plugin action invoke roamgate.status
herdr plugin action invoke roamgate.restart
herdr plugin action invoke roamgate.uninstall  # remove service, keep data
```

Actions run asynchronously; check `herdr plugin log list --plugin roamgate`, or
open the panel with `herdr plugin pane open --plugin roamgate --entrypoint panel`.
After updating the plugin, reopen the panel before Start or Restart.

**Migrating from `herdr.studio`:** uninstall its service, close its panes, then
run `herdr plugin disable herdr.studio` and `herdr plugin unlink herdr.studio`.

## Basic runtime configuration

Flags override environment variables, which override defaults. Release binaries
ignore `.env` files: export variables, pass flags, or edit the service
environment file. `roamgate --help` lists everything.

| Flag                                    | Environment variable           | Default                                           |
| --------------------------------------- | ------------------------------ | ------------------------------------------------- |
| `--host <addr>`                         | `HOST`                         | `127.0.0.1`                                       |
| `--port <n>`                            | `PORT`                         | `8787`                                            |
| `--password <pw>`                       | `ROAMGATE_PASSWORD`            | Generated token                                   |
| None                                    | `ROAMGATE_PIN`                 | Disabled; see [PIN login](#optional-pin-login)    |
| `--tls-cert <path>`                     | `ROAMGATE_TLS_CERT`            | Disabled; PEM chain                               |
| `--tls-key <path>`                      | `ROAMGATE_TLS_KEY`             | Disabled; PEM key                                 |
| `--socket-path <path>`                  | `HERDR_SOCKET_PATH`            | Default control socket                            |
| `--client-socket-path <path>`           | `HERDR_CLIENT_SOCKET_PATH`     | Default render socket                             |
| `--ssh-host <user@host>`                | `HERDR_SSH_HOST`               | Disabled; Linux/macOS only                        |
| `--session <name>`                      | `HERDR_SESSION`                | Default session                                   |
| `--public-dir <path>`                   | `PUBLIC_DIR`                   | Embedded assets                                   |
| `--log-level <level>`                   | `ROAMGATE_LOG_LEVEL`           | `info`                                            |
| `--notification-source <herdr\|status>` | `ROAMGATE_NOTIFICATION_SOURCE` | `herdr`                                           |
| `--profile`                             | `ROAMGATE_PROFILE=1`           | Disabled; see [profiling](#performance-profiling) |
| `--profile-duration <seconds>`          | `ROAMGATE_PROFILE_DURATION`    | `30` (1-300)                                      |
| `--profile-dir <path>`                  | `ROAMGATE_PROFILE_DIR`         | `<data dir>/profiles`                             |
| `--open`                                | `OPEN_BROWSER=1`               | Disabled                                          |

| Other environment variable                             | Purpose                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ROAMGATE_UPDATE_BASE_URL`                             | HTTPS update mirror directory                                                                   |
| `ROAMGATE_DISABLE_UPDATE_CHECK=1`                      | Disable update checks                                                                           |
| `ROAMGATE_RESTART_SUPERVISOR=0\|1`                     | Override supervisor detection                                                                   |
| `ROAMGATE_DISABLE_ENDPOINT=1`                          | Force legacy terminal mode                                                                      |
| `ROAMGATE_DISABLE_SSH_MASTER=1`                        | Give every SSH host command its own login; see [SSH transport](./ARCHITECTURE.md#ssh-transport) |
| `ROAMGATE_ALLOW_SSH=1`                                 | Connect SSH profiles even with a `$HOME` other than the account's (a test server's own HOME)    |
| `ROAMGATE_ALLOW_FILE_REVEAL=1`                         | Enable [host file reveal](#host-file-reveal)                                                    |
| `ROAMGATE_UPLOAD_MAX_BYTES`                            | Max terminal upload size (default 100 MiB)                                                      |
| `ROAMGATE_UPLOAD_RETENTION_HOURS`                      | Upload retention (default 24)                                                                   |
| `ROAMGATE_SETTINGS_PATH`                               | GUI settings file (one per bridge)                                                              |
| `ROAMGATE_CONNECTIONS_PATH`                            | Connection profiles file                                                                        |
| `ROAMGATE_ASSISTANT_DIR`                               | Ranger data directory                                                                           |
| `ROAMGATE_REVIEW_DIR`                                  | Review sessions and agent sockets                                                               |
| `ROAMGATE_WEB_PUSH_PATH` / `ROAMGATE_WEB_PUSH_SUBJECT` | [Web Push](#web-push-notifications)                                                             |

Legacy `HERDR_GUI_*` names still work; the `ROAMGATE_*` name wins, even when
empty.

```bash
roamgate                                # loopback, generated token
roamgate --host 0.0.0.0 --port 8787     # all interfaces, generated token
```

Prefer `ROAMGATE_PASSWORD` over `--password`. Passwords must be 8-1024
characters; use 15+ for anything beyond a trusted private network. See
[Security](../SECURITY.md#trust-model).

### Optional PIN login

For a server reachable only through a trusted VPN or private network, set
`ROAMGATE_PIN` to 6-12 digits (environment or service file only; there is no
flag) and restart. The login form then starts in PIN mode, with the
password/token still available. Changing the PIN signs out all browsers. See
[PIN security](../SECURITY.md#optional-pin-login).

### Host file reveal

**Off by default.** With `ROAMGATE_ALLOW_FILE_REVEAL=1`, local profiles accessed
over loopback get **Reveal on host** and **Open folder on host**, which open the
file manager on the Roamgate host. SSH profiles and non-loopback clients are
refused. **Tunnelled or reverse-proxied loopback clients count as local too**,
so enable it only if every such client may open windows on the host.

### Native HTTPS

Pass a PEM certificate chain (leaf first) and its unencrypted key:

```bash
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert /path/to/cert-chain.pem \
  --tls-key /path/to/private-key.pem
```

Invalid files stop startup instead of falling back to HTTP. HTTPS only adds
encryption; it does not change authentication.

For LAN testing with [mkcert](https://github.com/FiloSottile/mkcert) (use your
host's real LAN IP):

```bash
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1 192.0.2.10
roamgate --host 0.0.0.0 --port 8443 \
  --tls-cert "$PWD/cert.pem" --tls-key "$PWD/key.pem"
```

Every device must trust the CA: copy only `rootCA.pem` (from `mkcert -CAROOT`),
**never `rootCA-key.pem`**. On iOS, install the profile and enable it under
Settings > General > About > Certificate Trust Settings. Clicking through
certificate warnings does not enable PWA features. Restart after renewing
certificates; services need absolute paths.

## Ranger model connection

Open **Ranger > Settings**, choose a **Provider**, and **Sign in** or **Enter API
key**. Then pick a model, allow workspaces under **Workspace access**, and
**Save settings**.
- **Claude Code** runs Ranger's turns on the bridge's `claude` command, signed
  in as it is (a Claude subscription or API key), with the Opus, Sonnet or
  Haiku model; its effort follows the thinking level. It is listed when
  `claude` is on the bridge's `PATH`. Claude Code's own tools, MCP servers,
  skills and hooks are off: it gets only Ranger's tools.
- **Shared Pi credentials** reuses Pi's `auth.json` and `models.json` for the
  bridge account instead of Ranger's own store.
- **Custom models** add an OpenAI- or Anthropic-compatible endpoint; use a
  separate provider ID per endpoint.
- On a **remote bridge**, use the provider's device-code or manual login; a
  `localhost` callback would reach the browser's machine, not the bridge.
- **High-permission mode** grants every workspace and skips confirmations.
  Workspace content may be sent to the model provider. High-permission settings
  saved by older versions keep their selected workspaces until you confirm the
  all-workspaces option once.
- On Windows SSH hosts, Ranger can read status and terminal output only.

Ranger runs as the bridge's OS account and keeps its data (credentials,
conversations, and scheduled tasks) in `~/.config/roamgate/assistant/`
(`%APPDATA%\roamgate\assistant\`, or `ROAMGATE_ASSISTANT_DIR`). It may contain
secrets: keep it private, use one bridge per directory, and stop the bridge
before backing it up. **Upgrades can migrate `tasks.sqlite` irreversibly**, so
older builds cannot open it: back up the directory before upgrading if you may
roll back.

The Pi SDK 1.4.0 dependency upgrade specifically migrates Durable SQLite
storage to schema version 2 when opened. Pi Durable 1.3.0 and earlier cannot
open that migrated database. Before deploying a build with this upgrade, stop
the bridge and back up the entire assistant directory; rolling back to a build
with Pi Durable 1.3.0 or earlier requires restoring the pre-upgrade backup too.
See the [Pi Durable 1.4.0 breaking changes](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/CHANGELOG.md#140---2026-10-21).

Unfinished questions and task runs resume after a bridge restart if their
original connections and workspaces are still the same; confirmed actions are
never repeated. See [Ranger](../FEATURES.md#ranger) and
[contracts](ARCHITECTURE.md#ranger).

## Web Push notifications

1. Use trusted HTTPS (or loopback HTTP). On iOS/iPadOS 16.4+, open the installed
   Home Screen app.
2. Enable **Task notifications**, grant permission, and choose **Task needs
   attention** and/or **Task completed**. **Background push** confirms the
   device is enrolled.

`roamgate push test` sends a test notification to every enrolled device. Push is
on by default; setting `ROAMGATE_WEB_PUSH_SUBJECT` to an empty value disables it
(otherwise it is an optional `mailto:` or HTTPS contact). After upgrading,
reload each browser/PWA once so the new notification worker is active.

VAPID keys and subscriptions live in `~/.config/roamgate/web-push.json`
(`%APPDATA%\roamgate\web-push.json`). **Keep it private and backed up**;
replacing it requires every device to re-enroll.

Delivery needs outbound HTTPS to the browser's push service (Apple, Google,
Mozilla, or Microsoft); no inbound port is needed. The bridge and Herdr must stay
running. By default (`--notification-source herdr`, Herdr 0.9+), Roamgate relays
Herdr's own notifications, matching its toasts and suppression rules. With
`status` (or older Herdr), Roamgate watches agents go from working to
blocked/done. Delivery is best-effort; messages expire after five minutes.

Turning notifications off revokes the subscription on the server first. Changing
the password does not revoke devices. Notification text can appear on lock
screens.

### Local notification testing

`http://localhost` and `http://127.0.0.1` are secure contexts, so notifications
work without TLS. Use an isolated data directory and browser profile. To test
end to end, enable **Task notifications**, ask Ranger for a monitoring task with
**Let Ranger decide**, confirm it, and use **Run now**. The automated
integration test covers scheduling and deduplication, but not real browser
delivery:

```sh
bun test server/src/assistant-recovery.integration.test.ts --test-name-pattern 'confirmed Ranger proposals schedule custom notifications'
```

## Logging

Logs have one line per event. `info` covers lifecycle events and failures. Use
`--log-level debug` (or `ROAMGATE_LOG_LEVEL=debug`) temporarily; debug logs can
include paths and IDs, but never URL tokens. `roamgate service logs -f` follows a
managed service.

### Latency samples

At `debug`, the server logs one line per Herdr control call (`herdr call`:
method, sizes, `total_ms`, `connect_ms`, `first_byte_ms` from request write to
first response byte), per ssh child exit (`ssh process exited`: caller `tag`,
`connection`, `master=true` for multiplexed commands, `host`, `code`, `total_ms`, live children, and
`startup_failures` for sshd `kex_exchange_identification` drops), and per typed
character echo (`terminal echo`: `input_to_surface_max_ms`,
`surface_to_send_ms`). The echo sample runs to the pane's next surface, which
other output can trigger first, so it is an upper bound; a character with no
surface within 5 s is not sampled. Tags ride on the argv array itself, so an
argv copied before it is spawned logs as `untagged`. Attach phases appear in `endpoint connected`.

The browser keeps its samples off by default. Add `?debugLatency` to the page
URL, or run `localStorage.setItem("roamgate:debugLatency", "1")` and reload,
then show the console's Verbose level. Lines start with `[latency]`: `refresh`
and `refresh call` per connection and method, `terminal echo` with
`input_to_frame_ms`, and `attach watchdog fired`.

### Performance profiling

Run a short CPU capture on a spare port, then reproduce the slow interaction in
that instance:

```bash
roamgate --host 127.0.0.1 --port 8788 --profile --profile-duration 30 --open
```

The capture stops automatically and writes a private directory under
`--profile-dir` containing `summary.txt` (CPU, memory, event-loop delay, hottest
functions) and `cpu.json` (raw Bun/JSC samples, **not** Chrome's `.cpuprofile`
format). Files may contain source paths; review before sharing and delete when
done. For readable function names, run from source with
`bun server/src/index.ts --profile`. For services, set `ROAMGATE_PROFILE=1` in
the environment file, restart, and remove it afterwards.

## Multiple and remote Herdr connections

The connection selector in the title bar adds, tests, connects, edits, and
removes profiles shared by all browsers; each browser picks its own.
`roamgate connections` does the same from a terminal. Disconnecting never stops
Herdr.

![Connection selector with local and SSH profiles](./screenshots/multi-connection-selector.png)

**SSH profiles** need an already-running remote Herdr and an OpenSSH alias or
`user@host`. Put ports, keys, and jump hosts in `~/.ssh/config`; Roamgate stores
no SSH secrets. Verify host keys and make sure non-interactive login works. Leave
socket paths empty to use the remote defaults. SSH profiles need a Linux/macOS
bridge; a Windows bridge supports local profiles only. File moves need `python3`
on the remote host.

**Windows SSH hosts:** choose **Windows** as the remote OS, install Herdr 0.9.1+
(including its `conpty/` directory), and start the session first. The SSH shell
must be able to run `powershell.exe`. Roamgate looks for `herdr.exe` on PATH and
in `%LOCALAPPDATA%\Programs\Herdr\bin\`, or you can set its path and session
name. Terminals and Herdr operations work; file, Git, worktree, and agent-history
features need a Unix host. Run Herdr and the SSH user at the same privilege
level: an elevated Herdr 0.9.4 server rejects ordinary clients unless started
with `--allow-unelevated-clients`.

Profiles are stored in `~/.config/roamgate/connections.json`
(`%APPDATA%\roamgate\connections.json`). `auto_connect` controls whether a
profile connects at startup. Transient SSH failures retry; authentication and
host-key failures do not. A Unix-host SSH profile holds two connections to its
host: the terminal tunnel and a command master shared by file, Git, search, and
upload commands; Roamgate keeps at most eight of these command sessions per
host, within sshd's default `MaxSessions 10`. A Windows-host profile opens one
connection per bridged socket client and has no command master. GUI preferences live in `settings.json` beside it.
Give each bridge on the same account its own `ROAMGATE_SETTINGS_PATH` (an
absolute, stable path; changing it requires logging in again).

Connection flags or variables such as `--ssh-host` create a read-only
`legacy-default` profile:

```bash
roamgate --ssh-host user@host
```

Explicit socket flags/variables override the SSH tunnel paths. See
[isolation](./ARCHITECTURE.md#connection-isolation) and
[SSH transport](./ARCHITECTURE.md#ssh-transport).

## PWA instance names

**Configuration > Instance > Title suffix** turns `Roamgate` into, for example,
`Roamgate · Home` in the page title and PWA name, so several servers are easy to
tell apart. The suffix (up to 32 characters) is saved on the server and shared by
all viewers. Set it before installing the PWA; already installed apps (especially
on Android) may keep the old name until the browser updates the manifest or you
reinstall.

## Reviews

Agents use `~/.cache/roamgate/bin/roamgate-review`, which Roamgate installs on
this machine and on each SSH host when the connection starts. It needs
`python3` there, and SSH hosts must allow stream-local forwarding (sshd's
default); a host without either only loses the review client. Merge request
reviews use the `glab` login on the checkout host, like the PR/MR status card.

### Export and import of the Reviews' state

What the Reviews panel authors lives in `settings.json` (`mr_reviews`: the
order, pins, removals, overrides, saved views, requests not proposed yet,
groups and workspaces headed upstream, efforts, merge rules, and the forge
hosts list, followed projects and suggestion hints) and, per upstreaming effort,
in `~/.config/roamgate/mr-reviews/efforts/<id>/` (`ledger.json` and the
append-only `history.jsonl`). To keep or move it:

```sh
roamgate reviews export --out reviews.json   # or to stdout without --out
roamgate reviews import reviews.json         # what it would change
roamgate reviews import reviews.json --apply # change it
```

The export is stable, key-sorted JSON: the same state gives the same file,
so it diffs and versions well. It never holds secrets (keys or values that
look like tokens, passwords or private keys are dropped), nor anything read
again from the forges or derived (inference, caches, `derived.json`), nor
the Undo journal; the clones and other settings stay out (the backup of
the rest of Roamgate is a separate matter). Forge tokens stay in `glab` and
`gh`'s own configuration, never in the hosts list. An export from an older
Roamgate (version 1) has no hosts, followed projects or hints, and importing
it keeps the local ones. An import lists every
added, removed and changed item, flags the ones whose local value is newer,
and changes nothing without `--apply`; it replaces the exported keys and
each effort's ledger and merges histories. The commands read the service's
`ROAMGATE_SETTINGS_PATH` like the server; a running server reads the
settings again on its next use, so reload the panel. The Reviews settings
have the same **Export** and **Import** (with the list of changes and an
**Apply** confirmation). Writing exports somewhere automatically,
committing or pushing them, is not done here.

### Permission prompts

The same client answers Claude Code's permission prompts from Roamgate (the
agent chat, or a card over the terminal) when it is registered as a
`PermissionRequest` hook in `~/.claude/settings.json` on each host:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.cache/roamgate/bin/roamgate-review permission --timeout 60",
            "timeout": 90
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "~/.cache/roamgate/bin/roamgate-review questions --timeout 180",
            "timeout": 210
          }
        ]
      }
    ]
  }
}
```

In conversation mode (`ROAMGATE_HEADLESS=1`) both hooks print nothing:
Roamgate asks over the headless process's own permission channel instead.

The `PreToolUse` hook answers Claude's multiple-choice questions
(`AskUserQuestion`) the same way: a form with each question's choices (or
several) and a field for one's own answer; the answers go back as the tool's
input, so Claude Code does not ask them again.

Claude Code holds its own dialog while the hook runs, so the hook waits only
while a browser is connected, for `--timeout` seconds at most (60 by
default); unanswered, the terminal asks as usual. Outside Herdr, or without
Roamgate, it returns at once.

### Starting claude in conversation mode

**Configuration > Integrations > Start claude in conversation mode** (the
`claude_start_mode` key of `settings.json`: `terminal`, the default, or
`conversation`) makes a `claude` started by hand in a Herdr pane go to
conversation mode once it is up. Nothing is set up by hand: once the
setting is `conversation`, Roamgate adds this `SessionStart` hook to
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) on this
machine and on each SSH host it connects to, beside the hooks already
there:

```json
{
  "matcher": "startup|resume",
  "hooks": [
    {
      "type": "command",
      "command": "~/.cache/roamgate/bin/roamgate-review claude-start",
      "timeout": 10
    }
  ]
}
```

A settings file that is not plain JSON is left alone (the log says so); add
the entry by hand then. The hook stays when the setting goes back to
`terminal`: it then does nothing. Remove the entry to take it out.

The hook prints nothing and does not wait: it tells Roamgate which pane and
session started (a claude started or resumed, not `/clear`, not `claude
-p`), and Roamgate hands the session over as the chat's switch does, once
Claude shows its empty prompt: `/exit`, then the pane holder. `claude`,
`claude -c` and `claude --resume <id>` keep their session; `--model`,
`--permission-mode`, `--add-dir` and the other flags the terminal keeps on
a hand-back go to the headless process too. A prompt given on the command
line runs in the terminal, and the session moves once that turn ends.
Claude stays in the terminal when its prompt box has text in it, when it
is started with `ROAMGATE_CLAUDE_START=terminal` in its environment, and
when its pane's session went back to the terminal less than a minute
before (the claude the holder resumes on a hand-back has that variable
set, so it is never taken again at once). Enter in the pane, or the
chat's switch, takes a session back to the terminal as usual.

### Stopping idle conversations

**Configuration > Integrations > Stop idle conversations** (the
`conversation.idle_stop_minutes` key of `settings.json`, a whole number of
minutes from 0 to 1440, 30 by default, 0 for never) stops the headless
claude of a conversation-mode session that sat idle that long, checked once
a minute; its pane holder stays, and so does the chat. The next message
starts it again (`--resume`) and is then delivered once:

```json
{ "conversation": { "idle_stop_minutes": 30 } }
```

A session is never stopped while a turn runs, a permission or question
waits for you, background work (a background command, a subagent) or a
`!` line runs, messages wait in its queue, a voice socket is open or was
used in the last 10 minutes, the voice companion has a job on it, or
another session's message reached it in the last 10 minutes.

## Agent profiles

A profile says how Roamgate starts Claude Code: mostly the environment it
starts with (another endpoint, its token, the models of Claude Code's model
slots), and optionally another program. The built-in **Claude** profile is
plain `claude`; with no other profile, every agent starts exactly as it
always did. Edit them in **Configuration > Integrations > Agent profiles**,
or under `profiles` in `settings.json`:

```json
{
  "profiles": {
    "list": [
      {
        "name": "Igalia GLM",
        "agent": "claude",
        "env": {
          "ANTHROPIC_BASE_URL": "https://ai.example.com",
          "ANTHROPIC_AUTH_TOKEN": {
            "file": "~/.config/roamgate/secrets/ai-token"
          },
          "ANTHROPIC_MODEL": "glm-5p3",
          "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5p3",
          "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5p3",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5p3-flash",
          "ANTHROPIC_SMALL_FAST_MODEL": "glm-5p3-flash",
          "CLAUDE_CODE_SUBAGENT_MODEL": "glm-5p3"
        }
      }
    ],
    "default": "Claude",
    "return_after_reset": false
  }
}
```

- `agent` is the agent driver (`claude`); `command` names another program
  (default: the driver's own, `claude`); `unset` lists variables to remove.
  A profile that sets `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` also
  removes the other one, `CLAUDE_CODE_OAUTH_TOKEN` and the Bedrock/Vertex
  switches, so the pane's own key never goes with it; one that sets
  `ANTHROPIC_BASE_URL` removes the Bedrock/Vertex switches.
- A value is text, or `{"file": "<path>"}`: a secret file Roamgate reads
  (its final newline dropped) each time it starts the agent. The file must
  be readable by its owner only (`chmod 600`); Roamgate refuses it
  otherwise. Browsers see the path, never the value, and logs name only the
  variables. Keep tokens in files: plain values are shown in the settings.
- `default` (the built-in Claude unless set) is what new sessions, the
  Claude in conversation mode, the reviews' Claude (in the review
  workspace and in a request's home), Ranger's Claude Code turns, the
  reviews agent and the voice helpers (front, router, cleaner, research,
  tools) start with. `claude_command` in `voice.json` still wins
  for the voice helpers.
- For a profile with `ANTHROPIC_BASE_URL`, the settings list its server's
  models (`GET <base>/v1/models`, with its token as both `Authorization:
  Bearer` and `x-api-key`, kept an hour, embedding models left out) as
  choices for the model slots, and warn about a configured model the server
  no longer offers. The built-in Claude offers its aliases.
- A usage limit is read from the end of the session's transcript: the
  newest assistant record, when it is Claude Code's limit message (or an
  API 429), and only until the reset time it gives, read from when it was
  hit. **Retry** sends `continue` on the same profile.
- `return_after_reset`: after a usage limit sent a session to another
  profile (**Continue with**), it goes back to the default once the reset
  time the limit message gave has passed, checked each minute (when idle;
  else at the next check).

Each session can run with another profile (**Run with**): Roamgate
remembers that choice by session id (`session-profiles.json` in its data
directory). A session in the terminal is exited with `/exit` when idle and
resumed (`--resume`, same transcript) with the profile; one in conversation
mode has its headless process restarted with it. Switching between Claude
and another Anthropic-compatible backend keeps the conversation both ways,
thinking turns of either side included. Claude Code resumes a session on the model
it last answered with; when the new profile's endpoint does not have that
model (`kimi-k3p1-pro` back on Claude), Roamgate starts the session with
`--model`: the last model it had on that endpoint, else the profile's own
model, else `opus`. Once the session answered there, its own model choice
(`/model`) holds again.

Nothing secret is ever typed into a pane. When the profile is not plain
`claude`, what Roamgate types is `roamgate-hold --launch <token>`: the
pane's holder trades the one-use token (two minutes, that pane only) for the
program and environment over Roamgate's socket and becomes the agent. The
same goes for conversation mode's headless process and a hand-back to the
terminal. So profiles work on SSH hosts too: the secret file is read on this
machine and the environment travels to the host's holder; the program must
exist on the host.

## Voice chat

Without this setup, Speak reads replies with the browser's speech synthesis
and voice chat cannot listen (see the Speak entry in
[FEATURES.md](../FEATURES.md)). An agent chat can be spoken to and listened
to (the microphone beside its message box) when the server has a voice
helper, Roamgate's voice engine: `voice/helper`, a small Rust
program that keeps two models loaded, Whisper for speech to text
(`whispertranscriber`) and Kokoro for text to speech (`kokorosynthesizer`),
both GStreamer elements from gst-plugins-rs. The browser streams its microphone
to it over `/api/voice/ws`, or in a call by WebRTC (see "Voice calls"); the
helper tells speech from noise and silence
with RNNoise (`audiornnoise`), and `speechgate` (from the same
gst-plugins-rs branch as the Parakeet element) lets only the speech through
to the transcriber, ending each utterance when the speaker is done; the
speaker and turn models below are its properties.
`cargo build --release` in `voice/helper` makes one binary with GStreamer,
those plugins and ONNX Runtime linked in: it downloads a prebuilt GStreamer
package once through gstreamer-rs's `binary` feature, GStreamer's official
one on macOS (about 720 MB), and on Linux (x86-64) the bundle
`voice/helper/Cargo.toml` names (about 580 MB). Whisper and the any-tts
models run on the GPU, with Metal on macOS and with CUDA on Linux, where the
build needs the CUDA toolkit and the binary its libraries.
`voice/helper/linux/build.sh [--test] [directory]` builds the Linux binary
with Podman, in a container that has the toolkit, and writes it to the
directory with those libraries in `lib/` beside it, where it finds them:
installed as a whole, it needs only the NVIDIA driver on the host. Kokoro
also needs espeak-ng installed (`brew install espeak-ng`, or the
distribution's `espeak-ng` package).

With `GST_DEBUG_DUMP_DOT_DIR` set in Roamgate's environment, the helper
writes its pipelines' graphs there (`roamgate-voice-speak.dot`,
`roamgate-voice-listen.dot`) when they start
and again once audio has gone through them; `dot -Tsvg` renders them.

Point `voice.json` in Roamgate's data directory (`~/.config/roamgate/` on
Linux and macOS) at the helper and the models:

```json
{
  "helper": "/path/to/roamgate-voice",
  "whisper_model": "/path/to/ggml-large-v3-turbo.bin",
  "kokoro_model": "/path/to/kokoro-v1.0.onnx",
  "kokoro_voices": "/path/to/voices-v1.0.bin"
}
```

With `"parakeet_model"`, a directory with
istupakov/parakeet-tdt-0.6b-v3-onnx's `nemo128.onnx`,
`encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx` and `vocab.txt`,
Parakeet TDT v3 transcribes in place of Whisper (then `whisper_model` is not
needed), with the `parakeettranscriber` element from the same gst-plugins-rs
branch: it writes 25 European languages as spoken, never translating, and
takes about 0.1 s for a few seconds of speech on a CPU.
Parakeet has no language setting, and on some French speech (a voice it
knows less, music under it, an English word in it) it drifts to English
words that sound alike ("Mets un peu de musique et baisse le volume" came
out "Well put the music and best of the volume"). With `whisper_model` set
too, Whisper (loaded beside Parakeet once something was heard, about 1 GB)
hears again a final that reads as English while the conversation is in
another language (the last reply read, or the last thing said): when it
hears that language more than English, it reads the utterance again in it,
about a second more, and the log says `said in fr, not English`. Speech
really in English is kept as Parakeet wrote it, and so is French with
English words in it.
With `"speaker_model"` (sherpa-onnx's `wespeaker_en_voxceleb_resnet34.onnx`),
the voices heard in a voice chat are told apart (A, B, C...) and every
utterance is transcribed and given to the companion with who said it:
`[you 0.58]`, `[voice B, 0.07 like you]`, `[mixed: you + B]`, or
`[voice A]` while your voice is not known yet. Which voice is yours is
learnt from the conversation, never from the first sound heard: the voice
whose words the companion takes up (answers, passes on, looks up) is
yours, one whose words it leaves is not, and the companion can say so
itself (as after asking "c'était pour moi ?"). The companion answers you
and leaves background voices (a radio, a TV, people nearby) unless they
clearly speak to it; while a reply or the call's music plays, only your
voice cuts it. Without a companion, words of a voice clearly not yours, or
of someone else known, are held, not sent. The log has one line per
utterance (`voice B (92%) in 3.1 s of voice [...], similarity: A 0.05,
B 0.71`), each stretch's scores with `ROAMGATE_VOICE_DEBUG`, and the
label, route and any name given of each turn in the voice debug log.

Voice profiles: the voices heard often are kept across calls, so the
companion knows you and the people around you by name: `[Thibault (you) 0.91]`, `[Simon 0.84]`,
`[voice C, maybe Simon 0.52]`, `[voice C, unknown]`, `[mixed: you +
Simon]`, with every score behind the label beside it. Your own profile
makes your voice "you" from your first words on a call, and is told to the
helper so that only your voice cuts a reply from the start. Names come
from the conversation: "c'est Simon qui parle", "that was my daughter Elo",
"moi c'est Thibault"; saying a name is wrong ("non, c'est Oli") corrects
it, and what the wrong person learnt from that call is undone. A voice no
one is, heard for a while on several calls, is kept unnamed, and the
companion asks once who it is.

Each person is one file in `~/.config/roamgate/voice-profiles/` (or
`%APPDATA%\roamgate\voice-profiles\` on Windows), private to your user:
a name, a role (`user`, `family`, `other`, or `unknown` for a voice not
named yet), how much and when they were heard, and up to six voice prints,
about one per microphone or room (the phone, a headset, the desktop). A
print is a speaker embedding (256 numbers from the WeSpeaker model)
averaged over many seconds of confident speech: no audio is ever kept.
Voice prints are biometric data. They stay on this machine, are never
sent anywhere but to the local voice helper, and are only learnt from
utterances of one voice, unmixed, that are surely that person's.

To forget a person, delete their file (`grep -l '"name":"Simon"'
~/.config/roamgate/voice-profiles/*.json` finds it); to forget every voice,
delete the directory. A file deleted while the server runs stays deleted:
the next call reads the directory again and nothing is written back.

In noisy places, `"drop_other_voices": true` goes back to keeping one
voice: only the voice of whoever speaks first in a voice chat counts (learnt from
its first two seconds of speech), and other voices are dropped before they
are transcribed.
That first voice may not be yours: music, a reply played aloud, a TV or
someone else talking when the voice chat starts is then kept, and your
own words are left out instead. With it, `"speaker_reference"`, a list of
recordings of your voice (any audio file the helper decodes, a few seconds
each), your voice is learnt from them instead, whatever is heard first; give
one per language you speak, since a voice scores lower against itself in
another language, and a French sentence after an English start can be cut:

```json
"speaker_reference": ["/path/to/me-fr.wav", "/path/to/me-en.wav"]
```

The log says which voice was kept: `the speaker's voice is taken from their
reference recordings`, or `a new speaker: the first voice heard is taken as
theirs`, and with `ROAMGATE_VOICE_DEBUG` the first words heard from it. With `"turn_model"` (Pipecat's
`smart-turn-v3.2-cpu.onnx`), a pause ends speech only when the model hears
a finished turn: thinking pauses rarely cut a message, and 5 s of silence
ends one anyway (with `"text_turn_model"`, see below). With Parakeet, `"text_turn_model"` (the directory of
onnx-community/Qwen3-0.6B-ONNX: `onnx/model_int8.onnx`, `tokenizer.json`,
`config.json`) also reads what was said at each pause: words that are
clearly unfinished ("I think we should find a way to") keep the turn open,
clearly finished ones end it sooner. When the voice sounds finished but the
words keep the turn open, a pause of `"max_pause_ms"` (8000 by default, 2000
to 15000; "Longest pause before your turn ends" in Speech settings) ends it;
a question asked whole (its words end in "?") ends after 2.5 s, and a voice
that sounds surely finished after 3 s, whatever the words read like (both
never longer than that setting).
A pause whose voice does not sound finished, such as one to look for a word,
or one after "um" or "euh" (said, or heard as a short sound that added no
word), lasts up to 15 s, and any voice starts the count again. Whisper models are
whisper.cpp's ggml files; the Kokoro model and voices are
the v1.0 files of kokoro-onnx's releases. A helper built against an installed
GStreamer instead finds its plugins in `gst_prefix`, when given. The helper
starts with the first voice request and stops with the server, or after
`"helper_idle_exit_minutes"` minutes with no call, listening or speech,
giving back the memory its models hold. The next voice request starts it
again, its first sentence waiting for the models to load. Unset or 0, the
default, the helper keeps running.

`"helper_wrapper"` runs the helper through another program, to run it in a
container, as a service of its own, or with a GPU the wrapper frees for it:
a list of arguments put before the helper's command, empty by default.

```json
"helper_wrapper": ["/path/to/wrapper", "--"],
"helper_idle_exit_minutes": 10
```

The wrapper passes the helper's standard input and output through
unchanged, and gives it its environment: a wrapper that starts the helper
elsewhere passes on what the helper reads in Roamgate's
(`ROAMGATE_VOICE_DEBUG`, `ROAMGATE_VOICE_ICE_ADDRESSES`, `GST_DEBUG`).
Roamgate stops a wrapped helper by closing its standard input, which ends
it within 10 s, and signals the wrapper only if it still runs 15 s later,
since a wrapper may not pass signals on.

The helper's standard output carries only its frames to Roamgate: anything
else written there goes to its standard error, in Roamgate's log. A helper that writes something
that is not a frame is restarted at once, the log showing the first bytes
it wrote. When the helper stops, each listening it had ends with what was
heard, and the page listens again on the same voice link.
With `"tts_models"`, [any-tts](https://github.com/TM9657/any-tts) models read
replies in place of Kokoro's ONNX model (then `kokoro_model` and
`kokoro_voices` are not needed), through the `anyttssynthesizer` element from
the same gst-plugins-rs branch, on the GPU. They are listed in order
of preference, and each sentence goes to the first one speaking its
language; `"model"` names each, the other fields are the element's for it:

```json
"tts_models": [
  {
    "model": "qwen3-tts",
    "path": "/path/to/Qwen3-TTS-12Hz-1.7B-Base",
    "voice_embedding": "/path/to/my-voice.json"
  },
  { "model": "kokoro", "path": "/path/to/Kokoro-82M" }
]
```

`path` is the model's directory from Hugging Face; Qwen3-TTS speaks with one
of its stock speakers (`"speaker"` or the element's `"voice"`, such as
`"ryan"`, with a CustomVoice model) or a cloned one (`"voice_embedding"`, a
Base model and a voice saved with any-tts). A model that fails to load is
left out.

With `kokoro_model` and `kokoro_voices` too, a sentence only Kokoro reads
(Kokoro's entries alone, as when a sentence another model failed is said
again with Kokoro) is read by Kokoro's ONNX model on the CPU rather than
any-tts's Kokoro: its phonemes come from espeak-ng, as Kokoro was trained
with, where any-tts's own rules mangle French. any-tts's Kokoro still reads
it when the ONNX model fails to load.

The stock speakers are listed and chosen from the Speech section of
Configuration next to the cloned voices and Kokoro, when a Qwen3-TTS
CustomVoice model is found: `"stock_model"`, else the first Qwen3-TTS model
of `tts_models` that is one, else a `*CustomVoice*` directory next to them
(`Qwen3-TTS-12Hz-1.7B-CustomVoice` beside the Base model). Its
`config.json` names the speakers: Ryan and Aiden (English), Vivian, Serena,
Uncle Fu, Dylan and Eric (Chinese), Ono Anna (Japanese) and Sohee (Korean)
for Qwen's 0.6B and 1.7B models. Each speaks every language Qwen3-TTS does,
most naturally its own. Choosing one writes a Qwen3-TTS entry with that
model and `"voice"`; a voice cloned for one language and a stock speaker
for the others load both models. The models no longer read with are kept
as `"clone_model"` and `"stock_model"`, so voices can still be recorded and
chosen again.

Voices are cloned from the Speech section of Configuration with a Qwen3-TTS Base
model (`"clone_model"`, or the first Qwen3-TTS model of `tts_models` that is
a Base model): the helper reads the recording (any format GStreamer
decodes), cuts its silences, transcribes it (with Parakeet or Whisper), and
computes the voice natively with candle (the Base model's ECAPA-TDNN speaker
encoder and its speech tokenizer's Mimi encoder), in a couple of seconds on
the CPU. The words kept with the voice must be what the recording says: the
text shown when it was heard read to its end, the start of it as far as it
was read when the reading stopped early or the recording was cut mid-speech,
else what was heard. Each voice is
`<voices_dir>/<id>.json` (any-tts's voice embedding) with its recording
`<id>.wav`; `voices_dir` is `~/.local/share/roamgate/voices` by default, and
its `voices.json` lists the voices with their names, those `tts_models`
reads with included. Choosing voices rewrites the Qwen3-TTS entries of
`tts_models` (one per language with its own voice, `"languages": "fr"`, then
one for every other language), keeps the other models after them, and the
running helper switches to them from the next sentence. From a shell,
`roamgate-voice --clone rec.wav --model <Qwen3-TTS Base dir> --text "what it
says" --output voice.json` makes one.
`"voice_surprise": true` (Surprise, from the Speech section)
reads each reply with one of the listed voices at random, Kokoro left out:
the page names each reply it reads, and the server picks a voice at its
first sentence (any of them, whatever the reply's language, never the
voice of the reply before when another may read) and has the helper read that reply's sentences with it, as a sample
is read: the helper switches voices once per reply, keeping its models
loaded. Choosing a voice turns it off.
Only Kokoro takes a speed: when every model is Kokoro and none sets its own
`"speed"`, they are given `speech_rate`; otherwise the models speak at their
own pace (Qwen3-TTS has no speed control) and the helper makes their speech
faster with GStreamer's soundtouch `pitch` element, keeping the pitch.
Browsers only
give the microphone to secure pages: reach Roamgate over HTTPS or localhost.

With `"clean_model"` (a Claude model, such as `"haiku"`), what is said goes
through Claude Code before it is sent: fillers, false starts and misheard
words are cleaned up, and words said to someone else in the room are held
rather than sent. Two Claude Code sessions are kept running in the
background (`claude -p`, with `--safe-mode` and no tools), on the account
`claude` is logged in with; `"claude_command"` names another command (else the
default [agent profile](#agent-profiles)).
Sentences are cleaned while the user still talks and the end as soon as
they pause, so little time is added; a failing or slow model sends the words
as heard.

Dictation ([protocol](ARCHITECTURE.md#dictation)) cleans what is dictated
into a text field with `"dictation_model"`: `"opus"` (at low effort) by
default, any Claude model, or `"off"` to type the words as heard.
`"dictation_command"` is its Claude Code command, `"claude_command"` by
default. Its two background sessions read the voice companion's long-term
memories, never writing them. The field's text around the cursor and what
is said go to that model through Claude Code's login, as the companion's
requests do; nothing of it is logged or kept.

`"speech_rate"` (0.5 to 2, 1.2 by default) is how fast replies are read, as
a multiple of the voice's own pace; the voice card's speed button and
**Configuration > Speech** change it and write it back to
`voice.json`, for every browser. A page asks for each sentence at its
reading speed and the server makes it at that speed, keeping its pitch;
speech comes with the rate it was made at (`X-Voice-Native-Rate`, 1 for
the voice's own pace), and a helper without soundtouch leaves the rest
to the browser outside a call.

With `"route_model"` (a Claude model, such as `"haiku"`), each thing said
goes first to one background Claude Code session that decides who it is for:
the agent on screen, another agent session (to show it, or to send it the
words), Ranger (a question about the sessions, sent as if typed in its
chat, which needs Ranger's model and workspaces set up), or nobody. The
page gives it the agent sessions of every connection
it reads (title, workspace, folder, machine). Haiku decides in about a
second; a router that fails or takes over 8 seconds leaves the words to the
agent on screen.
`"errand_folder"` names the folder of the agent session (a tasks repository,
say) that questions and errands about none of the sessions go to; its answer
is read aloud once it settles.

With `"front_model"` (a Claude model, such as `"opus"` or `"haiku"`), a
front decides in the router's place and in the same call says something
aloud at once: what it does with the words, or the answer to what Roamgate's
state answers. Its words are written first in its answer and said as soon
as they are written, while it writes the rest (the route, the words for the
session, its context note). Two background Claude Code sessions are kept
running for it, as for the router (`--safe-mode`, no tools, no Herdr pane
variables): one for what the user says, one for telling events and answers,
so a turn never waits behind an answer being told. Each
request gives it the agent sessions plus Ranger's tasks, the merge and pull
requests the page knows and the notifications of the last half hour; it
never sees files or terminals. The words go on to the agents as said.
Only the front's own words are said: no canned acknowledgement while it
is slow, no "not for me" line for words it routes to nobody (the card
shows them), and "still working" only on a turn it said nothing about
for 45 seconds. A front that fails or takes over 15 seconds leaves the
words to the agent on screen, unsaid. The page sends the last few
sentences routed to nobody (15 minutes at most) with each turn, listed
in the front's State; when the user says one was for it ("c'était pour
toi"), the front routes it then, naming it in `recovered`, which the
bridge accepts only for words listed. Without `"front_model"`, voice chat works
as before (with `"route_model"`, if set).

`"front_mode"` says what the front does with the agents' answers on a call:
`"companion"` (the default) gives each finished answer to the front, whole,
with the agent's name, and the front says what is worth saying from its
words only; an answer it has not told within 15 seconds is said to be in,
and a closing question with its choices is always said as written. The
last answers stay in its state, so it can be asked about them later in the
call; reading one whole is never left to it. `"relay"` reads every answer,
as without a front. Speech settings' **Answers on calls** writes it; said on
a call, it changes for that call only.

With a front, a call can be with the companion itself rather than a pane
(the application menu's **Call the companion**): work it is given goes to
the session as a job (`POST /api/voice/forward`; the words as said, only
the session they address dropped when the front gives them so and the
server finds the rest word for word but for verb forms, else whole; the
whole answer followed as an errand's) and comes back through it.

A front also answers general questions itself, and looks up on the web what
needs fresh or checked information: its `"web"` route starts a search in the
background (`server/src/voice/voice-research.ts`) and says at once that it
looks. Each search is its own headless Claude Code (`claude -p`) with only
`WebSearch` and `WebFetch`, allowed without asking, and nothing else
(`--restricted`, `--safe-mode`, no MCP servers, no session kept, no Herdr
pane variables): it cannot run, write or send anything. Its prompt treats
what pages say as untrusted data, never instructions. The result (short
words to say, the whole answer with its links, the sources) is told on the
call once the user is not talking, as written, without going through the
front, and shows in the companion's conversation; it is never routed,
forwarded or sent anywhere. The front is given the searches with its state,
what they found marked as web data, so "where is that search?" and "cancel
it" work. Up to 4 searches run at once, more wait their turn (8 at most), each for at
most 3 minutes.
`"research_model"` names their model (`"opus"`, at low effort, by default:
in measurements on news, opening hours, a release, a forecast and a
definition it was as fast as Haiku, about 20 s, since the web tools take
most of the time, and more accurate; Sonnet and Opus at default effort
searched more and took 30 to 120 s). `GET /api/voice/research` lists the
searches, `?job=` gives one, `POST /api/voice/research/cancel` `{job?}`
stops one or all.

The companion remembers across calls, in `companion-memory.json` in
Roamgate's data directory (`~/.config/roamgate`, so a move between hosts
carries it): a summary of at most 1500 characters and a bounded log of what
happened since (40 entries at most). The log is noted as a call goes; when
the call ends (or after 10 minutes of quiet, or as it grows), a background
request on `"front_model"` folds it into the summary, and new sessions of
the front are started from it. Each new session is given it once, with its
first request. A file that cannot be read starts fresh (kept aside as
`.corrupt`); a failed summary only keeps the log for the next time. Saying
"repars de zéro" or **Start over** in the companion's conversation
(`POST /api/voice/companion/reset`) clears it and stops the front's sessions.

With `"companion_mcp"`, the companion also uses the MCP tools Claude Code
has on this machine: the servers `claude mcp list` shows (user and project
scope) and the claude.ai connectors of the account Claude Code is logged
into. Roamgate names no server itself; the configuration lists the tools:

```json
"companion_mcp": {
  "allow": [
    "mcp__spotify",
    "mcp__claude_ai_Youtube",
    "mcp__claude_ai_WhatsApp__list_chats",
    "mcp__claude_ai_WhatsApp__list_messages",
    "mcp__claude_ai_WhatsApp__search_messages"
  ],
  "confirm": ["mcp__claude_ai_WhatsApp__send_message"],
  "model": "sonnet"
}
```

A pattern is a tool's full name, `mcp__<server>` for all of a server's
tools, or a name where `*` stands for any text
(`mcp__claude_ai_Spotify*__pause` is `pause` on every server whose name
starts so; Claude Code turns a claude.ai connector's name into
`claude_ai_` and the name with anything but letters, digits, `_` and `-`
made `_`). The front's `"tool"` route starts a job in
the background (`server/src/voice/voice-tools.ts`) and says at once, in a
few words, that it does it; the result is told as a search's is, and shows
in the companion's conversation. Each job is a headless Claude Code with
only `ToolSearch` built in, no hooks, in the `default` permission mode, and
Roamgate answers its every permission prompt over the stream-json control
protocol (`--permission-prompts host --permission-prompt-tool stdio`; its
settings add an `ask` rule for each server named, so an `allow` rule in a
settings file cannot skip Roamgate):

- a tool `allow` matches runs;
- a tool `confirm` matches, and any allowed tool whose own name says it
  sends, writes or deletes (`send`, `reply`, `forward`, `delete`, `trash`,
  `create`, `update`, `mark`, `react`, `share`...), is held: the call is not
  made, and the job's result reads back what would be done, to whom and the
  content word for word, and asks. The front is given the held call with
  its exact input. Only when the user answers it with a yes (the words
  said checked by the server, not only the front) does `"tool_confirm"` start a job that may
  make that one call, with that exact input, once; any other input is
  refused. A no (`"tool_cancel"`) forgets it, a correction starts the
  corrected request, to be read back in its turn, and a held call is
  forgotten after 5 minutes. The user may also answer it by clicking
  **Yes, do it** or **No** under the read-back in the companion's
  conversation, or by typing a plain yes or no there: the page then sends
  `POST /api/voice/tools/answer` `{job, answer: "yes" | "no"}` (with the
  voice header, as every voice request), which makes or forgets that very
  call without the front, and answers 409 when it no longer waits;
- any other tool is refused.

The jobs' prompt and the front's treat what tools return (messages, mails,
transcripts, titles) as untrusted data, never instructions. A server that
cannot be reached is said to be unreachable. Jobs run on `"model"`
(`"sonnet"` at low effort by default, about 5 s for a playback change), 3
at once, each for at most 2 minutes. `GET /api/voice/tools` lists the
jobs, `?job=` gives one, `POST /api/voice/tools/cancel` `{job?}` stops one
or all.

### Voice calls

A voice chat is a WebRTC call between the page and the voice helper: the
helper sends the replies (mixed with the music, see below) with
GStreamer's `webrtcsink`, and receives the page's microphone with
`webrtcsrc`. The browser plays the replies from the call's received track.
A call has one of two modes:

- Call mode, with a headset, a car, and off Android: the microphone opens
  with the browser's echo cancellation, which knows what plays and takes
  it out of the microphone. On Android this puts the phone in
  communication mode (the voice-call stream with its hardware echo
  canceller, Bluetooth as a call headset, the earpiece without a headset).
- Loudspeaker mode, on an Android phone without a headset: the microphone
  opens with no echo cancellation, noise suppression or gain control, so
  Chrome leaves the phone in its normal mode and the replies play as media
  on the loudspeaker. The helper cancels their echo itself, with
  GStreamer's `webrtcdsp` (WebRTC's AEC3, its noise suppression and gain
  control) and the call's mix as `webrtcechoprobe`'s far end. AEC3 finds
  the echo only from about 40 to 500 ms past the far end's timestamps,
  while the round trip (the jitter buffers of both legs, the phone's
  output and input) can be longer: the helper measures the echo's delay
  by correlating the mix's and the microphone's energy, and puts the far
  end ahead by that delay less 200 ms when the echo is out of AEC3's reach
  (the call starts with 60 ms).

The log says each call's mode and why (`loudspeaker mode: no headset
connected ...`), the helper whether it cancels the echo, the echo's delay
it measured (`echo canceller: the echo comes 640 ms after the replies go
out ...: the far end now leads by 440 ms`), and after each stretch of
echo in loudspeaker mode how much it took out (`echo canceller: over 3.2 s
of the replies' echo (640 ms late), the microphone at ... dBFS, ... dBFS
once cancelled (... dB taken out of a 10 ms frame, the median)`), leaving
out where the user talks over the replies. The levels are after the
canceller's gain control, which raises a quiet microphone. The page signals with
[gstwebrtc-api](https://www.npmjs.com/package/gstwebrtc-api) on
`/api/voice/call/signalling`, which Roamgate fronts, behind its login, to
the signalling server the helper runs for that call on 127.0.0.1 only
(`docs/ARCHITECTURE.md`, "Voice calls"). The microphone leaves the phone
only while the call listens. With a helper or a browser that cannot make
the call, replies play one sentence at a time as below and the microphone
streams on the voice socket.

On a phone's own loudspeaker, Android plays a call on the voice-call
stream, quieter than media, and the speech models make their speech at
-20 to -24 LUFS. The helper brings each voice's replies to
`call_reply_loudness` in `voice.json` (-16 LUFS by default, -40 to -6;
`false` leaves them as made), their peaks held under -1 dBTP by a
look-ahead limiter. A sentence goes into the call as it is made, so each
one is measured (ITU-R BS.1770), and the next sentence the same voice
reads in that language gets the gain that brings it to the target; a
voice not heard yet is taken to make -24 LUFS. With `ROAMGATE_VOICE_DEBUG`
the log says `a reply made at <LUFS>, raised <dB>`.

Chrome on Android lists no audio output to a page but the default:
`setSinkId` has nothing to choose and there is no `selectAudioOutput`. It
lists the phone's communication devices as microphones instead
("Speakerphone", "Headset earpiece", "Bluetooth headset", ...), and opening
one in call mode routes the call there. The call's controls show where it
plays, and a tap moves it to the next: the loudspeaker (loudspeaker mode),
the earpiece, a headset (call mode, the microphone opened again on that
device). Moving between the two modes pauses the replies about 5 s: the
microphone closes, and Chrome keeps an idle output stream 5 s before
closing it, which a new one would take again in the old mode.

The call's media goes over UDP. The helper's ICE agents use the machine's
IPv4 addresses and 127.0.0.1, on ports 40000 to 40999, and no STUN or
TURN server: a phone on the same network reaches the first, and a phone
on Tailscale reaches the second when `tailscaled` runs with
`--tun=userspace-networking`, which forwards UDP sent to the machine's
Tailscale address to 127.0.0.1 on the same port. Roamgate gives the page
the helper's 127.0.0.1 candidates at that address, set in `voice.json`
(`tailscale ip -4` prints it; with a custom socket,
`tailscale --socket=<path> ip -4`):

```json
"call_ice_address": "100.71.231.65"
```

Nothing else changes in Tailscale (no `tailscale serve` entry, no ACL for
the ports). A firewall between a phone and the machine on the same
network must let UDP 40000 to 40999 through to the helper, or the call
uses Tailscale. `ROAMGATE_VOICE_ICE_ADDRESSES` in Roamgate's environment
(comma-separated, such as `127.0.0.1`) gives the helper's agents only
those addresses. A helper built from source needs the GStreamer bundle's
`webrtc`, `nice`, `dtls`, `srtp`, `rtpmanager`, `rtp` and
`debugutilsbad` plugins, which `voice/helper/Cargo.toml` lists.

With `ROAMGATE_VOICE_DEBUG`, the trace says, for each call, the ICE path
each way took (`call 7: microphone: ICE host udp ... -> host udp
100.71.231.65:40012, not relayed`, the same for `replies`: candidate
types, UDP or TCP, relayed or not), every 15 s the microphone's
`echoReturnLoss` and `echoReturnLossEnhancement` as the browser reports
them (or that it reports none), once a voice chat which microphone
listens, whether its echo cancellation, noise suppression and auto gain
are on and which outputs the browser knows, and the helper's ICE states.

### Voice calls on the move

A call is meant to survive a phone changing networks. The voice socket
carries what is said of the listening (and, without WebRTC, the
microphone): its listening session outlives the socket on the server for
20 s, and the page opens a new socket and resumes it. A WebRTC leg whose
ICE connection fails, or stays disconnected 4 s, is negotiated again (a
new session on the same signalling), and a lost signalling socket is
opened again with both legs, for as long as the call lasts. A signalling
that never opened at all is tried six times; the call then ends, the page
says so, and the chat goes on with the replies played in the page and the
microphone on the voice socket. What the microphone said while the network
was gone is lost: it is not sent again afterwards (only a call without
WebRTC sends the socket's missed audio again). A listening that hears
nothing for 5 s waits for the stream to come back, and one nobody resumes
ends its utterance with what was heard. On the call's microphone, a
listening that hears nothing for 5 s stays on its socket: it ends at once
with what was heard when the microphone's leg is down, and 20 s later when
the stream does not come back. A microphone leg the helper ends, or whose
microphone fails, is published again, five times within a minute at most.
A call left by its chat ends 5 s later, unless a rebuilt chat takes it. When the page's own connection
drops, the chat is rebuilt; the listening in progress is kept across that
and the call goes on, controlled from the new chat. Two short tones say
it had to reconnect. Words heard but never sent stay above the chat's
message box, to send by hand. A page in a call takes a newer build
between turns only, and the call goes on in the reloaded page.

Without WebRTC, replies play through the AudioContext the microphone
streams through, at any reading speed, not as media: Android's media
session has nothing to pause and a car's media controls nothing to control
(they are logged and ignored), and no media element of the page competes
for the audio focus (other apps' music is not paused then). Speech
settings' **Voice chat replies play** (per device) can bring back media
elements ("As media"). As media, a silent loop holds the audio focus
between replies (other apps' music pauses) and goes quiet while a
sentence plays, so the two never take the focus from each other; a pause
from elsewhere (Android taking the audio focus, a car switching profiles)
plays on, then retries from the sentence's start, then skips the sentence
after four tries in all, and a pause from a car's or headset's controls is
honoured until play. The trace then says which output plays and what
paused it.

### Music under a call

`"call_background"` in `voice.json` is a gst-launch description of a source
that can play under a voice call: the voice helper mixes it with the
replies (`voice/helper/src/call.rs`) and the page hears one stream, the
call's, so the phone's echo cancellation covers the music too. Nothing in it is special
to one service. Off when empty or absent. A call starts with the music
off, its source not made (nothing is tapped): it plays once you ask the
companion to put it on, unless `call_music_at_start` is `true`.

| Key                          | Default      | Meaning                                                             |
| ---------------------------- | ------------ | ------------------------------------------------------------------- |
| `call_background`            | `""`         | The source, such as `osxprocesstapsrc bundle-id=com.spotify.client` |
| `call_background_volume`     | `0.6`        | The music's level when nobody talks (0 to 1)                        |
| `call_background_ducked`     | `0.15`       | The factor applied while someone talks (0 to 1)                     |
| `call_background_release_ms` | `3000`       | Quiet time before the music comes back up                           |
| `call_music_at_start`        | `false`      | Whether a call starts with the music on                             |
| `call_music_device`          | unset        | The Spotify Connect device music asked for on a call plays on       |
| `call_music_full_volume`     | `true`       | Whether music put on `call_music_device` also gets volume 100       |
| `youtube`                    | `true`       | Whether the companion may play YouTube videos as the call's music   |
| `yt_dlp`                     | `["yt-dlp"]` | yt-dlp's command, a program first                                   |

The music ducks while the companion's speech is being made or plays, and
while you talk (from the start of your speech to its final words): down in
250 ms, back up over 1.5 s once the release passed. While it plays (on,
and not silent), the listener holds as it does during a reply: only a
louder voice, held longer, starts what you say, so the music's singing is
not taken for your words. With `drop_other_voices` and without
`speaker_reference`, while the speaker
model learns a new speaker's voice from what it hears (at a voice chat's
start, or after the voice helper restarted), the music waits, silent: it
fades in once your first two seconds of speech are heard, so a singer's
voice is not learnt as yours. The log says `the call's music waits for a
voice`, then `a voice was taken: the call's music plays`. The companion is
told whether the music is on, waiting for your voice, or off, never that it
plays when it does not. Only the replies are
read faster (`speech_rate`): the music always plays at its own speed and
pitch. The mix is Opus at 128 kb/s, stereo, 48 kHz, sent by WebRTC; a
page or helper that cannot make the call plays each sentence by itself,
without the music. The
companion puts the music on, turns it down, up or off when asked ("mets de
la musique", "baisse la musique"); off, the source is stopped until it is
turned back on. A voice helper restarted during a call makes the call
again as it was, the music on or off, with a new signalling server: the
page's WebRTC sessions start again on it, a page that was reconnecting
learning it when it resumes the call. A call the restarted helper cannot
make again ends, and the page is told; one whose start the helper never
answered is not made again. The helper is restarted when its speech
stalls (a sentence waits 15 s at most, 45 s for the first with a voice or
into a call, which may load its model): if it still answers a ping within
2 s, its speaker is stuck, and the sentences that waited are said with
Kokoro, which reads for five minutes; if it does not, its output is what
was lost, and they are said again as they were. A sentence its speaker
fails to make (Qwen3-TTS out of GPU memory), or that comes out of it
silent in a call, is said again at once by Kokoro, in the sentence's
language with Kokoro's voice for it (`ff_siwis` for French) unless the
Kokoro entry names one; Kokoro reads the next sentences for 30 s, then
the speaker is tried again.

On macOS, `osxprocesstapsrc` (in the helper) plays what one application
plays, through a Core Audio process tap (macOS 14.2 or later):
`bundle-id=com.spotify.client` for the Spotify app and its helpers, or
`pid=` for one process. The tap exists only while a call's music is on,
is private to the helper (gone with it, even on a crash), and changes
nothing of the Mac's audio: no device or default output changes, and the
application keeps playing on the Mac as before, unless `mute=true` mutes
it there while tapped. Without `mute=true`, the music plays twice near
the Mac: from its speakers, and in the call; a call made from the Mac, or
a phone at the desk, hears the first one with no way to cancel it, so use
`osxprocesstapsrc bundle-id=com.spotify.client mute=true` there. An
application that is not running or not playing
gives silence; nothing is launched. With the Spotify app, start it on the
Mac and pick the Mac as the device from the phone or the car (Spotify
Connect); tracks are chosen there.

macOS asks for **System Audio Recording Only** (Privacy & Security >
Screen & System Audio Recording) for the process responsible for the
helper: the program the launchd service starts (`bun`, by its Homebrew
path, `/opt/homebrew/Cellar/bun/<version>/bin/bun`). Without it, the tap
gives only silence; after a Homebrew upgrade of Bun, allow the new path
again. On Linux, `pulsesrc` (in the helper, through the host's libpulse, which
PipeWire's `pipewire-pulse` serves) records a sound server's device. To
play the Spotify app under calls without hearing it in the room, give it a
null sink of its own and record that sink's monitor:

- a PipeWire null sink, for example `roamgate-music`, in
  `~/.config/pipewire/pipewire.conf.d/` (`factory.name = support.null-audio-sink`,
  `media.class = Audio/Sink`);
- a WirePlumber rule in `~/.config/wireplumber/wireplumber.conf.d/` moving
  the stream whose `node.name` is `spotify` to that sink
  (`target.object = roamgate-music`);
- `"call_background": "pulsesrc device=roamgate-music.monitor ! audioconvert"`,
  and `"call_music_device"` set to the name this machine's Spotify app
  shows in Spotify Connect.

With `call_music_device`, the companion's tools, asked for music during a
call with music, play it on that device (unless the request names another),
so a call whose helper runs on the desktop takes the desktop's Spotify app,
not the connector's default device. Starting, resuming or moving music
there also sets that device's volume to 100, since the call sets the
music's level and Spotify can fall back to 0 after a pause;
`"call_music_full_volume": false` leaves the device's volume alone.

#### Your music taste

With the Spotify connector's read tools allowed in `companion_mcp`
(`top`, `recently_played`, `saved` and `my_playlists`, for example
`"mcp__claude_ai_Spotify*__top"` and `"mcp__claude_ai_Spotify*__recently_played"`
beside the others), Roamgate keeps a small profile of what the user listens
to in `taste.json`, in its data directory (next to `companion-memories`):
genres weighted from the top artists, the top artists of the last weeks,
months and all time, a few top tracks, the user's own playlists (those of
the owner of most of them) and followed ones, the latest liked songs, the
playlists and albums played lately, the last days' plays and the hours
most played at. Only names and URIs, a few hundred tokens. A background
job, the companion's tool job (`server/src/voice/voice-taste.ts`) allowed
only those four tools, makes the calls, and Roamgate folds what they
return. It is refreshed when older than a day, as a call starts or the
companion goes idle, never while a tool job runs; a stale one is still
used. When Spotify refuses some calls (a 403 asking to log in again, until
the connector is authorized for the new scopes), what came is kept, the
companion's state says Spotify needs a new login when nothing came, and it
is tried again after six hours; without any profile, music requests work as
without one.

A tool job asked about music is given the profile as quoted data, never
instructions: an open request picks from it, preferring the user's
playlists and liked songs, never one of the last eight picks, and says what
it picked and why; a request that names what to play ignores it. What a
pick played (its URI or search words) is kept with it; "pas ça" or "autre
chose" within five minutes of it puts it on the avoid list for 30 days.
Lasting dislikes are companion memories whose file name starts with
`music-avoid-` (the memory's writer keeps them so), their descriptions
read into the same list. The front's state has one `Taste:` line, so it
can say what the user listens to lately.

#### YouTube

With `call_background` set, the companion can also play a YouTube video's
sound as the call's music, when asked for YouTube ("mets Around the World
sur YouTube"), given a YouTube link, or asked for music Spotify does not
have; it plays, pauses, resumes, stops, sets its own volume, moves in the
video and tells what plays. The companion's tool jobs get these tools from
Roamgate itself (the `roamgate_youtube` MCP server, always allowed, with no
`companion_mcp` entry). yt-dlp, where Roamgate runs, finds the video (the
first search result, or the link; links to other sites are refused) and
its audio-only stream in WebM with Opus. The voice helper plays it into
the call's mix, as its music: `reqwesthttpsrc` (with yt-dlp's HTTP
headers), `matroskademux` and `opusdec`, linked into the helper, at the
music's level and ducked as `call_background` is. The video plays only
while a call does, and ends with it; starting or resuming one puts the
call's music on, if it was off. The helper has no AAC decoder: a video
without Opus audio (only M4A) is told as one it cannot play, which is rare
on YouTube. `"youtube": false` takes YouTube from the companion. A helper
built before YouTube played in it answers that YouTube needs the new
helper.

The keys of the separate Python player YouTube had before
(`youtube_sink`, `youtube_player_wrapper`) are ignored; remove them from
voice.json once the new helper is installed.

Spotify and YouTube never play together, and the helper keeps it so where
it runs: starting or resuming a video pauses the Spotify app (its MPRIS
player, `org.mpris.MediaPlayer2.spotify`, on the session bus) only when
`call_background` carries sound, that is when the app plays into the sink
it records; once that sound was silent, its coming back (the app started
playing here) stops the video. A tool job starting, resuming or moving
Spotify's music on `call_music_device` stops it too. Only sound here
counts: with Spotify Connect the app also says it plays when the account
plays on another device (someone else's phone), and pausing it then would
pause that device; silence in `call_background` leaves it, and the video
goes on. While the call's music is off, `call_background` is not
recorded: Spotify starting then stops the video once the music is back on.

YouTube changes often break yt-dlp: a video that cannot be played is told
with yt-dlp's reason ("the video could not be played: ..."), and one that
looks like such a change (HTTP 403, "Sign in to confirm", a signature or
PO token error) also says to update it. Keep yt-dlp current rather than a
distribution's package, which lags: the release's standalone `yt-dlp` in
`~/.local/bin` updates itself with `yt-dlp -U` (run it from a
timer to stay current), or `pip install --user -U yt-dlp`. `yt_dlp` names another
command (`["/path/to/yt-dlp"]`, or a wrapper first).

`pulsesrc` is live and clocked; raw
audio from a FIFO (`filesrc ! rawaudioparse`) is neither, and arrives late
in the running mix.

Descriptions use gst-launch syntax with full paths (no `~`); set
caps with `capsfilter caps=...`, and end a source with dynamic pads (a
`decodebin`) with `! audioconvert`. `call_background` is read from
`voice.json` only: it builds a pipeline in the helper, so no page edits it.

## Activity log

The [activity log](./activity.md) is off by default. Turn it on in
`settings.json` and restart Roamgate; it is read at startup:

```json
"activity": {
  "enabled": true,
  "retention_days": 90,
  "idle_seconds": 300,
  "day_start": "00:00",
  "subject_roots": [],
  "record_agent_titles": false,
  "exclude": { "connections": [], "subjects": [] }
}
```

| Key                   | Default   | Meaning                                                                                    |
| --------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `enabled`             | `false`   | Record activity into `activity.sqlite`.                                                    |
| `retention_days`      | `90`      | Days kept (1 to 3650); older entries are deleted daily.                                    |
| `idle_seconds`        | `300`     | No input for this long ends attention (30 to 86400). Reading counts until then.            |
| `day_start`           | `"00:00"` | Local time a day starts at, `HH:MM`, for readers that group by day.                        |
| `subject_roots`       | `[]`      | Directories whose subdirectories are [subjects](./activity.md#subjects) (`~/` any home).   |
| `record_agent_titles` | `false`   | Also record agent session titles (never output).                                           |
| `exclude`             | empty     | Connections and subjects kept from what is handed to other tools. They are still recorded. |

Only fields set to a valid value are used; the others take their default.
With `enabled` false nothing is recorded and no file is created. Delete
`activity.sqlite` (with its `-wal` and `-shm` files, Roamgate stopped) to erase
the log.

To report the logged time somewhere, configure a
[time-report provider](./time-report.md) (`time_report.command`).

## Worktree location

By default Herdr chooses where a new worktree is created. Set a repository's
worktree location in the worktree dialog (**Worktree location**) to make every
new worktree land in `<directory>/<branch>` instead, with `/` and other unsafe
characters in the branch name replaced by `-`. The directory must be absolute.
It is stored per repository as `worktree_directory` in `settings.json`; clear it
to return to Herdr's default.

## Worktree command

To create worktrees with your own tool instead of Herdr, set a command in
**Configuration > Instance** (the default) or in a repository's worktree
dialog (**Worktree command**, which wins). For example:

```sh
git recworktree add {path} --branch {branch} --base {base}
```

Roamgate runs the command with `sh` (over SSH, `sh -c` whatever the login
shell), from the source repository on the workspace's host, for up to five
minutes. `{path}` (the new checkout), `{branch}`, `{base}` (the commit fetched
from `origin`) and `{repo}` (the source repository) stand for the variables
`ROAMGATE_WORKTREE_PATH`, `ROAMGATE_WORKTREE_BRANCH`, `ROAMGATE_WORKTREE_BASE`
and `ROAMGATE_WORKTREE_REPO`, which Roamgate exports first: each placeholder
becomes `"$ROAMGATE_WORKTREE_..."`, so a value is never read as shell syntax.
Do not quote or escape placeholders yourself; commands with quoted or escaped
placeholders are refused. Branch names must be valid for git and free of spaces and shell
syntax characters (`$`, backquote, quotes, `\`, `;`, `|`, `&`, `<`, `>`,
parentheses, braces, `!`).

When a worktree location is set, the path is that directory plus the branch
name with every run of characters other than letters, digits, `.`, `_` and
`-` replaced by `-` (`feature/x` becomes `<location>/feature-x`). Otherwise it
is Roamgate's reproduction of Herdr's default,
`~/.herdr/worktrees/<repo>/<branch slug>`, with the branch lowercased and runs
of other characters replaced by `-`; set a location if Herdr's
`[worktrees] directory` is customized. Roamgate then opens the checkout in
Herdr and runs the setup hook. A checkout Herdr already had open fails
creation instead of running the setup hook again.

Before running the command, Roamgate checks that its first program is
installed on that host (`command -v`; for `git <subcommand>`, also that git
knows the subcommand as a builtin, an installed `git-<subcommand>` or an
alias). If it is not, or the host has no `sh`, Herdr creates the worktree as
without a command and the result says so. Once the command runs, any non-zero
exit, 127 included, fails creation with the command's output. It is stored as
`worktree_command` at the top of `settings.json` and per repository; leave it
empty to let Herdr create worktrees. A repository cannot opt out of a global
default: leave the default empty and set the command per repository instead.

A **remove command** works the same way for removal, set beside it:

```sh
git recworktree remove {path} {force}
```

`{path}` (the checkout) and `{repo}` (the source repository) stand for the
same exported variables, and `{force}` is `--force` when you force the
removal, otherwise nothing. Forcing a removal discards the checkout's
uncommitted and untracked changes, and with `git recworktree` those of its
nested checkouts too: put `{force}` only where your tool means that. The
command runs from the source repository on the workspace's host, after the
teardown hook; when it succeeds Herdr closes the workspace, as its own removal
would, and the removed hook runs. Not installed on that host, Herdr removes
the worktree and the result says so. A failure that leaves a stale checkout
behind ("is not a working tree") gets the same recovery as Herdr's removal;
any other failure stops the removal with the command's output. It is stored
as `worktree_remove_command`, at the top of `settings.json` and per
repository.

## Worktree hooks

Configure hooks in `roamgate.json` at the repository root:

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

| Hook       | When / working directory                          |
| ---------- | ------------------------------------------------- |
| `setup`    | After create/open; new worktree                   |
| `opened`   | After opening an existing worktree; that worktree |
| `teardown` | Before removal; target worktree                   |
| `removed`  | After removal; source checkout                    |

Roamgate uses the first file found, in order: target `roamgate.json`, source
`roamgate.json`, target `paseo.json`, source `paseo.json` (legacy). Files are
never merged. `{}` disables fallback; invalid files report an error. Hooks run
with `sh -c` on the connected (local or SSH) host. To migrate, rename
`paseo.json` to `roamgate.json`.

| Variable                             | Value                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `ROAMGATE_HOOK_EVENT`                | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `ROAMGATE_HOOK_CHECKOUT_PATH`        | Target worktree path                                                                   |
| `ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH` | Source checkout, when known                                                            |

`HERDR_GUI_HOOK_*` and `PASEO_HOOK` / `PASEO_CHECKOUT_PATH` /
`PASEO_SOURCE_CHECKOUT_PATH` are also set.

**Hooks are on by default and run unsandboxed repository code with your
permissions.** Review them, or disable them per repository under **Worktree
hooks** or **Worktree Lifecycle**. A failed teardown stops removal; other
failures do not undo completed steps.

## Run as a user service

| Command                            | Behavior                                  |
| ---------------------------------- | ----------------------------------------- |
| `roamgate service install`         | Create or update the service and start it |
| `roamgate service install --force` | Replace a non-Roamgate definition         |
| `roamgate service status`          | Show status                               |
| `roamgate service restart`         | Restart after config changes              |
| `roamgate service reload`          | Reload the definition, then restart       |
| `roamgate service uninstall`       | Stop and remove; keeps config and tokens  |
| `roamgate service logs [-f]`       | Show recent output                        |

| Platform | Definition                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- |
| Linux    | `~/.config/systemd/user/roamgate.service` (`Restart=always`)                                       |
| macOS    | `~/Library/LaunchAgents/dev.roamgate.plist` (`KeepAlive`); logs in `~/Library/Logs/roamgate.*.log` |
| Windows  | Scheduled task `dev.roamgate-<key>` running `%APPDATA%\roamgate\roamgate-task.ps1` at login        |

**New services listen on `0.0.0.0:8787`** with a generated token and print
localhost/LAN login URLs. Settings live in `~/.config/roamgate/roamgate.env`
(`%APPDATA%\roamgate\roamgate.env`); edit it and restart, or run
`roamgate config set NAME=value --restart`. For local-only access, set
`HOST=127.0.0.1`. On Linux, `sudo loginctl enable-linger "$USER"` keeps the
service running after logout. Remove legacy services first
([migration](#transition-from-herdr-studio--herdr-gui)).

On macOS the env file is parsed, not executed: use `NAME=value` lines (optionally
prefixed with `export`) with quotes, comments, and `$NAME`/`${NAME}` references
to `HOME` or variables defined earlier in the file. Command substitution and
other outside variables are rejected.

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

**Credentials and sessions.** The generated token is in
`~/.config/roamgate/auth-token` (`%APPDATA%\roamgate\auth-token`). Opening a
page with `?token=` logs in and sets a cookie. Only page openings do: a
WebSocket or an `/api/` request carrying a `token` parameter is left to its
route and never counts as a failed login. Cookies are signed by a separate
secret in the same directory (`session-secret.json`, or
`session-secret-<sha256>.json` when `ROAMGATE_SETTINGS_PATH` is set). Protect
both like passwords.
- `roamgate auth rotate` replaces the token, signs out every browser, and
  restarts the service. **Do not just delete `auth-token`**: after a migration,
  the legacy token is copied back on the next start. To rotate by hand, stop
  the service and write a fresh 64-character lowercase hex secret (mode `0600`).
- `roamgate auth revoke-sessions` signs out every browser without changing
  credentials.
- Changing the password or PIN also signs out every browser on the next start.
  Stop all listeners of the instance before changing credentials.
- If startup was killed and a stale `session-secret*.json.lock` directory
  remains, stop all listeners and delete only that lock directory.

Manual templates live in `deploy/`. When wrapping the binary, keep systemd as
the restart owner:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/service-wrapper -- %h/.local/bin/roamgate --host 0.0.0.0
```

The updater installs a verified binary, keeps `roamgate.previous`, and exits so
the supervisor restarts it.

## Command-line management

These commands act on the [user service](#run-as-a-user-service)'s config and
data, not on the current shell's flags. They exit 0 on success, 1 on failure,
and 2 on bad arguments; many accept `--json`.

| Command                                                           | Purpose                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `roamgate doctor [--offline]`                                     | Check config, credentials, TLS, service, network exposure, Herdr, connections, Web Push, and updates, with a fix for each problem. Prints no secrets.                                                                                                                                            |
| `roamgate url [--qr] [--address <host>]`                          | Print login URLs; `--qr` shows a QR code for a phone (it contains the token); `--address` substitutes a VPN or Tailscale name.                                                                                                                                                                   |
| `roamgate config show\|get\|set\|unset\|edit\|path`               | Read or change `roamgate.env` atomically. `--restart` restarts the service; `KEY=-` reads a secret from stdin.                                                                                                                                                                                   |
| `roamgate auth show\|rotate\|revoke-sessions`                     | Show the login method, replace the token, or sign out every browser.                                                                                                                                                                                                                             |
| `roamgate connections list\|test\|add\|remove\|set-default`       | Manage [connection profiles](#multiple-and-remote-herdr-connections). Edits are refused while the managed service runs unless `--restart` is given. Only the service config's address is checked, so stop other processes sharing the registry (such as a foreground run on another port) first. |
| `roamgate push test`                                              | Send a test [Web Push](#web-push-notifications) notification.                                                                                                                                                                                                                                    |
| `roamgate activity today\|day\|range\|events\|workspaces\|status` | Read the [activity log](./activity.md#command-line) read-only, without the server.                                                                                                                                                                                                               |
| `roamgate update [--check]` / `roamgate rollback`                 | Update to the latest release or restore `roamgate.previous` (Linux/macOS).                                                                                                                                                                                                                       |
| `roamgate service logs [-f] [-n <count>]`                         | Show service output (not available for Windows tasks).                                                                                                                                                                                                                                           |
| `roamgate completion bash\|zsh\|fish`                             | Print a shell completion script.                                                                                                                                                                                                                                                                 |

## Build a standalone executable

```bash
bun scripts/studio-plugin.ts build-source
# Output: server/roamgate (server/roamgate.exe on Windows)
```

Afterwards `bun run build` rebuilds. Cross-compile with `bun run build:<target>`
or package with `bun run package:<target>`; `bun run build:all` builds every
target:

| Targets                        | Architectures                                     |
| ------------------------------ | ------------------------------------------------- |
| `linux-x64`, `linux-arm64`     | Linux x86-64 / ARM64 (glibc; musl is unsupported) |
| `darwin-x64`, `darwin-arm64`   | macOS Intel / Apple Silicon                       |
| `windows-x64`, `windows-arm64` | Windows x86-64 / ARM64                            |

`bun run clean` removes builds. Releases follow
[AGENTS.md](../AGENTS.md#release-notes).

Release binaries have no source maps. Each release run keeps a
`debug-roamgate-<tag>-<target>` CI artifact for 30 days with source maps; extract
its tar and run it to get readable stack traces. To build one locally, run
`bun run build:web` and `bun run --cwd server compile --sourcemap`.

## Troubleshooting

| Symptom                                | Action                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Not sure what is wrong                 | Run `roamgate doctor`.                                                                         |
| Cannot connect to Herdr                | Check that Herdr runs and both sockets exist; try `roamgate herdr setup`.                      |
| Another device cannot open the page    | Check the bind address, token URL, firewall, and [private access setup][private-access].       |
| SSH profile connects locally           | Remove socket flags and `HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`; they override tunnels. |
| Want the browser to open automatically | Use `roamgate --open` or `OPEN_BROWSER=1`.                                                     |

For step-by-step diagnosis, see [the tutorial](./TUTORIAL.md#troubleshooting).

[private-access]: ./TUTORIAL.md#networking
