# Architecture

Roamgate's system contracts. See [Features](../FEATURES.md) for UI behavior,
[Deployment](./DEPLOYMENT.md) for configuration, and [Security](../SECURITY.md)
for the trust model.

## System overview

```text
Browser (React + Vite)
   | same-origin HTTP / WebSocket
   v
Bridge (Bun + TypeScript) -- node:net --> Herdr sockets
```

Browsers cannot open Unix sockets or named pipes, so the bridge connects to
`herdr.sock` (NDJSON control) and `herdr-client.sock` (binary terminal traffic).
It also serves the frontend and owns authentication, local/SSH runtimes, host
operations, notifications, health, and updates. React owns presentation and
browser-local preferences; xterm displays output that Herdr renders.

Browser RPC sends `{ id, method, params }` and receives `{ id, result }` or
`{ id, error }`. Events arrive as `{ event: ... }`. Subscribing triggers a fresh
snapshot, and events during a refresh queue another refresh: this reconciles
missed changes but is not a replayable event log.

## Connection isolation

`ConnectionManager` owns the shared profiles and one `ConnectionRuntime` per
profile. Each runtime owns its transport, viewers, subscriptions, caches, and
reconnect lifecycle. Disconnecting stops the runtime and SSH tunnel, never Herdr.

- Every downstream request carries a connection ID and runtime generation and
  holds a lease on a ready runtime. Replies, events, and frames carry the same
  identity; mismatched or stale identities fail without fallback.
- When a runtime is replaced, old leases are retired first. Effects already
  sent may finish, but their results are discarded.
- Authentication, health, updates, and profile management are bridge-global and
  work regardless of runtime state. One failed runtime never blocks others.
- Browser caches, storage, and pending actions are scoped per connection.

## Instance naming

`/api/instance-settings` reads and writes `title_suffix` in the GUI settings
file. Writes need JSON plus the `x-roamgate-settings` header and reject
cross-site requests. The server derives the HTML title and the manifest `name`
and `short_name` from it; the manifest `id`, `start_url`, and `scope` never
change. HTML and manifest responses are not cached.

## Terminal endpoints

### Negotiation and transport

The backend is chosen from a verified protocol allowlist (see
[compatibility](./DEPLOYMENT.md#herdr-compatibility)). Herdr 0.9.x endpoints
require generation 1 and the exact codecs `shell.snapshot.v1`,
`shell.surface.v1`, `shell.input.semantic.v1`, and `shell.blob.v1`; anything
unknown fails closed. Each viewer crops its pane from the shared tab surface.

An endpoint stream whose last viewer detaches stays warm, even with no browser
connected, and replays its latest frame to a returning viewer. Each runtime keeps
the 20 most recently viewed; older ones close. Legacy direct attaches close
immediately because they hold Herdr's resize lock.

Capabilities are negotiated per terminal socket (again when a stream
reconnects) and rechecked at dispatch:

| Capability | Contract |
| --- | --- |
| `pane.focus` | Required to attach; no legacy fallback without it. |
| `pane.scroll` | Gates explicit history scrolling. |
| `tab.create`, `workspace.create` | Gate creation from the existing endpoint. |
| `health_check` | Enables ping/pong. |

`surface_delta` and `surface_reuse` are requested by default and stored per
connection (`settings.terminal_transport`). Changing them makes viewers reattach
with a fresh full frame. Invalid updates close the stream rather than show stale
output. These codecs reduce Herdr-to-bridge traffic; terminal messages of 1 KiB
or more are also WebSocket-compressed to the browser. Kitty graphics are not
shown.

### Geometry, input, and selection

`terminal.attach` sends the pane's `cols`/`rows` and optionally the tab's
`surface_cols`/`surface_rows`. Terminals cancel the UI's CSS zoom and scale the
xterm font instead, so mouse and IME coordinates stay correct.

- Input waits for readiness, revalidates its lease, and is never replayed into a
  replacement terminal.
- Endpoint keyboard input uses basic CSI-u for ambiguous modified keys
  (modified Enter, Backspace, Escape, Ctrl+/ vs Ctrl+_); Herdr re-encodes for
  the application. Legacy attachments send raw bytes.
- PageUp/PageDown are sent as semantic input; half-page history uses
  `pane.scroll`.
- Mouse cells are zero-based and pane-local; only a press inside the pane owns
  a drag.
- Selection freezes the displayed frame until cleared. Edge-drag reads history
  one viewport at a time and stops on release, blur, resize, or content change.

### Links

The browser detects URLs and file paths in soft-wrapped text, including
Windows paths. Inferred paths must resolve inside the pane's workspace.

Endpoint repaints carry a `link_frame` identity that changes with content,
scroll, or geometry. `terminal.link.resolve` checks ownership and frame
identity, then uses the frame's OSC 8 table or, on Herdr 0.9.1+,
`pane.link.resolve` to rebuild wrapped URLs. Coordinates are zero-based cropped
pane cells. Ambiguous viewport-clipped URLs are rejected, `pane.link.activate`
is never called, and only HTTP(S) and safe local `file://` targets open. Hover
never activates a link; touch requires an explicit **Open link** or **File
actions**.

## Browser navigation and creation

`browserNavigation.ts` keeps endpoint workspace/tab selection local to each
browser; snapshots provide topology but never override newer selections. Pane
focus within a tab stays shared and is sent through `pane.focus`.

Creation passes `focus: false` and adopts the returned IDs only if the
initiating selection is still current. Omitting cwd preserves Herdr's
`terminal.new_cwd`. `workspace.path` expands `~` on the connection's host,
validates the directory, and returns up to 50 suggestions; creation rechecks the
path before dispatch.

Only the first workspace in an empty session uses control-socket creation. A
20-second admission deadline covers readiness and validation: expired requests
never run, and dispatched timeouts are reported as uncertain.

## Workspace resource ownership

A **checkout** owns Files, Changes, and Commits. A workspace supplies routing, a
tab a return location, and a pane optional context. Changes and Last step
snapshots do not prove which agent made a change.

Git resource keys combine `worktree.gui_settings_key` with the normalized
checkout path, per connection. Workspaces on the same checkout may share caches.
Actions remember their originating checkout and never fall back to a sibling.
Terminals stay mounted while the Inspector changes.

Browser preferences live in namespaced `localStorage` and sync across tabs on the
same origin. Navigation, open files, drafts, and focus stay per tab.

### Worktree Git status

`workspace.list` attaches each checkout's last known `worktree.git_status`
without waiting on Git; the first list of a runtime has none. Entries older
than 20 seconds, or invalidated by Roamgate Git actions, auto-sync and finished
agent turns, refresh in the background: one refresh per runtime at a time, with
one batched SSH command on remote hosts and `GIT_OPTIONAL_LOCKS=0` so polling
never takes the user's `index.lock`. A failed SSH keeps the previous status.
Changed checkouts arrive as a `workspace.git_status` event whose `data.statuses`
holds `{ checkout_path, git_status }` entries; the browser patches matching
workspaces in place and reapplies pushes that overlap an in-flight refresh.

### Last step capture limits and ownership

Last step snapshots the checkout when the workspace goes from active to idle.
Captures include small untracked files and commits made during the turn, use raw
on-disk bytes (no Git filters), and never touch the user's index.

`workspace.last_step_completed` notifies browsers after snapshot finalization
settles, even when capture is unavailable, refused, or fails. It signals a
completed workspace activity period, not a new Git snapshot, so Files can
refresh independently of Last step availability.

A capture is refused entirely when a file exceeds 8 MiB, content exceeds 32 MiB
in total, or there are more than 10,000 files. It is also refused for symlinks,
special or unreadable files, newline/tab filenames, applicable `filter`
attributes, shared repositories (`core.sharedRepository` other than unset,
`false`, `0`, or `umask`), files on a different filesystem from the Git
directory, or after a 10-second timeout. A refusal is logged and the previous
Last step stays available. Snapshots are not atomic against concurrent edits.

Work happens in an owner-only `roamgate-last-step-capture` directory inside the
checkout's Git directory. Only complete loose objects are hard-linked into Git's
object database; Roamgate never runs `git add`, GC, or deletes user objects.

**Recovery:** a crash can leave that directory behind, and later captures then
refuse to run. Stop captures for the checkout and make sure the capture shell
and its children have exited (reboot if unsure). Then remove only
`$(git rev-parse --absolute-git-dir)/roamgate-last-step-capture`. Never remove
anything from `objects`, `objects/pack`, or the index. Over SSH, a remote capture
may still finish after the local caller fails.

## Filesystem browsing

`file.list` is checkout-relative with realpath/symlink escape checks.
`scope: "filesystem"` with an absolute path enables read-only host browsing; it
is a view mode, not a stored permission. Upload, delete, `file.mkdir`, and
`file.move` are checkout-only and reject absolute paths. Moves use the host's
atomic no-replace rename (`renamex_np`, `renameat2`, or `MoveFileExW`), never
copy, and need Python 3 over SSH.

`file.reveal` runs a fixed per-platform command (`explorer.exe`, `open`,
`xdg-open`), never a shell. It needs `ROAMGATE_ALLOW_FILE_REVEAL=1`, a local
profile, and a loopback peer; loopback does not prove the browser is on the same
machine. See [host file reveal](DEPLOYMENT.md#host-file-reveal).

Previews are inert. SVG is never inserted into the app DOM and carries a
sandbox CSP. HTML previews render in an empty-sandbox iframe with an enforcing
CSP: workspace CSS, images, and fonts are inlined as data URLs; HTTPS
stylesheets load directly from the browser (exposing the viewer's IP); scripts,
forms, frames, and external images/fonts are blocked. Limits: 512 KiB per HTML
or stylesheet, 5 MiB per image/font, 64 resources and 10 MiB per preview
(HTTP 413 beyond that).

## Agent activity

`agent.list` adds `last_activity_at` from the session file's mtime, with a
1.5-second budget; missing data never hides an agent.
[History synchronization](./HISTORY.md) covers transcript projection and caching.

## Agent integrations

`integration.list` uses Herdr's RPC as the source of truth. Missing versions are
filled from read-only `herdr integration status` on the same host (over SSH for
remote connections), only when the CLI version matches the running server. CLI
failures leave versions unknown without failing the list.

## Ranger

The bridge runs one Pi Durable assistant service, independent of the selected
connection and shared by all authenticated browsers through bridge-global
`bridge.assistant.*` RPC and revisioned snapshot pushes. Reconnecting fetches
state; sends are never replayed.

- **Drivers:** `ranger-driver.ts` sends the Claude Code provider's turns to
  `claude-driver.ts` and every other provider's to Pi. A Claude Code turn is
  one `claude -p` run resumed from the session the last turn saved, with
  built-in tools, other MCP servers, skills and hooks off. Ranger's tools
  reach it over MCP (`claude-mcp.ts`): plain HTTP on 127.0.0.1, with a bearer
  token valid only while the turn runs. A chat that changes driver starts
  afresh, and input sent during a Claude Code turn waits as a follow-up.
- **Tools** are defined in `server/src/assistant/tools.ts` and run through
  `callWorkspaceTool` against the turn's approved scope. Pi's built-in tools,
  extensions, skills, and project instructions are disabled, and workspace
  evidence is treated as untrusted.
- **Scope:** no workspaces are allowed by default. Each turn captures concrete
  connection/workspace pairs (at most 512) and rechecks runtime leases around
  every read. Only the dedicated confirmation can enable high-permission mode
  (`approval_mode: "auto"` with `workspace_scope: "all"`).
- **Actions:** a proposal pins its runtime lease and target, and
  `action.confirm` accepts only the proposal ID. A receipt is saved before
  dispatch, one action runs at a time, and failed or uncertain actions are never
  retried. Pane/agent closes are refused in multi-pane worktree-root workspaces
  because Herdr cannot prevent an implicit group close.
- **Busy turns:** a `send` with `when_busy` is accepted while a turn runs
  (at most 8 waiting messages). `steer` goes to Pi's inbox and joins the turn
  after its current tool round, within the turn's admitted scope; its output
  starts a new reply after the steer. `queue` waits in the snapshot `queue`
  until the turn answers, then is admitted like a new question. A follow-up
  also waits while an action or task preview awaits review. Steers that miss
  the turn, or need a workspace it did not admit, become follow-ups, and later
  steers of that turn follow them. Stop, a failed turn, or a chat switch holds
  the queue (`queue_held`) until `queue.resume` or the next send;
  `queue.remove` drops a follow-up. One worker runs steering, removal and
  sending in queue order, and a single check after every published change or
  request decides when the next follow-up goes.
- **Persistence:** conversations and execution checkpoints live in the assistant
  directory; one bridge process must own it. After a restart, a turn resumes
  only after its endpoints, Herdr boot IDs, and workspaces are re-verified.
- **Tasks** live in `tasks.sqlite`; each state change commits before it is
  published. One scheduled run executes at a time, overdue occurrences are
  combined, and runs re-verify identities and permissions. Run results emit an
  `assistant_notification` push; custom notices are deduplicated by event key.

## Reviews

Review sessions and their threads live in `reviews.sqlite` in the data
directory (`ROAMGATE_REVIEW_DIR` overrides), written through on every change
and pushed to every browser as `review` messages; browsers call
connection-scoped `review.*` methods and always write as the user. A diff is
one shell script on the checkout host. A local review (a range or the
working tree) never shows merge request content; GitLab is the separate
review of the merge request (target `mr`, opened from the local review by
`review.gitlab.open`). There the user's review comments and overall comment
are GitLab draft notes read and written through `glab api` on the checkout
host, and nothing of them is kept locally. Review comments written in a
local review of the same checkout on the merge request's branch, and
agents' draft replies, are shown there as pending and sent by
`review.gitlab.push`. A local review comment records the merge request found
for its branch when it is written (`pendingFor`), so a later checkout of
another branch does not move it; one written before any merge request was
found follows its review's branch, checked again before sending. Local from
the merge request's review returns to a local review of that branch
(`review.gitlab.find` with `local`), else opens one.

Agents reach the bridge through one unix socket per connection in
`<review dir>/agent/`, served as HTTP with JSON. Local panes find it through
the `~/.cache/roamgate/review.sock` link; on an SSH host, each time the
connection's command master is ready the bridge installs the client and adds
`ssh -O forward -R ~/.cache/roamgate/review.sock:<socket>` on that master, so
agents there use the existing login and no port listens. An agent can edit
only its own comments and cannot post on GitLab. The user's discussion
comments reach a review's agent as a prompt typed into its Herdr pane, a
few seconds after they are written (a burst goes as one prompt); `watch`,
a long poll on the service, is for agents without a pane.

## Conversation mode

A Claude session can be driven by a long-lived headless `claude -p
--resume <id>` (stream-json both ways, partial messages, replayed user
messages, permissions over stdio) instead of the TUI in its pane. The pane's
holder (below) runs that process as its own child, on the pane's host, so an
SSH link that drops, a runtime that is replaced or a Roamgate restart does
not end it; only closing the pane does. The holder appends each line the
child prints to a log on its host
(`~/.cache/roamgate/headless/<holder id>/out.jsonl`, one directory per
holder so two panes on one session never share a log, framed by start and
exit lines with the child's pid and exit status, and noting each line
written to its stdin, or dropped when its stdin was closed already) and
sends it over the review socket (`hold_output`) from the byte
offset the bridge asks for; the bridge takes a chunk only when it starts
where the last one ended, so each line is read once. The bridge's commands
(`start`, `input`, `end`, `kill`) ride the `hold` long poll's answers,
numbered: the holder applies each once, in order, and reports the last one
applied with every poll; unconfirmed ones are sent again. A user message the child never got (the
holder dropped it, or it was still unconfirmed when the child exited) goes
back to the front of the queue for the next child instead of counting as a
turn cut short. Like the terminal's claude, the child is never closed for
being idle: it runs until the session is handed back, the user stops it,
or the pane closes. The child's environment is the
pane's minus outer Claude Code, Herdr and API key variables, plus
`ROAMGATE_HEADLESS=1`, so the account is the claude.ai login, the user's
hooks run, and Roamgate's own permission hooks step aside. It stays in the
pane's foreground process group (the holder turns off the terminal's signal
keys), so Herdr's process listing for the pane includes it; a small guard
process beside it kills it should the holder die without ending it (killed
outright, crashed); Roamgate's own
checks do not count a stream-json claude as a TUI, and the bridge still
lays the session's agent over Herdr's answers (below).

The TUI and the headless process never run on one session together. A lease
per pane (`conversation-leases.json` in the data directory) says who writes:
`terminal` (no entry), `to_conversation`, `conversation`, `to_terminal`.
Taking over needs an idle Claude with an empty prompt box (and vim insert
mode, if any); it sends `/exit`, waits for Claude's pid to end and the shell
to be in the foreground, then types `roamgate-hold <id>` into the pane (on a
local connection with the holder's and the socket's full paths, so the
pane's `$HOME` does not matter). The holder (installed beside
`roamgate-review`) keeps the pane, long-polls the review socket (`hold`),
and, told to resume, ends its child (stdin closed, then waited for) before
it `exec`s `claude --resume` with the flags the TUI ran with (model,
permission mode, directories, MCP configs): one process sequences both
writers. Handing back needs no running turn (a message the CLI
queued as a turn of its own counts as one) and an empty queue; Enter alone
in the holder asks for it (`handback`), other text does not. When the bridge
cannot answer for the pane, the holder resumes only if its own child has
ended and no headless process on the session shows up on the host; while
its child runs, a second Enter within ten seconds ends it (stdin closed,
killed after five seconds) first, since a child waiting on a permission
never goes idle. Any failed check refuses and leaves the
session with its current writer; a TUI that exited when the holder could not
start, or after the exit deadline, gets `claude --resume` typed into the
shell it left.

A headless process starts only while the lease says `conversation`, a holder
that holds the session polls from the pane, no claude runs in the pane, no
earlier headless process runs on the session, and no other writer does:
neither a pane Herdr maps to the session nor an interactive
`claude --resume <id>` on the host. A pane where claude runs again (the
holder resumed it while Roamgate was away) gives the session back to the
terminal. A pane that closes takes its lease and process with it; leases
are also swept when a tab or workspace closes and when the event
subscription comes back. In a held pane Herdr sees the holder and, at most,
its child as a claude it detects itself: always `idle` (its fallback, since
the holder's screen matches no rule), sometimes without the session, which
it also drops for a few seconds while the pane changes hands. Roamgate's own
`pane.report_agent` reports do not override that detection. So the bridge
lays the session's agent (status from the stream, source
`roamgate:headless`) over `pane.list`, `pane.get`, `agent.list` and
`agent.get` for a held pane, and tools that ask Herdr directly rather than
the bridge see Herdr's view, not the conversation's state.

A runtime that goes away (an SSH drop, a Herdr reconnect, a restart) stops
reading its holders' children and leaves them running, keeps the leases,
stores in them the queued messages, how far each holder's log was read and
its unconfirmed commands (the offset is also saved about once a second
while reading, and unconfirmed commands as soon as they are added), and
changes nothing more: a handover still running there
stops, and its holders poll the next runtime. That runtime turns a cut
`to_terminal` back into `conversation`, drops a cut `to_conversation`, and,
once it is up (or when a holder that was slow to come back first polls),
reads each holder's log again from its latest child's start: the lines the
runtime before had read rebuild the turn's state (status, tools, tasks, the
reply so far) without reaching the browsers again; nothing acts on the
session (a hand-back, the queue) before every line that was in the log at
that point is handled; then the permission prompts and questions still open
are asked again, once, and the rest is live. A note of a write this runtime
did not make (a message an earlier one sent, an answer it gave) marks the
turn as running or withdraws the prompt asked again. A read that times out
retries on the holder's next poll; reading a long log only times out when
it stalls. A child that ended while nobody read is read to
its end; only one that died in the middle of a turn (or a holder that no
longer runs one) marks the turn as cut short. Then the carried queue is
sent. With several local connections, a
holder is served only by the connection whose Herdr socket it names.

Browsers call connection-scoped `agent_chat.*` methods (`state`,
`subscribe`, `unsubscribe`, `send`, `voice`, `interrupt`, `queue.edit`,
`queue.remove`, `handover`) and receive `agent_chat.<type>` events for the
panes they subscribed to (`shared/agentChat.ts`). Text deltas are coalesced
to about a frame and keyed by API message id and block index, which history
entries carry as `message_id` and `block_index`. Messages typed during a
turn wait in the bridge's queue; speech interrupts a turn that is only
writing text, steers one that runs a tool, and "stop" interrupts.
Permissions and questions use the review prompts, marked as having no
terminal to fall back on; unanswered, they are denied. A message sent twice
with one id is taken once.

In the browser, the view decides the writer: a Claude pane's chat, shown
and idle, asks for `handover` to conversation mode, and its terminal, shown
with no turn running and an empty queue, asks for it back; each request is
made once until the view, Herdr's state or the stream's status changes (a
refused takeover is also retried every few seconds for a minute, since a
dialog can close without Herdr's state changing), so a refusal stands and
is shown in the chat's header. Keys typed in a browser's terminal are
refused while a handover runs, as pane input is. While conversation mode
holds the session, the browser neither types into nor reads the pane's
terminal. The streamed blocks render after the transcript's entries and
leave once an entry with the same message id and block index (tools: tool
use id; user messages: uuid) arrives.

`agent_history.subscribe` pushes `agent_history.changed` when a pane's
session file changes, for every agent kind; the browser then fetches its
delta with `agent_history.get`, and polls every 30 seconds in case a push
is lost (every 4 seconds from a bridge that cannot push). Local files are
watched; an SSH connection runs one stat loop for all its watched files.

## Task notifications

With the default `herdr` source, each runtime keeps one passive endpoint shell
(`surface_active: false`) that receives Herdr's `SemanticNotification` (tag 14)
after Herdr applies its own policy. Finished maps to completed and
needs-attention to blocked. The bridge relays these to Web Push and browsers
(`roamgate.task_notification`) and advertises `herdr_task_notifications` so pages
skip their own tracking. Servers without endpoint support fall back to the
`status` tracker, which watches agent transitions (initial state is silent).

Web Push stores private VAPID keys and subscriptions, sends to an allowlist of
push providers with a 10-second deadline, 4 concurrent requests, and a
256-message memory queue. Failures are logged, not replayed. See
[delivery limits](./DEPLOYMENT.md#web-push-notifications).

## SSH transport

Unix SSH runtimes run one OpenSSH process forwarding both sockets into a private
temporary directory. Readiness needs a control `ping` and render handshake.
Transient failures retry six times with backoff up to 30 seconds;
authentication, host-key, and protocol failures do not.

Windows-host profiles instead listen on two local Unix sockets; each connection
spawns an OpenSSH stdio process running Herdr's `remote-api-bridge` or
`remote-client-bridge` through PowerShell. A capability probe rejects missing or
old binaries and stopped sessions.

Destinations must be an OpenSSH alias or `user@host`, passed after `--`.
Host-key checks stay on and authentication is non-interactive. Owned paths are
removed only after the child process exits. Roamgate never installs remote
software. See [connection setup](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

Each SSH profile runtime owns two OpenSSH connections. Connection A is the tunnel
above and carries only Herdr's control and render sockets. Connection B is a
command master (`ssh -M -S <runtime dir>/m.ctl -N`) started alongside the tunnel,
kept across tunnel reconnects, and stopped before the runtime directory is
removed. A master that dies after serving commands restarts once after ten
seconds; one that never becomes ready waits for the next tunnel start.
`ROAMGATE_DISABLE_SSH_MASTER=1` turns connection B off; the legacy CLI
connection never has one.

Host commands built by `sshCommandArgv` (Git, files, search, worktrees, hooks,
uploads, the remote HOME probe) add `-S <socket>` while the master of a runtime
reaching that destination listens. `-S` overrides the fixed `ControlPath=none`,
which a later `-o ControlPath=` cannot, and `ControlMaster=no` keeps commands
clients: no user `ssh_config` socket is ever used, and OpenSSH itself falls back
to a cold login when the socket is missing, stale, or refuses a session. The
masters are registered per runtime, so stopping one profile never stops another
profile's master on the same host. The shared process helpers allow eight
concurrent sessions per destination, multiplexed or cold, below sshd's default
`MaxSessions 10`. A multiplexed command that exits 255 after its master died
(`-O check` fails) may still be running remotely, so only read-only commands
built with `sshReadCommandArgv` (Git status, file listing and reads, search,
agent session reads, the port list, the HOME probe) are rerun once cold. Every
other command, including worktree, hook, upload, write, delete, and Git
actions, reports that failure instead of risking a second run. A 255 from a
live master is the remote command's status. Port forwards still use their own
connections.

## Distribution model

Production builds embed the frontend and Bun into one executable. Release
binaries, archives, checksums, and update manifests all use the `roamgate` name;
missing or legacy manifests fail closed. Publishing needs all six platform
asset sets. Old clients need [manual migration](./DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).

## Trust boundary

Roamgate is trusted single-user administration; authentication grants full
authority (see [Security](../SECURITY.md#trust-model)). The browser accepts one
bridge hello before other messages; message kinds are validated and downstream
events cannot inject bridge fields. NDJSON lines are size-bounded, and malformed
terminal frames are dropped.

State-changing HTTP endpoints need authentication plus a marker header; the
push and settings endpoints also reject cross-site requests:

| Endpoint | Required header |
| --- | --- |
| Updates | `x-roamgate-update: 1` (legacy `x-herdr-gui-update: 1` is accepted; the new header wins) |
| Web Push subscriptions | `x-roamgate-push: 1`, JSON body |
| Instance settings | `x-roamgate-settings`, JSON body |

Login bodies are limited to 16 KiB (`413`). Headers never replace login.
