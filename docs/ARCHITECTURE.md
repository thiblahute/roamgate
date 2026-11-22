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

A request may add `lane: "background"` for work nobody is waiting on (PR/MR
badges). The browser sends at most four such calls per connection at once,
shares an identical call already in flight, and sends interactive calls at once
whatever the background queue holds. The bridge runs a background request's SSH
commands in the background lane (see [SSH transport](#ssh-transport)).

Every network call to a forge (`glab`, `gh`) goes through one gate per
checkout host and forge host (`server/src/workspace/forge-calls.ts`): at most
60 calls a minute and four at once, queued in order and given up past the
caller's deadline; a 429, `Retry-After` or `RateLimit-Remaining: 0` pauses the
host until the forge allows; identical calls share one answer in flight and
for a while after; GETs are sent with `If-None-Match`, and a 304 answers with
the remembered body. Each call logs one `forge call` debug line (feature,
kind, host). PR/MR badges ask the forge for one GraphQL query per GitLab
host covering every branch asked about together (and those asked in the last
15 minutes), kept 2 minutes for an open request, 3 without one and 30 for
merged or closed ones; CLI logins and project ids are kept 10 and 30 minutes.
The sidebar asks a badge again only when its age passes 3 minutes (open), 5
(no request), 30 (merged or closed) or 10 (no CLI or login), whichever
connection or workspace is shown, and nothing while the page is hidden.

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

`connections.agent_sessions` provides read-only workspace, tab, pane, and agent
summaries for all sidebar layouts across ready runtimes, without selecting or
starting connections. Worktree parent associations and Git status are preserved
per connection.
Summaries carry connection IDs and runtime generations; retired reads are
discarded and failures stay per connection. Opening a session uses the existing
connection-scoped navigation path.
Workspace and agent context menus retain their source identity. Other servers'
menus only navigate; workspace and pane mutations use the active scoped client.

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
the 20 most recently viewed, and closes any that nobody returns to within 10
minutes. Legacy direct attaches close immediately because they hold Herdr's
resize lock.

Capabilities are negotiated per terminal socket (again when a stream
reconnects) and rechecked at dispatch:

| Capability                       | Contract                                           |
| -------------------------------- | -------------------------------------------------- |
| `pane.focus`                     | Required to attach; no legacy fallback without it. |
| `pane.scroll`                    | Gates explicit history scrolling.                  |
| `tab.create`, `workspace.create` | Gate creation from the existing endpoint.          |
| `health_check`                   | Enables ping/pong.                                 |

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

## Overlay tabs

A Space's overlay tab is marked in the server's interface settings
(`ui.overlayTabs`: connection id, then workspace id, then tab id), so every
browser and Ranger agree on it. Herdr has no tab metadata to hold the mark, but
it persists workspace and tab ids with its session, so the mark survives
restarts. Marks of closed workspaces, and of tabs this page saw and then lost,
are dropped after a full list read; an empty list never clears them.

`splitOverlayTopology` is the single exclusion point: each list read moves the
overlay tabs and their panes from `tabs`/`panes` to `overlayTabs`/`overlayPanes`
and corrects workspace counts, so no list or count sees them. The overlay renders
through the same pane layout and terminal views as the displayed tab, reading
its own layout and selection through a pane scope; its selection stays in the
browser and never becomes the tab selection. It does not drive the relay
viewport, so showing or resizing it never reflows the panes underneath. Once
shown it stays mounted and hidden with `visibility`, keeping its streams
attached.

Whether the overlay is shown is per browser, connection, and Space
(`overlayShown.v1` in localStorage), and only an explicit show or hide writes
it. The store derives `overlayOpen` from it in `set()` whenever the displayed
Space, the connection, or the Space's overlay tab changes, so a switch shows
the displayed Space's own overlay in the same update that displays the Space,
and no later step of the switch (a refresh started for the previous Space)
can hide it. The overlay is hidden and forgotten only when its tab is gone.

Herdr plugin popups still render through the legacy direct-attach path; the
popup observer is already event-driven (endpoint surface pushes), with one
`terminal.watch_popup` read when a browser connects.

## Workspace resource ownership

A **checkout** owns Files, Changes, and Commits. A workspace supplies routing, a
tab a return location, and a pane optional context. Changes and Last step
snapshots do not prove which agent made a change.

Git resource keys combine `worktree.gui_settings_key` with the normalized
checkout path, per connection. Workspaces on the same checkout may share caches.
Actions remember their originating checkout and never fall back to a sibling.
Terminals stay mounted while the Inspector changes.

Browser preferences live in namespaced `localStorage` and sync across tabs on the
same origin. Navigation, open files, live draft edits, and focus stay per tab.

Message and Agent History composers share drafts by connection destination,
pane, and terminal identity. Each edit saves text in `sessionStorage` for tab
reloads and `localStorage` for reopening the app; a new tab starts with the last
saved text, then edits independently. Connection generations still guard sends
and async uploads, but do not own the saved text. Recovery never sends a draft.
Sending, discarding, closing its pane through Roamgate, or logging out clears
the saved text. Storage events immediately clear live drafts and old session
copies on logout; a shared marker also invalidates copies in tabs that missed
the event. Authentication-loss redirects clear drafts too, including a direct
server redirect to login before the app loads. Successful closes and observed
pane removals clear the shared backup
even when another tab wrote it, and retire drafts from all connection
generations. A fresh topology also clears saved copies of removed panes in a
reloaded tab. Failed close requests preserve editable drafts.
Paths retained after a partial upload failure are saved with the original
destination's draft; reconnect callbacks append paths without replacing newer
edits or sending input. Unsent input may contain sensitive information and
remains in this browser until cleared. If browser storage is unavailable, only
in-memory reconnect recovery is available.

### Workspace arrangement

The user's arrangement of the Workspaces list is stored on the Roamgate server
in `settings.json` as `workspace_tree` (absent while empty) and shared by every
browser. `shared/workspaceTree.ts` defines it and the operations on it, used by
both sides. It is a list of nodes in sibling order, each with an id and a parent
id: label groups, and workspaces named by connection id and a reference. A
workspace whose parent is null and that has no `root` stays in its usual place
and only holds children. `root` marks an explicit top-level placement: `top`
above the list, `list` in the list at Herdr's position but never nested under
its repository, `bottom` below the list. A group whose parent is null shows at
the top of the list, or below it with `root: "bottom"`. A move's parent is a
node, a workspace, `{ root }` for the top level, or null for the usual place.

A workspace reference is its checkout path on its host, else its label, plus
Herdr's workspace id as a hint. `workspace.list` gives an id, a number, a
label and, for Git checkouts, `worktree.checkout_path`. Ids and numbers are
Herdr session state that a restored session may assign again, so they never
identify a workspace alone; checkout paths survive Herdr restarts and host
reboots; labels are the user's to change. Browsers match references to live
workspaces by path, then by label, then by last id (a renamed workspace without
a checkout), each live workspace once, and send the server what changed
(`refresh`). A reference on a connection that is not ready resolves as
offline and one that matches nothing as gone; both keep their place.

Browsers change it through `bridge.workspace_tree.get` and
`bridge.workspace_tree.apply` (up to 64 operations: move, create, rename,
collapse or delete a group, remove a workspace, refresh), which apply in one
settings write and refuse a move into its own subtree or a result over 512 KiB.
Every change, whoever made it, is pushed to every socket as `workspace_tree`.
The server places workspaces itself when it knows who asked: the `worktree.create`
RPC and Ranger's worktree and workspace actions place the new workspace under
the source workspace, and `roamgate-review worktree|workspace|place` under the
calling pane's workspace, or with `--group PATH` into the group that path of
names reaches (`shared/workspaceTree.ts` `resolveWorkspaceTreePath`:
case-insensitive, from the top level, else from the caller's group upwards;
`--create-group` adds `create_group` operations for the missing part, else the
command is refused before anything is made; `roamgate-review groups` lists the
paths). Automatic placement skips a workspace the usual list already
nests there (a worktree made from its repository's main checkout) and one the
user has placed, at the top level included.

Subagent rows read `connections.agent_tasks`, a batch over any connection of
what `agent_tasks.get` gives, trimmed to ids, kinds, titles, statuses and times.
Browsers ask again only when an agent's state or activity changes.

### Worktree Git status

`workspace.list` attaches each checkout's last known `worktree.git_status`
without waiting on Git, except that the first list to see a checkout waits up
to 300 ms for its first read; a slower read (such as a cold SSH login) leaves
that list without a status and arrives as a push. Entries older
than 20 seconds, or invalidated by Roamgate Git actions, auto-sync and finished
agent turns, refresh in the background: one refresh per runtime at a time, with
one batched SSH command on remote hosts and `GIT_OPTIONAL_LOCKS=0` so polling
never takes the user's `index.lock`. A transport failure keeps the previous
status until the next refresh 20 seconds later or an invalidation: SSH exiting
non-zero, a process that cannot start, and a Git or SSH read that exceeds its
timeout (8 seconds, longer for large remote batches) all count as one, so a hung
Git never replaces a known status with an error. A checkout with no previous
status shows the error instead. Stopping a runtime stops its refreshes.
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

## Activity log

With `activity.enabled`, `server/src/activity` records attention, agent states
and recording gaps into `activity.sqlite` in the data directory; behavior and
event shapes are in [the activity log](./activity.md).

- **Storage:** `bun:sqlite` in WAL mode, `synchronous = NORMAL`, a 5-second
  `busy_timeout`, `auto_vacuum = INCREMENTAL`, mode 0600 in a 0700 directory,
  checked with `assertSafeDataPath` (no symlinks). `user_version` is 1; a
  bridge refuses a database with another version. Tables: `events`
  (append-only, ordered by an `AUTOINCREMENT` `seq` that is never reused; a
  blur's `span` is its focus's `seq`), `workspaces` (keyed by the stable
  workspace id), `recorder_sessions` (`last_alive` updated every 60 seconds)
  and `connection_gaps` (`connection_id` null for the whole recorder,
  `excluded` reserved for excluded connections). Times are epoch
  milliseconds; readers render them in local time with the offset.
- **Inputs:** connection status from `ConnectionManager`, Herdr events and
  each agent-status `pane.list` from the connection runtime (current
  generation only), and `activity.presence` RPCs keyed by WebSocket. One queue
  applies them in arrival order, each stamped when it arrived; resolving a new
  Herdr workspace id lists the connection's workspaces and panes first.
- **Shutdown** ends spans and gaps before the connections stop, so a bridge
  stop reads as `recorder_stop`, not `disconnect`.
- **Readers:** `reader.ts` opens its own read-only connection (or, when the
  recorder left no shared-memory file, one with `query_only`), for the
  `bridge.activity.timeline` RPC and `roamgate activity`. `timeline.ts` turns
  rows into day spans and totals and is pure. An `events(kind, ts)` index is
  created on open for the readers. Subjects (`subjects.ts`) are derived at
  read time from the Workspaces tree and `subject_roots`, never stored.
- **Repositories:** `repo-info.ts` reads branch, remote and roots with one
  read-only shell script per connection (SSH background lane), off the signal
  queue; the `repo_branch` and `repo_remote_url` columns are added on open.

## Time-report provider

`server/src/time-report` runs the [time-report provider](./time-report.md)
for `bridge.time_report`: the configured command plus the operation, a JSON
body on stdin, from a fresh empty directory, in its own process group killed
at `timeout_seconds`. Day operations are serialized per day. `day` and
`refresh` get a `DayInput` built from the activity log (`day-input.ts`), with
excluded connections and subjects turned into anonymous excluded gaps.
`submit` is forwarded only with `confirmed: true` and a `confirm_token` from a
`submit-preview` this bridge ran for the same day in the last 15 minutes, once.

## Agent integrations

`integration.list` uses Herdr's RPC as the source of truth. Missing versions are
filled from read-only `herdr integration status` on the same host (over SSH for
remote connections), only when the CLI version matches the running server. CLI
failures leave versions unknown without failing the list.

## Claude Code mod

Roamgate ships a Claude Code mod (`server/claude-mod/`, Claude Code 2.1.304
or newer): JavaScript hooks that run inside Claude sessions, in Herdr panes
and in conversation mode. The bridge embeds its files at build time (a Bun macro,
`agent/claude-mod-files.ts`) and writes them, with the review client, to
`~/.cache/roamgate/claude-plugins` on this machine and on each SSH host: a
directory marketplace `roamgate` listing the plugin `roamgate` by relative
path, so Claude Code reads it in place and an update needs no reinstall
(running sessions take it at `/reload-plugins`). It is installed only by the
user's action, `claude_mod.install`, which runs Claude Code's own `claude
plugin install roamgate --marketplace <that folder> --scope user` on the
connection's host (`claude_mod.status` and `claude_mod.uninstall` likewise);
Roamgate never edits Claude's settings itself. Not offered on Windows.

Its inbox and status part is inert in a `claude -p` run (it draws on no
terminal), in conversation mode's headless claude (`ROAMGATE_HEADLESS=1`),
outside a Herdr pane, with `ROAMGATE_CLAUDE_MOD=off`, and while the review
socket is missing (it looks again every 30 s). Otherwise it speaks over the
review socket
(`$.http.fetch` with `socketPath`), sending the pane, workspace, Herdr socket
and cwd as the client does, so the connection is resolved the same way
(agent/claude-mod.ts):

- `mod_poll` (`session`, `client`: random per module instance, `protocol`,
  `claude`, `after`, `wait_ms`) says hello and is held up to 20 s; it answers
  `{protocol, epoch, messages}`, every message of the pane's inbox above
  `after` not yet acknowledged, oldest first, or `{superseded: true}` once a
  newer client polls for the pane. A mod is live while a poll is in flight or
  ended under 45 s ago.
- The mod submits the messages one at a time with `$.prompt.submit({ text,
  asUser: true })`, which waits until Claude is idle, and acknowledges each
  (`mod_ack`) once its turn started (`submitted`, which removes it from the
  inbox). Ids it already submitted are acknowledged, not submitted again. A
  drop or refusal caused by the user stopping a turn holds the queue
  (`held`) until the main loop's next `turn.complete`; another refusal is
  `failed` (dropped, logged).
- `mod_event` reports `turn_start`, `turn_complete` (its reason, with the
  model, context and plan windows of `$.session.usage()`), `blocked` (an
  AskUserQuestion running, or a permission ask put to the person, Claude
  Code's `PermissionRequest`, unanswered for 2 s, until a hook answers it or
  the call ends; an ask auto mode's classifier settles asks nobody),
  `unblocked`, `usage` and `bye` (`session.end`, except `/clear` and
  `/resume`, which keep the process).
- `mod_tools` (`session`, `client`, `headless`, `gone`) says the session has
  the mod's tools (below).

The inbox (`claude-mod-inbox.json` in the data directory, at most 50 per
pane, a day old at most) survives restarts with its ids and `epoch`; a mod
that sees another epoch reads from the start. Messages whose mod said `bye`
or stopped polling 90 s ago are typed through Herdr's `agent.prompt` once the
pane's agent is idle or done (checked every 5 s, for up to 30 minutes), or
dropped when the pane has no agent; a mod that comes back first takes them.

Delivery (`promptPaneAgent`, the messenger, companion errands, which reach a
session in either mode through the messenger's `deliver`, the profile chip's
Retry) goes to a pane's live mod before
Herdr's `agent.prompt`; conversation mode keeps its own queue. What a live
mod says is laid over Herdr's screen detection wherever Roamgate reads
Herdr's panes and agents (`withOwnedSessions`, `overlayModPanes`): working
and idle are the mod's (Herdr's `done`, idle and unseen, stays), blocked is
either's, and the pane's session is the mod's. Each change is pushed to the
browsers as `roamgate.claude_mod` (they read the panes again) and pokes the
usage limit resumer; `agent_profile.get` carries the mod's `usage`.

In every session, conversation mode's headless claude and `claude -p` runs
included, the mod also gives the model tools (`server/claude-mod/hooks/tools.ts`,
named `mcp__roamgate__<name>`): `review_get`, `review_reply`, `review_add`,
`review_working`, `review_update`, `review_resolve`, `review_reopen`,
`review_edit`, `review_notify`, `agent_message` and `agent_sessions` in the
prompt's tool list, `review_open`, `review_summary` and `review_threads`
behind tool search. Each is one request to the review socket with the body
`roamgate-review` sends for the same command (`comment_id` is `comment`,
`review` is `session`), the pane under Roamgate's names in a headless claude
as the client does, `claude_session`, and `via: claude-mod` without `agent`:
the server names the review's own agent when it runs in the asking pane, else
Claude (`ROAMGATE_REVIEW_AGENT` still names one). Text goes as JSON, never
through a shell. Without the socket a tool answers an error saying Roamgate
is not running. For the user the mod registers `/rg-review [worktree |
BASE..HEAD | compare OLD NEW | URL]` (`open`; Claude Code keeps `/review`)
and `/threads` (`waiting`: the threads that need the session's answer in the
reviews and chats whose agent runs in its pane or is its session), each
answered with a line of text on any surface.

A Claude TUI in a Herdr pane and conversation mode's headless claude (never a
script's `claude -p`) send `mod_tools` at start and every 4 minutes, and a
TUI `gone` when its session ends. The hub keeps it per pane: a terminal's for
10 minutes after its last hello, a headless one's for 7 days (kept in the
inbox file), since Roamgate starts it again after an idle stop. While a pane
has the tools, what the review service sends its agent (comments, the overall
comment, handoffs, review requests) names them (`your review_reply tool
(comment_id: ...)`, `ReviewService` `agentTools`) instead of the client's
command lines; other agents keep the commands. The chat reads an
`agent_message` call as a sent message, as it reads `roamgate-review
message`.

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
  token valid only while the turn runs, read from a temporary mode-0600 config
  file rather than process arguments. MCP tool calls run serially. Interrupted
  Claude Code turns are stopped without replay and their CLI context is cleared,
  because a session pointer cannot prove whether an MCP operation completed.
  The user reviews action receipts before sending a new question. A turn's
  prompt carries the turn's authorized scope and the last 8 receipts in it
  only when they differ from what the same context was last given (`given`,
  kept with the entries the run answered with); otherwise it says they are
  unchanged. A new chat, a cleared or trimmed context gets them whole.
  A chat that changes driver starts
  afresh, and input sent during a Claude Code turn waits as a follow-up.
- **Tools** are defined in `server/src/assistant/tools.ts` and run through
  `callWorkspaceTool` against the turn's approved scope. Pi's built-in tools,
  extensions, skills, and project instructions are disabled, and workspace
  evidence is treated as untrusted.
- **Arrangement tools** (`workspace-tree-tools.ts`): `workspace_tree_get`,
  `workspace_tree_move` and `workspace_tree_group` read and change the
  [workspace arrangement](#workspace-arrangement) with the operations of
  `shared/workspaceTree.ts`, through `applyWorkspaceTreeOps`, so one call is one
  settings write and one push. They list every workspace on every connection
  (labels, paths, branches and placement, no content) whatever the turn's scope,
  name a workspace by connection and id or checkout path, refuse unknown or
  ambiguous items and moves into a subtree with nothing written, and run
  directly in every approval mode, like `show_in_roamgate`: arranging is
  reversible and is never a proposal.
- **Chat threads:** Ranger's panel renders its chat with the agent chats'
  pieces (`web/src/chatSource.ts`, `RangerChat.tsx`). A Ranger chat's comment
  threads are a review of target `chat` keyed `ranger:<chat id>`, whose agent
  pane is the same key (`shared/rangerChat.ts`), so their delivery never looks
  for a Herdr pane. The review service's delivery
  hands them to `deliverChatComments`, a message in that chat (queued behind a
  running turn; "busy", so retried, while another chat shows or a preview
  waits), and Ranger answers with its `chat_thread_reply` tool, bound to the
  turn's chat, which writes through `replyInChat` as author `Ranger`. For voice
  chat, the panel turns snapshots into conversation-mode stream events
  (`createRangerVoiceStream`).
- **Scope:** no workspaces are allowed by default. Each turn captures concrete
  connection/workspace pairs (at most 512) and rechecks runtime leases around
  every read. Only the dedicated confirmation can enable high-permission mode
  (`approval_mode: "auto"` with `workspace_scope: "all"`, "Full access"); its
  turns also reach workspaces created after they started, which join the turn
  (`extendScope`) when a tool names one or lists the scope. A workspace Ranger
  creates (a `created` action result) joins the running turn at once and the
  chat's later turns (`created_workspaces` in the chat's saved state), without
  changing the settings' grant; tasks, which outlive the chat, count only the
  grant. Like a grant, it is dropped once a complete listing no longer has it.
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
  only after its endpoints, Herdr boot IDs, and workspaces are re-verified;
  Claude Code turns instead stop without replay as described above.
- **Tasks** live in `tasks.sqlite`, at `user_version` 3: later additions
  (`tasks.all_workspaces`, the `run_notices` table) are made in place, so an
  older bridge, which refuses other versions, still opens it after a rollback.
  Each state change commits before it is
  published. One scheduled run executes at a time, overdue occurrences are
  combined, and runs re-verify identities and permissions. Run results emit an
  `assistant_notification` push; custom notices are deduplicated by event key.
- **Task runs over fixed workspaces** leave out the workspaces closed since the
  task was saved and name them in the run's notice (a workspace reopened under
  a new id is named, not used); a run fails when none is left, or when one
  still open is no longer allowed. After a connection's Herdr restarted (new
  boot ID), an interrupted run does not resume; a new run reads its workspaces
  again, keeps one whose ID still holds the same path and checkout under the
  new boot ID, and skips and names one whose ID now holds another workspace.
  Each saved workspace is compared with the boot ID of now, so a task can keep
  workspaces of one connection checked on two boots.
- **Unreachable connections:** a new run (scheduled or Run now) waits up to
  five minutes, woken by connection state changes, for a connection that is
  connecting, reconnecting, or failed and retrying; one the user disconnected
  is not waited for. It then runs without the workspaces of a connection still
  down and names it with its state in the notice, or fails naming the
  connections when nothing can be reached. An interrupted run resumes only
  over all of its workspaces. A run that cannot start names the workspace,
  connection, provider or step that failed; messages that may carry transport
  or credential details stay masked.
- **Chat turns over unreachable connections:** a chat turn, typed or said on
  a call, runs without the workspaces of a connection the current workspace
  list could not fully list (offline, connecting, its listing failed) and tells
  the model how many it left out per connection; the grant keeps them for when
  the connection is back. It fails, saying the server is offline, only when
  none of its workspaces can be reached. A turn that cannot start names the
  step that refused it (workspace list, permissions, model listing, model,
  thinking effort, workspace read, references, start) with a fixed message,
  and the server logs that step with the error's class only.

## Reviews

Review sessions and their threads live in `reviews.sqlite` in the data
directory (`ROAMGATE_REVIEW_DIR` overrides), written through on every change
and pushed to every browser as `review` messages; browsers call
connection-scoped `review.*` methods and always write as the user. Browsers
drop a malformed pushed or listed review, and keep comment text not yet saved
per review in `localStorage` (20 per review, 200k characters in all). A diff is
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
(`review.gitlab.find` with `local`), else opens one. Before `glab api`
asks a merge request's host, glab on the checkout host is asked which host
is its default and whether it has a login of its own for that host:
environment tokens (`GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`) and
host-less config tokens go only to the default host, another logged-in host
is asked with them removed, and any other host is refused. Agents are kept
from a merge request's review unless GitLab has named a project that is not
a security one (fail closed: before GitLab answers, after a failed refresh,
or for a numeric project id), and such reviews are left out of a
workspace's `watch`, handoffs and the agent's review list. A shown merge
request review polls `review.gitlab.refresh` every minute while the page is
visible (not again within 30 s when shown again); a poll reads the merge
request alone and keeps its threads while its `updated_at` and head are
unchanged, reading them again at least every 5 minutes.

Agent chats show merge and pull requests through two connection-scoped,
read-only methods, called in the background lane. `forge.status` reads one
request (`{provider, host, project, number}`, checked before anything runs)
with the review's GitLab plumbing: the same host rule (tokens only to glab's
default host or a host with its own login, any other host refused before
glab runs and answered `not_signed_in`), and the same fail-closed security
guard (a security project, a `web_url` not on the asked host, without https,
or naming another request shows nothing). GitHub goes through gh's own login
for each host (`gh auth status --hostname`, then one GraphQL query). Only the
request's own https page is linked. `forge.session` finds the repositories a
pane's session works in with the review pane's repository scan (its checkout,
`subprojects/` on a branch, repositories its agent's record shows it worked
in), each branch's request (`findBranchMergeRequest` for GitLab, the PR
card's lookup for GitHub) and what `!N` and `#N` mean there. The server
shares answers across browsers (one request in flight per checkout host and
request, kept 15 s; sessions 5 minutes) and reads the requests of one forge
host asked within 100 ms of each other, with those asked in the last 5
minutes, in one GraphQL query (aliases per project and request; the REST
reads when GitLab answers no data), keeping each answer 45 s while a
pipeline runs, 2.5 minutes while open and 30 minutes once merged or closed;
a refresh click (`fresh`) asks anyway. Every glab and gh call goes through
the forge gate described above. Browsers keep one cache entry per request
and connection, ask only while a chip, row or header showing it is on screen
and the page is visible, and refresh every 60 s while a pipeline runs, three
minutes while open, six hours once merged or closed, ten minutes when not
signed in, with errors backing off from 30 s to ten minutes. Chips are
drawn into slots put in the sanitized Markdown after it renders (never in
code); what the forge says is not selectable message text and never goes to
an agent. The history marks a `glab mr create` or `gh pr create` result with
the URL it printed (`created_request`), kept when the payload is redacted.
A file-editing call (Edit, MultiEdit, Write, NotebookEdit) carries what it
changed (`file_edit`, shared/fileEdits.ts), also kept when redacted: Claude
Code's patch from its result record (`toolUseResult.structuredPatch`, with
line numbers and context, or a new file's content), else the change its
arguments ask while it has no result, none once it failed; at most 160
lines, its counts whole. A call that wrote in Roamgate's threads (the
review_reply, review_add and review_edit tools, or `roamgate-review reply|add|edit`
run from Bash or Codex's exec_command, read with the same shell parser as
agent messages) carries `roamgate_write` (shared/toolSummary.ts): its
action, its `description` argument, the review, thread and comment its
result names, where it went (the words quoted, file:line) and the words
written (4000 characters at most), kept when redacted and computed again
from arguments and result, so past conversations get it too; nothing is
stored. A refused call has none. A call streamed in conversation mode gets the same
from its arguments until the transcript has it, and a permission prompt
for such a call carries the change it asks to make.
A comment on such a change (web/src/fileEditComments.ts) is a thread of the
chat's review whose anchor has a `chat` part on the call's entry (its time,
and the tool call's own id as `chat.call`, by which it is found when the call
is read with another entry id) plus the file as a review comment has it:
`path`, and on lines `line`/`endLine` on side `new` (as the change numbered
the file; `old` when only removed lines are taken) with the first line's
`text`; `chat.quote` holds the lines, marked +/- when removed lines are taken
with others, or the path for the file as a whole. The card finds the lines
again by number and text, else by text near the number, else by the quote,
and otherwise shows the thread at its end with the quote. The delivery names
the file and lines and quotes them, and asks the agent to treat them as
review comments on code; `roamgate-review` lists such a thread with its
`path`, lines and `on_chat_message.tool_call`.

Review diffs run git with the settings that change a patch's shape pinned
(`core.quotePath`, `diff.noprefix`, `diff.mnemonicPrefix`,
`diff.suppressBlankEmpty`, external diff and textconv drivers off), Git Bash
on a Windows server. Context read from the working tree must be a regular
file inside the checkout, links resolved. Images pasted into comments are
stored under `<review dir>/images/<review id>/` and served to signed-in
browsers by `/api/review/image`; a discarded review keeps them until the
bridge restarts, so its undo brings them back. A review restored by that
undo is rebuilt field by field: its id must be a review id, and a thread id
another review uses is replaced.

Agents reach the bridge through one unix socket per connection in
`<review dir>/agent/`, served as HTTP with JSON (requests up to 1 MiB, at
most 8 watches at once per review). Local panes find it through the
`~/.cache/roamgate/review.sock` link, which the bridge replaces in one step
when it starts (not on a Windows server) and removes on exit while it still
points there. A local pane whose `HERDR_SOCKET_PATH` names a Herdr server
Roamgate is not connected to is refused, so its pane ids never reach another
server's panes. On an SSH host, each time the connection's command master is
ready the bridge installs the client and adds
`ssh -O forward -R ~/.cache/roamgate/review.sock:<socket>` on that master, so
agents there use the existing login and no port listens. On each machine
the client's skill (`SKILL.md`, the manual agents read when it triggers)
is installed beside it and linked into `~/.claude/skills` and
`~/.codex/skills`, where Claude Code and Codex look, when those folders
exist and the name is free. An agent signs with
a plain name, can edit only its own comments and cannot post on GitLab. Its
reply to a thread whose last comment is already its own is refused (409),
pointing at `review_edit` (the client's `edit`) on that comment: it
corrects its answer instead of answering itself. The
user's discussion comments reach a review's agent as a prompt typed into its
Herdr pane (`agent.prompt`), or through its pane's Claude Code mod when it
runs one, a few seconds after they are written: a burst
goes as one prompt, one delivery at a time per review, without control
characters and cut at 16,000 characters. Only connections whose host has
the client get them (local connections once it is installed, SSH hosts once
the setup above succeeded); elsewhere the review says why. So does a
review whose agent has no known pane: the overlay attaches the workspace's
agent pane it shows the review as live with, and **Retry** on an
undelivered comment attaches it or sends again. A busy agent is
tried again up to 10 times, 15 s apart at first and doubling up to 10
minutes. `watch`, a long poll on the service, is for agents without a pane.

Comments follow the agent's session, not a pane. When a review binds an agent
pane, the service records the session Herdr (or conversation mode) reports there
(`agent.sessionId`); a chat's threads (target `chat`) follow the chat's own
session, and an upstreaming effort's (target `effort`, anchored by
`anchor.effort`: tab, item kind and stable key, the plan a commit was shown
in, the words) follow its leader, looked up as the session `effort:ID`: the
Claude pane of its head workspace, as the Leader session button finds it,
none (the comments wait) when it runs nowhere. Each delivery looks the session up (`agent.list`, with the panes
conversation mode holds): the pane reporting it, else the pane reporting the
session a Claude session went on in after a resume or /clear (its successor
transcript, see `session-resolver.ts`). That pane becomes the review's pane. A
review whose session is not found tries the pane it was bound to, and forgets a
pane with no agent left, so the overlay attaches the workspace's agent pane in
its place; a chat's threads never go to a pane running another session. When the
session runs in no pane, the review says so in plain words ("Claude for this
chat is not running in any pane") and the comments wait: the service looks for
the session every 20 s (and again after a restart, for a review that still has
an error and comments waiting) and sends them once it runs again, as does the
next comment or **Retry** in a chat's threads (`review.retry`). A user comment
answered in its thread counts as delivered, however it got there
(`unheardComments` in `shared/review.ts`): only newer ones and edits made after
the answer are sent.

### Agent messages

`roamgate-review sessions` and `message` (server/src/agent/agent-messenger.ts)
let agent sessions message each other. The list reads every ready connection
(not a Windows server): Herdr's agents, with the panes conversation mode holds,
named by their tab's title else their workspace's, addressed
`CONNECTION/PANE`. A message must come from a pane that list knows (its
address is the reply address) and go to another one in it. Its text loses its
control characters and any closing tag of its own, is at most 8,000
characters, and is framed (shared/agentMessage.ts): a preamble, a
`<roamgate-agent-message from=... from-name=... workspace=... agent=...>`
block, and a note saying it is another agent's, carries no user authority,
approves no permission, answers no question of the user's and authorizes
nothing outward and is no reason to edit settings or CLAUDE.md, in about
25 words (`agentMessageNote`, in every message: the line that keeps a
peer's words from passing for the user's), then the reply as the receiver
makes it: `mcp__roamgate__agent_message to=ADDRESS` when its pane's Claude
has the mod's tools (`ClaudeModHub.hasTools`), else the client's
`~/.cache/roamgate/bin/roamgate-review message ADDRESS -- TEXT`. The chats
strip that note, and the longer one older transcripts hold
(`AGENT_MESSAGE_NOTE`). The frame comes first, so typed into
a terminal it is never a slash command or a `!` line. A conversation-mode
session gets it through `ConversationService.prompt` (the queue: no
permission or question is ever answered by it); a terminal Claude running
Roamgate's Claude Code mod through the mod's inbox; another terminal session
through Herdr's `agent.prompt` when its agent is idle or done, else polled every 3 s
for up to 30 minutes, at most 5 waiting per session. Limits: 20 messages per
sender and 8 between two sessions (both ways) in ten minutes, refused with
429. The chats parse the frame as an injected notice (**From NAME**, kept out
of voice and of the user's messages) and show a `roamgate-review message`
Bash call as **To NAME** beside it.

### Reviews inbox

`server/src/mr-reviews/` serves `bridge.mr_reviews.*` to every browser,
machine-wide. Hosts are the settings' `mr_reviews.hosts`, or when empty
those glab (`config.yml` hosts with a token, a keyring token, or glab's
default host) and gh (`hosts.yml`) are signed in to; only host names are
read from those files. Nothing user-specific has a default: followed
projects, hosts and hints are settings.

Each refresh sends one GraphQL query per host through the forge gate
(feature `inbox`): GitLab `currentUser` review-requested, assigned and
pending mention to-dos plus each followed project's open merge requests;
GitHub `search` for review-requested, assignee and mentions plus each
followed repository's open pull requests, with the viewer's pending review
(its comment count is the draft count). GitLab draft counts are a
conditional read of a request's `draft_notes`, only for requests
reviewed in Roamgate, when the request changed or hourly. A host that fails keeps its last answer.

The user's own requests are read per host and refresh in two steps. A
light list (kind `own`: number, project, title, state, updatedAt, head,
branches): GitLab `currentUser.authoredMergeRequests(state: opened)` and
GitHub `search` `is:pr is:open author:@me`, by creation, 100 a page and
paged to the end (10 pages at most, logged when cut), whose first page also
asks the latest 10 merged and closed (GitLab: 10 of each); settled ones
older than `retentionDays` are dropped. Then the details (kind
`own-details`: pipeline, notes, base, pending review, and `own`,
`MrOwnStatus`: approvers, approved, changes requested, unresolved threads,
conflicts, needs rebase), up to 40 requests per query, one alias per project,
only for a request new, updated or with a new head since its details were
read, still settling (pipeline running or pending, mergeability being
computed), or, for up to 10 open ones per refresh, read over an hour ago.
The others keep the details in the store (`ownDetails`, by key, dropped
once the request leaves the list). Every listed item has `reasons:
["authored"]`. A GitLab host whose schema refuses one of the full fields
(`approved`, `approvedBy`, `detailedMergeStatus`, the discussion counts) is
asked the basic ones (`conflicts`, `shouldBeRebased`) from then on; a list
that fails keeps the host's last own items, details that fail keep those
known.

Every inbox query (the to-review query, the light list, the details) stays
under the host's GraphQL complexity limit (`complexity.ts`): its
complexity is estimated as GitLab counts it (a field 1, a resolver its
selection plus 1, 1 more when sorted, 1% more per item it loads unless
asked by id), and its parts (the user's lists and each followed project;
the open page and each settled list; the requests, by project) are cut in
as many queries as fit under 250 for GitLab, no limit for GitHub. A query
refused with "Query has complexity of N, which exceeds max complexity of
M" teaches that host M and how far the estimate fell short (kept in
memory for the bridge's life); it is split and asked again at once, so
the refusal never shows unless a single part is refused alone. The field
levels above fall back only for refused fields, never for complexity.
Their entries get the section `authored` (after `mine`; pinned wins), and
they are seen (never `isNew`) when first listed. `MrSeen` keeps the state,
pipeline, approvers, unresolved count and conflicts too (`mrSeenOf`), so
`mrUnread` says what changed among those; a record from before they were
kept says nothing about them.

`bridge.mr_reviews.links {keys?}` gives each listed request's workspaces,
on every ready connection (`links.ts`): one `workspace.list`, one
`pane.list` and one git script (branch, upstream, remote URLs of each
workspace's checkout, else of its panes' folders) per connection, kept a
minute. A workspace is a request's when its checkout is
on the source branch or tracks it in a clone of the project (a remote is the
project, or has its repository name on the same host: a fork), when its name
carries the number (`!12`, `#12`, `mr-12`) or the branch in such a clone or
outside any repository, or when it holds the request's review (its review
record, or the project's review worktree checked out on it). A source branch
that is the target's, `main` or `master`, never matches. No forge call.
A request's home made by `bridge.mr_reviews.home {key}` (state
`homes[key]`: connection, workspace, worktree, branch, review and Claude
session) matches as `home`, ranked first. Homes are the links with any
reason but `review` alone (`mrHomeLinks`); the page opens a request with a
home through `bridge.mr_reviews.open {key, home: {connection_id,
workspace_id}}`, which fetches its head into that checkout (from the remote
that is the project, else its https URL) and opens its review there
(`home.ts`). `home` makes the worktree through `createWorkspaceWorktree`
from the clone's own workspace (opened when none is: Herdr starts worktrees
from the repository's parent) on the source branch name (or
`review/N-name` when the clone has that branch), `reset --keep` to the head,
renames the workspace `!N title`, places it as the project's review
workspace (`tree_groups`), opens its review bound to its first pane, types
`claude --session-id` there and sends the prompt (`mr_reviews.home_prompt`,
else `DEFAULT_MR_HOME_PROMPT`) once Claude is idle (`agent.prompt`) or held
by conversation mode (its own prompt), for up to ten minutes. An existing
live home is reused.

State
(`<data>/mr-reviews/state.json`): what the user saw of each request
(unread), feedback, Claude's picks, each request's Roamgate review and the
time it was seen merged or closed, and each project's review worktree. The
inbox never writes to a forge.

The user's order of the list is the settings' `mr_reviews.order` (request
keys, at most 500), one flat list applied within each section (pinned, mine,
authored, suggested), requests not in it first; it wins over the inbox's own sort in
every section. It is server state, with a version: `mr_reviews.order_version`
(`orderVersion` in the settings, returned with each
`bridge.mr_reviews.inbox` as `orderVersion` beside `order`) counts every save
that changes the order, the pins or the removals, bumped inside the same
atomic `settings.json` write (`saveSettings` in `module.ts`). A change is an
operation on the latest order, never a list written over it:
`bridge.mr_reviews.order {op: top|bottom|before|after|arrange, keys,
target?}` (`shared/mrReviewsOrder.ts` applies it to the displayed sections;
before/after act in the target's section, keys of another section are
reported as `elsewhere`, unlisted ones as `unknown`) and `{op: "undo",
version}`; all changes run one at a time (`mr-reviews/order.ts`). A whole
list saved with `settings.update {settings: {order, orderVersion}}` by a page
that has fallen behind is rebased onto the latest order (what it moved,
against the list shown at its version, which the server keeps for the last 40
versions) instead of replacing it; without a version it replaces. The panel
sends its moves and drags as `before`/`after` operations.

Every save that changes the order, the pins or the removals is pushed to
every socket, whichever connection a page shows, as
`{"mr_reviews": {version, order, changed: ["order"|"pinned"|"hidden"|
"overrides"|...], by: "user"|"agent", summary?, undo?}}` (like `workspace_tree`; the page parses it
in `api.ts` as `onMrReviews`). A page keeps the highest version: it applies
the order at once (an order-only change needs no read), reads the inbox again
for pins and removals, and an inbox answer older than a push never takes the
order back. An agent's changes carry a `summary` ("Claude moved 3 requests
to the top") and `undo` (the version Undo takes back), whatever they
changed: the panel shows them in its toast, `u` sends the `undo` operation.
The server keeps the whole `mr_reviews` value of the last 40 versions:
undo restores each field that change touched unless it changed since, the
order by what that change moved on the latest order, pins and removals
element by element, overrides key by key.

What the user (or an agent) sets by hand on a request is
`mr_reviews.overrides` (request key to `{whose?: "me"|"reviewer"|"external"|
{person}, next?, depends_on?, labels?, link?, stale?, at, by, marker}`, at
most 500, the oldest set forgotten first; `next` 200 characters, 10 labels
of 40, `link` 1000), checked in `mr-reviews/overrides.ts`.
`bridge.mr_reviews.override {key, set?, clear?: FIELD[]|"all", by?,
summary?}` applies one change (dependencies given as references or URLs are
stored as keys), answering `{changed, override, version}`; setting
`whose`, `next` or `stale` records the request's `mrActivityMarker` as
`marker`, and an entry whose marker moved since carries `overrideOutdated`.
`entries()` then gives every own request (`reasons` has `authored`) a
`lane` (`your_move|waiting|merging|blocked|not_sent|stale|done`;
`your_move` shows as Needs you), `laneWhy`, `next`
(`{text, from: "override"|"rule"|"inferred", by?}`), `dependsOn` and
`parent` (`mr-reviews/lanes.ts`): an override's `stale` or `whose` when not
outdated, else the inference (below) while it holds, else rules from the
forge's status (merged or closed: done; an
open dependency: blocked; quiet `stale_days`, default 90: stale; failed
pipeline, conflicts, changes requested, unresolved threads, needs rebase
or draft: `your_move`; else waiting). `parent` is the first open listed
request it waits for, unless that makes a cycle; the panel draws it under
its parent (`web/src/mrReviewsLanes.ts`).

The inference (`mr-reviews/inference.ts`, section 7, D7): the own details
query also asks GitLab `description` and `discussions(last: 10)` with each
one's last note (`full` fields only), GitHub `body`, `comments(last: 5)` and
`reviewThreads(last: 20)` last comments; `OwnDetails` keeps the
description (1500 characters) and `lastNotes` (10, 300 characters each,
system notes dropped). `state.json` `inferred` (by key: `{whose, next,
dependsOn, stale, version, facts, at, by: model|local}`) and
`inferenceAt`. A row's version is `head|notes|state|pipeline|unresolved|
conflicts|needsRebase` (branches: `head|ahead|behind|dirty`); its facts
(state, pipeline, conflicts, changes requested, approvals, the last note by
someone else) tell a meaningful change. After each refresh, once every
`mr_reviews.inference_hours` (default 12) every open own row whose version
moved is inferred, oldest first, 20 a batch (`runClaudeModel`, no tools,
the people's text marked as data) on `mr_reviews.inference_model`, any
name the agent takes, else the automatic model (D27: from the default
agent profile, `profileInferenceModel`: `sonnet` on Anthropic's endpoint,
behind a gateway the profile's `ANTHROPIC_MODEL`, else its Sonnet or Opus
slot; listed with the profile's models from the profiles' model discovery
by `bridge.mr_reviews.inference_models`); the suggestions keep their own
(`CURATION_MODEL`, Opus); between
runs only rows with a meaningful change, each at most every two hours.
Dependencies found without the model (references in the description and
notes resolved to listed requests; a request whose patch ids are all in a
smaller one of the same project waits for it) are kept with the model's;
when the model fails they are stored alone (`by: "local"`). `entries()`
attaches `inferred` and `inferredOutdated` (version moved and the facts
changed meaningfully); lanes use a current model inference after an
override (`whose`, `stale`, `next`; branches keep their lane). RPC
`bridge.mr_reviews.infer {key}` and tool `reviews_refresh {request?}` force
one row; `mr_reviews.inference` (default on) turns the runs off.

Scheduled merges and merge bots (`shared/mrReviewsMerge.ts`, section 15,
D26): settings `mr_reviews.merge {after_labels?, bots?, bot_failures?,
queue_labels?, scopes?: {<host | host/group/* | host/project>: lists}}`;
an absent list is the default, a scope's list replaces the inherited one
(the most specific scope wins per list), patterns are case-insensitive
regexes checked when saved (20 a list, 200 characters). The own details'
`full` fields (a new level above `nomerge`, the former full, then `basic`)
add GitLab `assignees`, `reviewers`, `autoMergeEnabled`, `mergeUser` and
the system notes among the last discussions, GitHub `assignees`,
`reviewRequests`, `autoMergeRequest`, `mergeQueueEntry` and a
`timelineItems` slice; `OwnDetails.merge` keeps them as `MrMergeFacts`
(assignees, reviewers, auto-merge, queue, `approvedAt`, events, label add
times). GitLab label add times come from REST `resource_label_events`
(`InboxFetchers.gitlabLabelEvents`, kind `label-events`), read only for a
request whose details were just read, that carries a merge-after label,
and whose merge-after labels differ from the last read (`labelTimesFor`),
at most 20 a refresh. `entries()` sets each open own request's `merge`
(`{after?: {label, delayMs, delay, from: label|approval|update, since, at,
ready}, bot?: {name, via: assignee|reviewer|label|queue|auto_merge,
queued, position?, by?, failed?: {reason, at}}}`); a failure is the bot's
latest note matching a pattern, the bot unassigning itself, a merge-queue
removal or auto-merge turned off by someone else, newer than the bot's
latest assignment or queueing. Rules: a failure is `your_move`, queued is
`merging`, a delay not over is waiting, over is `your_move`; these rules are
`exact` and win over a model inference, overrides still win. The merge
state is part of a row's version and facts (`scheduled|ready|queued|
failed:AT`), so the time passing, a queueing and a failure are meaningful
events; the inbox sets a timer for the soonest mergeable time that
notifies the pages and runs the inference (no forge call). Board tool rows
carry `merge` (`mergeable_at`, `via`, `failed`).

Export and import (`mr-reviews/export.ts`, `cli/reviews.ts`, section 11):
`{format: "roamgate-reviews", version: 3, exported_at, mr_reviews: {order,
pinned, hidden, overrides, views, unsent, upstream_groups, upstream_skip,
upstream_workspaces, efforts, merge, hosts, followed, hints} as stored,
efforts: {<id>: {ledger (without journal), history}}}` (version 2 added
the hosts, followed projects and hints, version 3 `upstream_workspaces`)
in key-sorted JSON (`stableJson`), every key matching a secret pattern
dropped and token-like values masked (`withoutSecrets`). `importChanges`
diffs item by item (overrides and ledger entries by key, lists by id,
key, name or ref, the order whole, histories by line count), flagging
`newerLocal` by `at`. Applying replaces the exported keys (others kept,
`order_version` bumped), each ledger (journal emptied, version past the
local one) and merges history lines. `roamgate reviews export [--out]` /
`import FILE [--apply]` work on the files; RPCs `bridge.mr_reviews.export`
(`{text}`) and `bridge.mr_reviews.import {text, apply?}` (`{applied,
changes}`, applied through `saveSettings` with its push).

The board's tools are one handler table (`mr-reviews/board-tools.ts`:
`reviews_list` with lanes, next steps, overrides and paging, `reviews_override`,
`reviews_order`, `reviews_sort`, `reviews_pin`, `reviews_unpin`,
`reviews_hide`, `reviews_unhide`, typebox schemas) shared by the reviews
agent and every agent session: the review socket's `reviews` command
(`{tool, params}` with `params` a JSON object, checked against the tool's
schema; `roamgate-review reviews TOOL JSON|-`) runs
`createMrReviews().boardTool(tool, params, caller)`, `caller` naming the
session's agent and workspace in the push's `summary`. They read and write
only Roamgate's own state.

The search is `shared/mrReviewsFilter.ts` (`parseMrFilter`,
`mrFilterMatches`, `mrFilterCompletions`), shared by the panel, the saved
views and `reviews_list`'s `filter`: `key:value` tokens (project, label,
waiting, lane, state, stale, draft, author, pipeline, effort, is), each
negatable, several values of one key ORed, unknown keys kept as words.
Labels are the forge's (`labels` on `MrItem`, read with the inbox and own
list queries, at most 10) and the override's. Saved views are
`mr_reviews.views` (`{name, query}`, at most 20, names without `:` or `"`),
returned with the inbox as `views`, changed by
`bridge.mr_reviews.view {action: save|delete, name, query?}` (a save of an
existing name replaces its query) and pushed as `changed: ["views"]`.
The panel's search and filter are `mr_reviews.panel` (`{search, filter,
at}`), written by `bridge.mr_reviews.panel {search?, filter?}` (`at` strictly
after the previous write), returned with the inbox as `panel` and pushed as
`changed: ["panel"]` without a new version; a page takes a panel whose `at`
is newer than the one it last wrote or took, unless it is typing or saving.

Branches headed upstream (`mr-reviews/upstream.ts`): settings
`mr_reviews.upstream_groups` (Workspaces-tree group ids, at most 50; groups
below them count, ids of deleted groups are dropped on each tree change)
and `upstream_skip` (`WorkspaceRef`s, at most 200), plus
`upstream_workspaces` (`WorkspaceRef`s headed upstream by themselves, in no
such group, at most 200), changed by
`bridge.mr_reviews.upstream.group {group, headed}` and
`upstream.workspace {ref, headed}` (in a marked group of the tree it skips
the workspace or brings it back; elsewhere it marks or unmarks it by
itself) and read by `upstream.marks` (`{groups, skip, workspaces}`);
pushed as `changed: ["upstream"]`. The board tools name a workspace by
label or checkout path among the tree's workspace nodes and the live
workspaces with no node, the latter as `workspaceRefFor` names them on the
pages, so a mark made by a tool and by a menu is the same. Members are the workspace nodes under
such a group resolved to live workspaces (`resolveWorkspaceTree`), and the
live workspaces (with a node or none) matching `upstream_workspaces`,
whose home is `upstreamWorkspaceHome(ref)` (`ws-` and 16 hex digits) where
a group's is its node id. One script per
connection (`upstreamScanScript`, kept a minute) reads each checkout's
branch, head, dirty and unpushed counts, remotes, and for `upstream` then
`origin` the default branch with ahead/behind; the commits and their patch
ids (`branchCommitsScript`, at most 200) only when the head or the target
moved. The target project is the first of those remotes on a configured
host. A branch is a request's when an own, not closed request of that
project has it as source branch, or holds all its commits by patch id
(`requestPatchIdsScript` fetches the request's head into
`refs/roamgate/mr/<n>` only when that ref is not at the inbox's
`headSha`); that request carries `fromBranch` and `local`. Other branches
are entries keyed `branch:<provider>:<host>/<project>@<branch>` (D6) with
`branch` (`MrBranchInfo`), `number` 0, section `authored`, lane `not_sent`
by rule. `mr_reviews.unsent` (`{key, title?, target?, at}`, at most 200)
marks those said to be requests (`bridge.mr_reviews.unsent {key, unsent,
title?, target?}`, push `unsent`). After each inbox refresh, any branch key
in `order`, `overrides` (keys and `dependsOn`) or `unsent` whose request is
now listed is renamed to the request's key in one settings write.
`bridge.mr_reviews.links` answers a branch key with its workspace.

Upstreaming efforts (`mr-reviews/efforts.ts`, `effort-service.ts`):
settings `mr_reviews.efforts` (`{id, group, name, clone: {connection_id,
path}, source, target: {remote, branch}, feeders?, head?}`, at most 30;
`source` and feeders exact refs; `group` is its home: a marked group's
node id or a workspace's `upstreamWorkspaceHome`), pushed as
`changed: ["efforts"]`. Per
effort, `<data>/mr-reviews/efforts/<id>/`: `ledger.json` (authored:
dispositions by ledger key with the secondary key subject and author date,
`aliases` of later patch ids, a journal of the last 100 bulk changes, a
version), `derived.json` (commits with disposition and note, feeders,
daily counts, the heads it came from) and `history.jsonl` (append-only,
one line per version of a commit: key, sha, patch id, subject, author
date, seen at, where). A refresh (at most every minute, after inbox
refreshes and on viewers) runs `effortHeadsScript` (source, target and
feeder heads; every 15 minutes `ls-remote` of the target and, when it
moved, a fetch by URL into `refs/roamgate/upstream/<remote>/<branch>`),
and only when a head moved `effortCommitsScript` (`git log` with files,
`patch-id --stable`, `git cherry target source`, `git cherry source
feeder`); requests' patch ids come from their heads fetched into
`refs/roamgate/mr/<n>` when moved. Ledger keys are first-seen patch ids,
kept across rewords (same patch id) and rebases (subject and author date).
Authored not_for_upstream and superseded win (flagged upstream anyway);
otherwise upstream, in review, in a part, then the authored planned or
by-hand dispositions, else unsorted. RPCs `bridge.mr_reviews.effort.{set,
preview, delete, get, refresh, history, leader}` and `ledger.{set, undo}`
(bulk, at most 500, all or nothing); a ledger change is pushed as
`changed: ["effort"]` with `effort: {id, journal}`. The inbox carries the
cards as `efforts` (counts, not ready, overlaps by patch id with other
efforts and branches headed upstream, D23; proposals to confirm, plans by
state, what changed). Deleting an effort removes its declaration only (a
name several efforts share is refused: the id says which); its ledger stays
under its own id for Undo, other efforts' ledgers are their own files.
Tools: `effort_get`, `effort_set` (with `preview`), `effort_delete`,
`ledger_list` (200 a page, `cluster`, proposals per commit), `ledger_set`,
`effort_overlaps`, `ledger_match`, `ledger_plans`, `part_create`.

Fuzzy matching (`mr-reviews/fuzzy.ts`, D14): when the commits are read
again and some commit is not upstream exactly, `upstreamCandidatesScript`
reads `git log --numstat` of `merge-base..target` (at most 3000) and drops
those `git cherry source target merge-base` marks as exact; kept in
`derived.json` `upstream` keyed by source, target and merge base. Each
unsorted commit is scored against candidates sharing a file, a directory
or a rare subject word: paths (file Jaccard, else half the directory
Jaccard) 0.35, subject words weighted by inverse frequency 0.35, author
0.1, change size on shared files 0.2; the top three above 0.42 are
`derived.proposals`. `ledger.json` `matches` (by key: `accepted`,
`rejected` shas) records decisions (`bridge.mr_reviews.ledger.match`,
journaled): accepted makes the commit authored upstream with the upstream
sha as pointer and appends a `where: "upstream"` version to
`history.jsonl`; rejected shas are never proposed again. Planned requests
(D25) are `ledger.json` `plans` (`{id, name, commits: keys in source
order, dependsOn, state: proposed | accepted, part?}`), changed by
`bridge.mr_reviews.ledger.plans` (`propose`, `accept`, `edit` with
`add`/`remove`, `split`, `drop`; journaled with the plans before, so Undo
restores them); their commits derive as `planned`, and a commit is in one
plan across efforts (D4: another effort's planned commits derive as in a
part of it, and plan changes refuse them). `bridge.mr_reviews.effort.part`
makes an accepted plan's part through the same `createWorkspaceWorktree`
path as the workspace menu (the `worktree_command` setting), `reset
--keep`s the fresh worktree onto the target, cherry-picks the commits (no
`-x`), stops on a conflict (reported with its files, never aborted),
records `part` on the plan, places the workspace in the effort's group and
adds its branch to `unsent`; with `refresh: true` it only reads an
existing part's worktree and branch (base, from, ported, unfolded fixups,
stop) and rewrites its `part` record through the same journaled plan
change, never moving a ref or a file. `effort.open_commit` opens a range review
(`sha^..sha`, or with `from` a tree-to-tree compare of two versions) in
the head workspace and answers its snapshot, which the page shows as a
home's review (workspace focused, Changes up); `effort.diff` answers `git
range-diff` of two versions (never stored), the fallback when that
workspace is not open. `seen.json` (runtime, not exported) is the
snapshot of dispositions, feeders' not-ready counts, merged plans and
upstream-anyway commits the user last saw (`effort.seen`); the first
reading writes it; `effort.get` answers `changes` against it. For the
Board, `effort.get` also answers `board`: per plan with a part, the inbox
entry it is, from the entries the inbox already computed (no forge call):
the request its part's branch is (`requestOfBranch`: by source branch
name, else by the patch ids of the user's requests read for linking), else
that branch's own row; a part whose checkout the scan did not read is
found by its branch name among the user's requests of the effort's
project. The page puts each plan in a column (`mrEffortColumn`): Planned,
Not proposed yet, the request's lane, or Done, preferring the live inbox
entry of the same key. Comments on a card anchor to `{tab: "board", item:
{kind: "card", key: <plan id>}}`.

Pinned and hidden requests are settings too: `mr_reviews.pinned` (refs
`{provider, host, project, number}`, newest first, at most 100) and
`mr_reviews.hidden` (`{key, marker}`, at most 300, the oldest forgotten
first). `bridge.mr_reviews.pin {text}` takes a URL on one of the effective
hosts or `project!12` (`parseRequestRef`), saves it, un-hides it and reads
it at once (a request a list already has needs no read); `unpin {key}`, `hide {key}` (a pinned request is unpinned,
another is hidden, answering `action`) and `unhide {key}` edit the lists
one at a time. A pinned request the inbox's queries do not list is read
with the single-request query (feature `inbox`, kind `pinned`, one call
each, at most 20 per refresh: new, failed, open or older than an hour) and
kept in `state.json` (`pins`: the item, or the error); a listed one uses
its list copy. Inbox entries get the section `pinned` (before `mine`), and
a pin the forge did not give is an entry with `unavailable` saying why.
`marker` is `mrActivityMarker` (head, comment count, state) when the
request was hidden: the entry is out of `entries` while it matches, and
listed in the inbox's `hidden` meanwhile; any change shows it again.
Pinned requests are in `items()`, so open, seen and the agent's tools know
them; the order and the search are the browser's, over all three sections.

`bridge.mr_reviews.open {key, checkout?}` finds the project's clone (its
recorded review worktree, the settings' `clones`, else, connections in
order default first, then this machine, then the others, a scan of the connections' workspace and pane
directories for a main checkout whose configured remote URL is the
project), makes `<clone>.worktrees/review` (`git worktree add --detach`)
and its Herdr workspace, fetches the head into `refs/roamgate/mr/<n>`
(`refs/merge-requests/<n>/head` or `refs/pull/<n>/head`, with the target
branch for the base), opens the review session (target `mr`, root the
worktree) and checks out the head detached when the setting says so. A
worktree with local changes answers `dirty` and is left alone;
`bridge.mr_reviews.checkout {key, local: wip|discard}` is the user's
answer (WIP commit on `review/<n>`, or reset and clean). A workspace it
creates is placed once through `applyWorkspaceTreeOps`
(`mr-reviews/tree.ts`): the `tree_groups[project]` path of names, else a
"Reviews" group under the clone's workspace node, else at the top, groups
created when missing. Worktree commands
for one project run one at a time. After each refresh the heads of the
user's own open requests and the picked suggestions are prefetched, one
fetch per project with a review worktree, only for a head not fetched yet
(`prefetched`); requests closed longer than `retention_days` lose their review
session and state. GitHub pull requests use the same review code path
through `review/github.ts` (reads only; their drafts come with the pending
review support).

`mr-reviews/claude.ts` (the start command follows `claude_start_mode`;
when conversation mode holds the pane, a switch is the conversation
service's `switchSession`: the idle process stops as idle stop stops it,
the lease and the holder take the other session, a process starts on it;
a busy session refuses): the review workspace's first pane runs the
request's Claude session (`reviews[key].claudeSession`), typed into its
shell as ` env ROAMGATE_CLAUDE_START=terminal claude --session-id ID`
(or `--resume ID`, falling back to `--session-id`). Which session runs
comes from Herdr's `agent.get` (`agent_session`), else the session last
started there (`projects[key].claudeStarted`). Switching request
(`bridge.mr_reviews.open` after its checkout, or `bridge.mr_reviews.claude
{action}`) types `/exit` only into an idle Claude of another request's
session, waits for the shell, then resumes; a busy one is reported
(`busy`), and `switch` waits for it to finish. A Claude of no request
(`foreign`) is never touched. `review` then calls the review service's
`requestAgentReview` with that pane, so Claude's threads are the review
pane's own (local) threads.

Forge drafts: `review/github.ts` keeps the user's drafts in their pending
GitHub review, through GraphQL (`reviews(states: PENDING)`,
`addPullRequestReview` without an event, `addPullRequestReviewThread`,
`updatePullRequestReviewComment`, `deletePullRequestReviewComment`, the
review body for the overall comment as draft id 0), answered in GitLab's
draft note shape so `review/service.ts` keeps one path. Only browser
calls (author `you`) create, edit or delete one; agents' drafts stay
local, and `review.adopt {thread_id}` (the user's "Make it mine") turns
an agent's thread into the user's draft. No code path submits a review.
A pull request's conversation (issue) comments are read as general
`merge-request` threads (`ghc:<id>`) without a discussion id: GitHub has no
draft reply to them, so the service refuses one and the pane says so.
A reply to a forge discussion is a draft too: a GitLab draft note with
`in_reply_to_discussion_id`, or `addPullRequestReviewThreadReply` with the
pending review's id on GitHub (checked to stay in that review). The review
code has no call that publishes: no note or comment POST, no resolve, no
submit (`forge-writes.test.ts` checks its sources).

`mr-reviews/curation.ts`: after an inbox refresh, at most every 20
minutes and one at a time, the followed projects' open requests not yet
ranked at their `updatedAt` (not the user's own, by the host's user name;
not dismissed) go to `claude -p --model opus --tools "" --safe-mode
--strict-mcp-config --no-session-persistence` (cwd the temp directory, no
Herdr variables) in batches of 25, with the user's signals: files and
directories of their commits over 180 days in each clone (by the clone's
own `user.email`), their unmerged branches' files, the requests they
reviewed and their authors, the `hints` setting, and the latest 30
feedback verdicts. The answer (JSON: key, pick, score, reason) is checked
against the batch's keys, at most 8 picks, each with a reason, and kept in
`ranked` with the head and title it stood on (`version`): a new comment
or pipeline does not rank it again, a push or a new title does; requests
not updated within `suggest_days` (30) are left out until they change.
Model choice, measured on two real batches of 25: Opus found 6
of the 8 requests overlapping the user's files with every pick grounded
(about $0.13 per batch, 15 s), Sonnet 4 of 8 with person-only picks
($0.06, 10-15 s), Haiku 5 of 8 with looser links ($0.005, 14-29 s).
A ranking saved before the head and title stamp holds while its
`updatedAt` matches; a pick of the reviews agent (`by: "agent"`) is never
ranked again by the curation.

`mr-reviews/agent.ts`: the reviews agent, a chat in the Reviews panel
(`bridge.mr_reviews.agent.get|send|unqueue|stop|reset`). It runs as Ranger's
Claude Code turns do (`assistant/claude-driver.ts`, which takes another
agent's tools and system prompt): one `claude -p` per question, resumed
from the chat's session, with Claude Code's own tools, MCP servers, skills
and hooks off and only the module's tools over a turn-scoped loopback MCP
server named `reviews` (`assistant/claude-mcp.ts`). It is not a pane
session; `claude_start_mode` does not apply. The session id and the chat
(the latest 120 messages) are kept in `<data>/mr-reviews/agent.json`, its
working folder is `<data>/mr-reviews/agent/claude`. A question sent while
it answers waits (at most 5); Stop drops the waiting ones; New chat starts
a new session.

Its tools (`mr-reviews/agent-tools.ts`): `known_requests` (the inbox, the
suggestions with their stored reason and score, the followed projects'
other open requests), `interest_signals` (the curation's signals),
`search_requests` (GitLab GraphQL `mergeRequests(search, labels,
authorUsername, updatedAfter, state)` per followed or named project, GitHub
`search`, plus a changed-path filter on the answers) and `request_files`
read; `suggest` (a pick in `ranked`, `by: "agent"`; a request found outside
the inbox's lists is kept in `found` for 14 days so the inbox shows it),
`feedback` (the inbox's x / +), `set_hints` (the `hints` setting) and
`open_review` (the browser that asked opens it through the panel's own
flow) only change the user's own lists, settings or screen. `reviews_list`
reads the list as the user sees it (position overall and in the section,
section, state, pipeline, unread, score and reason, pinned, plus the removed
ones, and the order version). `reviews_order {keys, place: top|bottom|
before|after|exact, target?}` applies an order operation as `agent` (keys
are inbox keys, references or URLs; unknown ones are reported, never fail the
call) and `reviews_sort {by: score|updated|project|unread, section?}` sets the
order once from a sort; `reviews_pin|unpin|hide|unhide` call the panel's own
RPCs with `by: "agent"`. All of them change the shared, pushed order, so a
move is on every device at once and carries the summary for the toast. Forge access is
read only: each query is built by `agent-search.ts` as one GraphQL `query`
(model-given values JSON-quoted, dates checked), sent through the forge
gate as feature `reviews-agent`, an identical one shared for 2 minutes, at
most 12 calls per question; no tool drafts, comments, resolves or
publishes. Forge text in tool results is marked as data, and the system
prompt keeps the writing tools to what the user's own message asks.
The voice router and front route "ask the reviews agent..." and questions
about requests to review to `{"to": "reviews"}`, which the page sends to
the agent and tells the answer of.
Model choice, measured on the live inbox's requests with a fake forge (four
questions: new on GES or RTP, touching validate, why a suggestion, merged
lately; two runs each): Opus cited every expected request with nothing off
topic (median 10 s, about $0.07 a question), Sonnet as accurate but slower
(14 s, $0.035), Haiku missed 2 of 24 and cited one off-topic request (9 s,
$0.002).

## Conversation mode

A Claude session can be driven by a long-lived headless `claude -p
--resume <id>` (stream-json both ways, partial messages, replayed user
messages, permissions over stdio, `--prompt-suggestions true`) instead of
the TUI in its pane. Claude Code sends a `prompt_suggestion` after a turn
only when the user's own setting allows it (`promptSuggestionEnabled`, or
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`); the bridge keeps the last one while
nothing runs and drops it when a turn starts (`next_prompt` in the state and
events), and the browser only ever puts it in the box. The pane's
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
where the last one ended, so each line is read once. A chunk holds whole
lines, or a piece of a line longer than a chunk (a tool result with
screenshots), cut between characters; the bridge puts the pieces back
together, so no line is too long to send. The review socket takes up to
1 MiB from an agent and 64 MiB for `hold_output`. The bridge's commands
(`start`, `input`, `end`, `kill`) ride the `hold` long poll's answers,
numbered: the holder applies each once, in order, and reports the last one
applied with every poll; unconfirmed ones are sent again. A user message the child never got (the
holder dropped it, or it was still unconfirmed when the child exited) goes
back to the front of the queue for the next child instead of counting as a
turn cut short. Like the terminal's claude, the child is never closed for
being idle: it runs until the session is handed back, the user stops it,
or the pane closes. The child's environment is the
pane's minus outer Claude Code and Herdr variables, plus
`ROAMGATE_HEADLESS=1`, so the user's hooks run and Roamgate's own
permission hooks step aside. The pane id and Herdr socket stay available
as `ROAMGATE_PANE_ID` and `ROAMGATE_HERDR_SOCKET_PATH`, which Herdr's hook
does not read: the review client reports them, so comments in a review
the agent opens reach its pane, as conversation messages. `ANTHROPIC_API_KEY` is kept only as Claude
Code's TUI would: `claude -p` uses the key without asking, while the TUI
asks once and files the answer in `customApiKeyResponses` of its global
config (`~/.claude.json`, or in `$CLAUDE_CONFIG_DIR`), by the key's last 20
characters. The holder reads that answer on the pane's host and reports
only its state with each poll (`api_key`: none, approved, rejected, new);
the key never leaves the host. With no answer, the bridge holds the start,
the chat asks (`agent_chat.api_key_question`, answered with
`agent_chat.api_key.answer`) while messages queue, and the next `start`
command carries the answer: the holder adds it to that list under Claude
Code's own lock (`<config>.lock`), rewriting the config atomically and
leaving the rest of it as it was, then keeps or drops the key. An answer
given in a terminal meanwhile shows in the holder's next poll and settles
the question. `ANTHROPIC_AUTH_TOKEN` is kept: Claude Code uses it without
asking in both modes. A session's agent profile (server/src/profiles,
[Agent profiles](DEPLOYMENT.md#agent-profiles)) changes the `start`
command: its program replaces `claude`, its variables join `set` and its
removals come as `unset`, applied after the API key policy (a profile with
its own token never sends the pane's key). Secret values are read from
their files on the bridge's machine at each start and travel only in that
command (kept, like any unconfirmed command, in the lease file, mode 0600,
until the holder confirms it). The hand-back's `resume` answer carries the
same program and environment (`env`, `unset`, `agent`). What is typed
into a bare shell for a profile is `roamgate-hold --launch <token>`: the
holder posts `launch` with its pane, gets the argv and environment the
bridge registered for that pane (one use, two minutes) and execs it, with
`--session-id` instead of `--resume` for a Claude session with no
transcript yet. It stays in the
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
mode, if any), idle by its Claude mod's exact status when one runs, else by
Herdr's; both are checked again a moment later, just before `/exit` is
typed, so a paste or a turn starting then refuses instead. An `/exit` the
TUI takes as a message anyway (its transcript has it as a user message, or
the mod sees a turn start) refuses at once and leaves nothing pending; an
`/exit` with no effect by the deadline is watched a while longer, during
which a new switch is refused unless the user cancels it
(`agent_chat.handover.cancel`) or the exit turns out swallowed. Once it
exits, it waits for Claude's pid to end and the shell
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
shell it left. A runtime tells a polling holder to resume only for a pane
it knows: a lease it holds, or one it dropped in the last ten minutes (the
holder missed that reply). Any other holder (another Roamgate bound to the
same host socket, say) is held, so a bridge with other leases never ends
another's process.

A hand-back can also stop the conversation as a job of the pane's shell
(the chat's Ctrl+Z: `agent_chat.handover` with `suspend` and the
conversation's title). It takes the usual checks, and a holder that said
with its polls that it can stop (`job_control`: it is its own process group
in the terminal's foreground, under a shell with job control; never on
Windows, never an older holder); the headless process ends as for a
hand-back, Herdr's agent is released, the lease goes, and the holder's
answer is `suspend` with the session's id, directory, flags and title. The
holder ends its child, restores the terminal, says what stopped, and stops
itself with SIGTSTP: the shell reports a stopped job and prints its prompt,
and no Claude runs. The bridge keeps only what the browsers are shown
(`conversation-suspended.json` beside the lease file: pane, session,
title, the holder's pid and the session id its job's command line names),
laid over Herdr's panes as `suspended_conversation`, dropped once the pane
closes or the holder's pid is gone (`kill %1`). The holder keeps the rest
itself. `fg` continues it (a `bg` stops it again: it only holds the pane
from the foreground), and it runs itself again with that state (`--fg`):
a new log, then a `fg` request with the session's id, directory, flags and
its poll status. The bridge takes the session back into conversation mode
only if nothing else writes it (no lease, no other writer in Herdr's panes
or on the host, no headless process on it), sets the lease, reads the new
holder's channel and starts a process resuming the same session; refused,
the holder says why and stops again, so `fg` can retry. Since the stopped
job is an ordinary one, the shell's own jobs keep their order: plain `fg`
takes the shell's current job, which is the conversation only when it was
stopped last. The page's fg (`agent_chat.fg`: the terminal's banner, the
toolbar's switch) types `fg '%?<session id>'` (by pid in fish) into the
pane, and only while its shell is at the prompt, so it never takes another
job.

The headless process runs with the flags the TUI ran with too, and a
session with no transcript yet (a claude started and taken before its first
message) is started with `--session-id <id>` instead of `--resume`, by the
holder and by the claude it becomes. That claude, and the one typed into a
bare shell, run with `ROAMGATE_CLAUDE_START=terminal`.
With `claude_start_mode` set to `conversation`, the `SessionStart` hook
`roamgate-review claude-start` (added to the host's Claude settings by the
bridge) posts `claude_start` with the pane and session of a claude started
or resumed by hand; the runtime then tries the same takeover, again while
Claude is still starting (two minutes) or busy with a prompt it was given
(thirty minutes), and gives up on anything else (a draft, another session,
another writer). A pane whose lease went in the last minute is not taken.

A headless process starts only while the lease says `conversation`, a holder
that holds the session polls from the pane, no claude runs in the pane, no
earlier headless process runs on the session, and no other writer does:
neither a pane Herdr maps to the session nor an interactive
`claude --resume <id>` on the host. A pane where claude runs again (the
holder resumed it while Roamgate was away) gives the session back to the
terminal. So does a pane whose holder is gone (the host restarted and
Herdr restored the pane with claude or a shell) once no headless process
runs on the session; this is checked when a runtime reads its sessions
again, when a start finds no holder, when the terminal takes it back, on
each sweep, and every thirty seconds for a holder that stopped polling: the
turn its process showed (a question waiting, say) ended with it. Messages sent
meanwhile wait aside, never typed into the terminal, until the user switches
the session to conversation mode again (the usual handover); the new
process sends them. Nothing takes the session over by itself. A pane that
closes takes its lease and process with it; leases are also swept when a
tab or workspace closes and when the event subscription comes back. In a
held pane Herdr sees the holder and, at most,
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
reads on from where the runtime before had handled its latest child's lines:
saved with that position on the lease (about once a second, and when the
runtime goes) is the state those lines left (the turn, its tools and tasks,
the reply so far, the prompts not answered, the stream parser's place), so
only the lines after it are read, and they are live. Without such a save
(another child since, another holder, a log shorter than the position, a
state too large to keep) it reads the log again from the latest child's
start: the lines the runtime before had read rebuild the turn's state
without reaching the browsers again. At most eight conversations are read
again at once. Either way, nothing acts on the
session (a hand-back, the queue) before every line that was in the log at
that point is handled; then the permission prompts and questions still open
are asked again, once, and the rest is live. A note of a write this runtime
did not make (a message an earlier one sent, an answer it gave) marks the
turn as running or withdraws the prompt asked again. A read that times out
retries on the holder's next poll; reading a long log only times out when
it stalls. A child that ended while nobody read is read to
its end; only one that died in the middle of a turn (or a holder that no
longer runs one) marks the turn as cut short. Then the carried queue is
sent. A holder that runs but whose child cannot be read (its log does not
come through) marks the session lost (`lost` in the state and events): the
chat says so, with Recover (`agent_chat.recover`), instead of an idle chat
whose queue never goes. Recover asks the holder to end its child, reads the
log on from its end, and resumes the session in a new child with the queue;
a holder that is gone hands the session to the terminal, as above. With several local connections, a
holder is served only by the connection whose Herdr socket it names.

Browsers call connection-scoped `agent_chat.*` methods (`state`,
`subscribe`, `unsubscribe`, `send`, `voice`, `interrupt`, `rewind`,
`rewind.check`, `queue.edit`, `queue.remove`, `handover`, `shell`,
`shell.stop`, `interrupted.dismiss`, `recover`) and receive `agent_chat.<type>` events for the
panes they subscribed to (`shared/agentChat.ts`). Text deltas are coalesced
to about a frame and keyed by API message id and block index, which history
entries carry as `message_id` and `block_index`. Messages typed during a
turn wait in the bridge's queue; speech interrupts a turn that is only
writing text, steers one that runs a tool, and "stop" interrupts.
Permissions and questions use the review prompts, marked as having no
terminal to fall back on; unanswered, they are denied. A message sent twice
with one id is taken once.

`shell` runs a `!` line (`shared/bashMode.ts`) as Claude Code's bash mode
does, as the user's own command: `conversation/shell.ts` starts the user's
login shell (`-l -c`) in the lease's cwd, locally or over SSH in the
interactive lane, under a POSIX wrapper that ends the command's job when
its stdin closes (Stop, or a dropped connection). `shell` events stream its
output (each stream kept to a bound) and end state, and `shells` in the
state lists those Claude has not read. The next message written to the
child starts with them, in Claude Code's format: a `<bash-input>` text
block, then `<bash-stdout>`/`<bash-stderr>` (HTML-escaped, each cut at
30,000 characters with `... [N lines truncated] ...`), so running one
starts no turn. The history projection shows these blocks, and the
terminal's own bash-mode records, as command entries (`shell`), not as the
user's words.

`rewind` asks the running headless child itself, between turns, over its
control protocol: `rewind_files` (a dry run first, then for real) restores
the code from Claude Code's file checkpoints, which the child keeps
(`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, off by default in print mode;
a child started without it is ended and another started before the code is
restored, only when there is code to restore), and `rewind_conversation` cuts the conversation before the
message, with the latest user message the browser shows as
`last_seen_user_message_uuid`, so a later turn it has not shown is never
cut. Claude Code records the cut at once (a `last-prompt` record marked
`rewound`, naming the message cut): the next message hangs from before it,
a later `--resume`, in a new child or the terminal, goes on from there, and
the history projection drops the cut message and all that came of it. The
history shows only the current branch: the user's own messages among what
was cut stay as one `injected` notice of kind `rewound` where they were,
with their texts in `rewound` (`server/src/agent/session-rewind.ts`
`keptRecords`), and a cut prompt still answers its queue dequeue, so no
message of the abandoned branch shows as queued (a rewind record also
empties the projection's queue: Claude Code rewinds with nothing queued).
The session emits `agent_chat.rewound` on success: every browser drops
the live turn it streamed and the messages it still showed on their way
out of the queue. Live items otherwise wait for the transcript from the
end of their own turn, whatever turns follow. The
child, lease and holder stay. A rewind is refused while a turn runs (unless
the browser asked to interrupt it first), while a prompt waits or messages
are queued; while it runs, what is sent waits in the queue and no hand-back
starts.

`/model` also goes over the child's control protocol, never as a turn.
`agent_chat.models` asks the running child `list_models` (Claude Code's own
picker rows: aliases, the default, a gateway's custom slots, with the model
id each stands for) briefly, and adds the models the session's profile
offers that no row covers (`profileModels`: a gateway's `/v1/models`, else
Claude's aliases); nothing is started for it. `agent_chat.model` (and a
`/model <name>` sent as a message) starts the child if none runs and sends
`set_model`, which applies from the next turn and answers the model id it
runs then, or Claude Code's refusal. A switch writes nothing to the
transcript, and `--resume` takes the model the session last answered with,
so the choice is kept in `session-profiles.json` (`model`, with when and
the id it resolved to) and every start passes it as `--model` until the
transcript shows an answer with it (`chosenModelAnswered`, read when the
profile chip refreshes); a `--model` in the lease's `terminal_args` is
dropped. The outcome is `model_notice` in the state, said after the chat's
last entry until the next message, a dismiss, or a profile restart.

`agent_profile.get` also answers `model`, the model the pane's session runs
now (`runningModel`), the surest source first: the model conversation
mode's running process last named (its `init`, a `set_model` answer, or an
answer's `message.model`, so a fallback shows) or a terminal's Claude
mod reported (its status line's), a choice not answered with
yet, the transcript's last answer, the profile's `ANTHROPIC_MODEL`. For a
pane of another agent it is the model its transcript last names
(`latestTranscriptModel`: a Pi `model_change` or answer, a Codex
`turn_context`). The chat header's model chip and the terminal's profile
chip show it short (`shortModelName`: "Opus 5.5"), their titles the mod's
context and plan usage too, refreshed with the profile chip and at once on
a `model_notice`.

What the code of a rewind comes to is read from the transcript
(`server/src/conversation/rewind-scan.ts`): the files edited after the
message with Claude's file tools (Edit, Write, MultiEdit, NotebookEdit),
and whether Claude Code took a checkpoint for it (a `file-history-snapshot`
record naming it). Commands' side effects are not known. `rewind.check`
answers from that alone, for any Claude pane, so the browser can turn the
code choices off before the user picks: `none` when nothing was edited,
`no_checkpoint` (with the files) when edits predate checkpoints. A rewind
asked with the code anyway, together with the dry run, cuts the
conversation alone and answers `code: "none"` when nothing was edited, and
is refused with `no_checkpoint` (nothing rewound) when edits have no
checkpoint; the browser then offers to rewind the conversation only.

In the browser, the mode decides the view, never the other way round: one
view per mode. A Claude pane in terminal mode shows its terminal only, and
in conversation mode its chat only (from `to_conversation` on, and the
terminal again from `to_terminal`); the last mode seen is kept per pane and
shown until the bridge answers. Only the user moves a session:
**Switch to conversation mode** (the terminal's toolbar, the History
inspector, the pane's shortcut, or a phone's Chat) asks for `handover` to
conversation mode at once when Claude is not busy, and otherwise waits for
the turn to end, then for background work the bridge reports
(`waiting: "background_tasks"`, asked again 5 s later, then each time twice
as late, up to a minute), until cancelled; **Open in terminal** in the
chat's header (on a phone, **Terminal** in More options) asks for it back.
A refusal is shown on the terminal or, as text until put away, in the
chat's header, which has no mode label while conversation mode simply holds
the session. A takeover refused for another writer in a pane of the same
Herdr carries `writer`: the pane, its workspace and tab (ids, and names as
the sidebar gives them), the agent's name, and its status (`idle` when
Herdr says idle or done, else `working`, `blocked` or `unknown`). The
terminal's strip names that pane as the sidebar does (the browser's own
names first, then the bridge's, plus the connection when it is not local),
offers to show it, and for an idle one asks `handover` again with
`quit_writer: <pane>`. Only when the other writer found is that pane and
idle, and once this pane passed its own checks, the bridge exits that
Claude as a takeover would (idle, nothing typed, no background work, the
same session; `/exit`, its shell back in the foreground), leaves its pane
and shell, never types a resume there should it exit late, and checks this
pane again from the start. A pane Herdr still maps to the session with no
agent and its shell at its prompt is not a writer. The bridge refuses a
request marked `auto` (an older page
following its view). Agents without conversation mode, and a Claude where
the bridge has none (an older bridge, a Windows host), keep the view chosen
for the pane, the chat over the terminal included. Keys typed in a
browser's terminal are refused while a handover runs, as pane input is.
While conversation mode
holds the session, the browser neither types into nor reads the pane's
terminal. The streamed blocks render after the transcript's entries and
leave once an entry with the same message id and block index (tools: tool
use id; user messages: uuid) arrives.

`agent_history.subscribe` pushes `agent_history.changed` when a pane's
session file changes, for every agent kind; the browser then fetches its
delta with `agent_history.get`, and polls every 30 seconds in case a push
is lost (every 4 seconds from a bridge that cannot push). Local files are
watched; an SSH connection runs one stat loop for all its watched files.

Conversation mode's core (`server/src/conversation`: session, service,
handover, holder) is the same for every agent; it reaches the agent only
through a driver pair in `server/src/conversation/drivers` (`types.ts`). The
protocol driver says what the holder runs (`startCommand`), turns each line
of the process into normalized events and encodes messages, interrupts,
prompt answers and the agent's own requests (`createCodec`, its state saved
with the lease), says what the holder notes of a written line (`inputKind`)
and reads a dropped message back (`parseWrittenMessage`), and may rewind.
The terminal driver recognizes the TUI, keeps its flags, reads its screen
before an exit (`readiness`, the exit dialog, background work), exits it
and resumes it (`resumeArgv`), and probes the host for the headless process
and for other interactive writers. Claude Code is the only driver
(`claude.ts`, `claude-stream.ts`, `claude-env.ts`, `claude-rewind.ts`,
`claude-tui.ts`); a lease without `agent` is Claude's. `agent_chat` state
carries the lease's `agent` and its `capabilities` (steer, questions,
"always", rewind, prompt suggestions, `!` lines, background tasks, images
inline or by path, slash commands); the browser gates conversation mode on
`isConversationAgent` and hides what the capabilities leave out, reading a
state without them (an older bridge) as Claude's. The holder's resume reply
carries the TUI's whole `argv`, and `args` (Claude's arguments alone) for a
holder from before drivers, which always runs `claude`.

### Idle stop

`conversation.idle_stop_minutes` (default 30, 0 off) stops idle headless
processes (server/src/conversation/idle-stop.ts). The service checks its
sessions once a minute against the rules in `idleStopRefusal`: a process
runs, the lease is in the conversation phase with no handover, the status
is idle with nothing busy (no turn, prompt, rewind or delivery), no queue,
no background task, no `!` line, no API key question, nothing keeping it
awake (an open voice socket or one used in the last 10 minutes, a voice
companion job on the pane: `conversationKeepAwake` in index.ts), no peer
message in the last 10 minutes, and nothing from the process for the
setting's minutes (`ConversationSession.idleSince`: the last output or the
last turn written). `ConversationSession.sleep` then closes the process's
stdin as a stop does, without the hand-back flag: the holder stays, and the
lease records `asleep_at` (state `asleep`, event `agent_chat.asleep`). The
next delivery (any path: `send`, `prompt`, `voice`) starts a process again
through the usual guarded spawn; while it starts the status is `starting`
with activity `waking` ("Waking Claude..."), and a message written while
the stop runs waits for that process to exit, then starts the next. Peer
messages are Roamgate's own (`prompt(..., { peer: true })`, the agent
messages API) and Claude Code's: a stream line of a user message carrying
`<cross-session-message`, `<teammate-message` or a peer origin.

Claude Code's own `SendMessage` cannot reach a stopped session, and
Roamgate does not stand in for it. Each Claude Code process registers
`~/.claude/sessions/<pid>.json` (pid, process start time, session id,
`peerProtocol`, `messagingSocketPath`) with a key file, and listens on
`$TMPDIR/cc-socks/<pid>.sock` (or `/tmp/cc-socks-<uid>/`); peers find it
there, address it as `uds:<socket path>`, check the pid and its start time
against the registry, and verify the connecting pid on the socket
(`LOCAL_PEERPID`/`SO_PEERCRED`). The process removes its entry on exit, so
a stopped session leaves `ListAgents`, and a send to its old address fails
at the sender. A stand-in would have to hold a socket and a registry entry
for a pid it does not own, speak an undocumented, authenticated protocol
(frames, receipts, idle subscriptions, hop chains) and keep an address that
changes anyway when the woken process gets a new pid: not safe. Sessions
that got such a message in the last 10 minutes are left running instead.

## Usage limit resume

server/src/limit-resume resumes the Claude sessions a usage limit stopped,
once it resets ([settings](DEPLOYMENT.md#resuming-after-a-usage-limit)).

- **Detection** (`usageLimitStop` in shared/limitResume.ts): the session's
  transcript tail (64 KiB, `transcriptTail`, local or over SSH) ends on a
  usage-limit stop when its last conversation turn is an assistant record
  with `isApiErrorMessage`, `apiError: "usage_limit_reached"` or
  `error: "rate_limit"`, and a `rate_limit_info` (in `apiErrorParams`, else
  `quotaLimits`) whose `status` is `rejected` with a `resetsAt` (unix
  seconds). The message's words are never read. Turns are user and
  assistant records that are not meta, not a subagent's (`isSidechain`) and
  not a local command (`<command-name>`, `<local-command-...>`); Claude
  Code's bookkeeping (`last-prompt`, `cost-state`, `tools-used`,
  `queue-operation`, `api-request-blob`, snapshots, system records) is
  skipped, so a user message after the stop means it is not paused. Every
  `rateLimitType` (`five_hour`, `seven_day`, ...) is handled alike.
  Conversation mode's headless claude writes the same record to the same
  transcript; its stream-json carries it too (`api_error`,
  `api_error_params`, plus a `rate_limit_event` and a `result` with
  `terminal_reason: "api_error"`), which `usageLimitStopOf` also reads.
- **Sessions** (`limitConnection`, connection.ts): per ready connection
  (Windows hosts excepted), Herdr's `agent.list` Claude panes with a
  session id, and conversation mode's `ownedPanes()` in the conversation
  phase (asleep sessions are idle there). Herdr's status is not trusted to
  say a session stopped: every Claude pane's tail is read, again when its
  session or status changes and at least every 5 minutes.
- **Scheduling** (`createLimitResumer`, scheduler.ts): each connection is
  scanned every minute, and shortly after a pane's agent status changes
  (`pane.agent_status_changed` events, conversation mode's own reports) or
  the settings change. A pause gets one timer at `resetsAt` +
  `margin_seconds`. When it fires, the pane is read again: still the same
  session, still ending on a stop with the same reset, not held by **Don't
  resume**, the setting on, and the agent not `working` or `blocked`
  (else tried again in 30 s). A pause's state is `scheduled`, `off`,
  `skipped`, `missed`, `resuming`, `resumed` or `failed`.
- **Delivery** (`promptPaneAgent`, as review comments): conversation mode's
  `prompt` (its queue; a sleeping process wakes), else the terminal Claude's
  mod when it runs one (its status is then the mod's too), else Herdr's
  `agent.prompt` into the terminal's Claude. A failed send is tried again
  30 s later, five times per reset. "Resume now" sends at once (refused
  only while the agent asks something); before the reset it does not count
  as the reset's resume.
- **Persistence** (`limit-resume.json`, store.ts, by session id): `seen`,
  the reset of a pause seen before its resume time; `resumed`, the reset a
  resume was sent for (one per reset: a session stopped again on it is
  `resumed`, never sent twice); `skip`. After a restart the scan finds the
  pauses again; a due pause is sent at once only when `seen` matches and
  it is less than a day late, else it is `missed` (only "Resume now").
- **Browsers**: `limit_resume.list` (per connection), the
  `roamgate.limit_pauses` push (a connection's whole list, on each change),
  `limit_resume.resume_now` and `limit_resume.skip` (`pane_id`, `skip`);
  settings through `settings.limit_resume.get`/`update`. Ranger's
  `workspace_status` adds `usage_limit` to a paused pane.

## Voice helper

The bridge runs the voice helper (`voice/helper`) as a child process and
talks to it in frames (`voice/helper/src/frames.rs`,
`server/src/voice/voice-helper.ts`): a little-endian u32 length, a kind
byte (0 for JSON, 1 for a listening session's audio), then the payload,
16 MiB at most. The helper keeps its stdout for frames alone; whatever it
or a library prints goes to its stderr. A length of 0 or past 16 MiB, or
another kind, is output that is not frames: the bridge logs its first 200
bytes, escaped, and restarts the helper at once.

Each listening session lives in one helper process. When that process
stops, each of its sessions gets an `error` event with its `session` and
`recoverable: true`, and is over: the voice socket passes it on and drops
the session (never finishing it in another process), and the page ends
that listening with what it heard so far and listens again on the same
link. An `error` without a session (the channel's own), or one for the
listening that is not recoverable, fails the link; one for another
session is not this listening's.

The page streams its microphone on the voice socket as 16 kHz mono
S16LE, through a windowed-sinc low-pass from the browser's rate, so what
lies above 8 kHz does not fold back into the speech band. With a speaker
model, the helper tells the voices apart (voice/helper/src/voices.rs): what
the transcriber is fed is cut into stretches of voice (1.5 s at most),
each embedded by WeSpeaker on a thread of its own and placed among the
call's voices by cosine similarity (a new voice under 0.22, a voice's print
moved only by sure stretches, two voices whose prints reach 0.5 merged
under the older name). Each final carries `voice`: the set of voices
(`voices`, new with each `new_speaker` listening), the voice most heard
(`id`), its `share`, `mixed`, each voice's share (`mix`), the utterance's
`similarity` to each voice, the voices `merged` since, and the prints the
server keeps: the utterance's (`print`) and each of its voices' (`prints`),
unit WeSpeaker embeddings to four decimals. The server strips the prints
before the final goes to the page (the page sends the tag back with its
route, an `utterance` number standing for its print). The voice profiles
(voice-profiles.ts, one private file per person in `voice-profiles/` under
the data directory) are matched against each voice of the call by its
print: named when its closest kept print scores 0.60 or more with a 0.15
margin over the next person, "maybe" from 0.45 (calibrated in voices.rs'
`real_voices_are_known_again_on_another_call`). A profile learns only from
confident utterances (unmixed, 80% one voice, 0.45 close to it, a second
long): each call keeps one print per person, the mean of those, replaced
as the call goes and undone when the name is corrected; past six prints
the two closest merge. The server (voice-speakers.ts) takes the voice
matched to the user's profile for theirs; otherwise it learns which voice
is the user's from the routes of the turns (taken up or left to nobody)
and the front's `voice` verdict, and keeps it as their profile once sure.
The front names voices with `voice_name`, `voice_id` and `voice_role` in
its JSON. Each utterance is labelled for the front and the router (`Said
[Simon 0.84]: "..."`), the front also getting every score (`Voices:`), and
each listen_start sends `user_voice`: the user's voice on the call once
known, and their kept prints (a new call's start carries only those).
While the gate holds, an utterance then says nothing (no `speech_start`,
no partial words) until a stretch sounds like the user's: it went to their
voice, or scores 0.30 against it or one of their prints. With `drop_other_voices`,
the helper's listener also keeps one voice in speechgate: from the speaker's reference
recordings (`speaker_reference`), heard first in a session of their own
that is stopped at once, or else from the first 2 s of voice it hears
after a `new_speaker` listening (or after its first listening, when it
knows no voice yet). The helper logs which, so a voice taken from music or
someone else shows. speechgate says when it has taken a learnt voice
(its `speechgate-speaker-taken` message): a call's music waits, silent,
until then (below).

The listener's final is Parakeet's text, except when the helper also has
Whisper's model: a final that reads as English at least as much as in the
conversation's language (Lingua's confidence), when that language is
another one (the language of the last sentence spoken, or of the last
final), is heard by Whisper's language identification, on the audio the
transcriber got; when Whisper hears the conversation's language more than
English, its reading in that language is the final (`reread.rs`).
Parakeet drifts to English on some speech in other languages, never the
other way.

A sentence that makes no progress in time (SPEAK_STUCK_MS, SPEAK_COLD_MS
while a model loads) is checked with a `ping`. Answered within 2 s, the
speaker is stuck: the helper is restarted and the sentences that waited
are said with Kokoro. Not answered, the helper's output is not read: it is
restarted and they are said again as they were. A restarted helper makes
again the calls whose start it had answered, under their numbers; a call
it cannot make again ends (`call_ended`), and one that was stopped
meanwhile is stopped in it.

## Dictation

Dictation types what the user says into a text field, cleaned first: the
Android dictation app (a bubble over other apps) and the page's Dictate
buttons (`web/src/dictation.ts`, one `useDictation` in
`web/src/components/Dictation.tsx`: the message box's, every comment
editor's, and `FieldDictation`'s on any other focused text box without a
`data-dictation` attribute around it) use it. It is a mode of the voice
socket (`/api/voice/ws`, `server/src/http/voice-socket.ts`); the cleaner
is `server/src/voice/voice-dictation.ts`.

Client to server, JSON unless binary:

- `{"op": "warm", "mode": "dictation"}` starts the dictation cleaner's
  sessions ahead of the first dictation, answered `{"event": "warm",
  "mode": "dictation", "cleaner": true}` (false: no model, the words are
  typed as heard). Informational: each final says whether it was cleaned.
- `{"op": "listen", "mode": "dictation", "language": "fr", "field":
  {"app": "com.whatsapp", "app_label": "WhatsApp", "kind": "chat",
  "hint": "Message", "multi_line": true}, "before": "...", "after":
  "..."}` starts one. `kind` is one of `chat`, `email_body`,
  `email_subject`, `search`, `url`, `code`, `name`, `email_address`,
  `address`, `number`, `text`. `before` and `after` are the field's text
  around the cursor, kept to their last 1500 and first 500 characters.
  `"context": false` (an incognito field, an app kept private) drops the
  field and its text. Clients never dictate into password fields. During
  a voice call it is refused: `{"event": "error", "session": null,
  "error": "...", "busy": true}`.
- Binary messages are its audio, 16 kHz mono S16LE, at least every
  STALL_MS (5 s) until `finish`.
- `{"op": "finish"}` ends the dictation: pauses never do. The helper
  listens with its longest end silence (10 s); each utterance a pause
  ends there is kept and a new one starts at once, all of them one text.
  `{"op": "stop"}` cancels it: nothing is told.
- `{"op": "resume", "mode": "dictation", "session": 4, "resume":
  "token"}` resumes it on a new socket, as for voice chat (`resumed`,
  with the bytes received). An unknown, expired or wrongly tokened session
  answers `{"event": "error", "session": 4, "error": "unknown session",
  "recoverable": false}`.

Server to client: `{"event": "listening", "session": 4, "resume":
"token", "mode": "dictation"}`, `speech_start`, `{"event": "partial",
"session": 4, "text": "..."}` (the whole dictation's words as heard so
far, to show while the user speaks), and once, within
FINISH_DEADLINE_MS (15 s) of `finish` whatever the helper and the model
do, `{"event": "final", "session": 4, "text": "to type", "raw": "as
heard", "cleaned": true, "timing": {"stt_ms": 180, "clean_ms": 640}}`
(`stt_ms` from `finish` to the helper's last words, `clean_ms` the
cleaning's own). `cleaned` false gives the words as heard: no model, a
model that failed, took over 8 s, or whose reply is not a cleaning of
them (most of its words not said, or much longer). When nothing was
heard, the final is `{"event": "error", "session": 4, "error": "Nothing
was heard", "nothing_heard": true, "recoverable": false}` instead, for
the client to say so. A helper just started (or stopped after
`helper_idle_exit_minutes` and started again) loads its listening models
first, for seconds: `{"event": "loading", "session": 4, "mode":
"dictation"}` says so, then `{"event": "ready", ...}`. The audio that
comes meanwhile waits in the helper and is heard once they are loaded,
`finish` after it; a dictation finished while they load waits up to
LOADING_DEADLINE_MS (90 s) for them, then FINISH_DEADLINE_MS. A helper that stops
gives `{"event": "error", "session": 4, "recoverable": true}` at once. A
voice chat listening takes the helper from a dictation, which then ends
with a final of what it heard, not cleaned. Dictation has no `for_agent`:
a voice the helper doubts is still typed. The client spaces the text
around the cursor; the cleaner continues a sentence the text before the
cursor left open.

The cleaner is the voice cleaner's machinery (pieces cleaned while the
user speaks, the end at `finish`) with its own prompt: fillers, false
starts and self-corrections go, spoken punctuation and layout become
characters, numbers and addresses are written as typed, each word stays in
the language it was said in (never translated), and the field's kind sets
the format. The field's facts and text go before each request as quoted
data, which the prompt says never to follow. Its Claude Code sessions read
the companion's long-term memories (`companion-memories`) through
`autoMemoryDirectory`, never writing them, for the names the user says.
Nothing of a dictation is logged: with `ROAMGATE_VOICE_DEBUG`, timings and
sizes only.

`scripts/dictate-wav.ts` dictates an audio file through a running server,
for a corpus of dictations.

## Voice calls

A voice chat is a WebRTC call between the page and the voice helper
(`voice/helper/src/call.rs`, `server/src/http/voice-socket.ts`,
`web/src/webrtcCall.ts`). The voice socket (`/api/voice/ws`) controls it:
`{"op": "call_audio", "on": true}` makes the helper start the call, one at
a time, answered `{"event": "call_audio", "call": <id>, "resume":
<token>, "webrtc": true}`. The token belongs to the page that owns the
call: it moves the call to another socket (`call_resume`), and opens its
signalling. A call answered after the page's 5 s wait is ended at once
(`{"op": "call_audio", "on": false, "call": <id>}`, which ends that call
only), and the voice channel moves to its new sockets only a call the
page took. A link closing lets its call go and keeps its socket open until
the call ends there or a rebuilt chat's link takes it, so that the end
reaches the bridge.

The helper restarting makes the call again with a new signalling server
(`call_restarted`, with `restarts`, the count so far). The bridge closes
the call's signalling sockets, and the page opens them again. A page whose
socket was away meanwhile learns it from the `call_resume` answer, which
carries `restarts` too, and opens its signalling again. A call the helper
cannot make again ends: the bridge stops it, tells the page (`call_audio`
with an `error`), and refuses its signalling from then on.

While the listener learns a new speaker's voice from what it hears, the
call's music waits: its level stays at 0 (its source made when on), and it
fades in once the voice is taken. The helper tells it as `{"event":
"call_music", "call": <id>, "waiting": true}` at the call's start and on
each change; the bridge keeps it for the companion's state (the music is
on but waits, not playing) and passes it to the page, whose trace says
it. The call's `call_audio` answer and the `call_resume` answer carry
`waiting` too, and the page keeps what the helper says from before the
answer until the call is set up, so a change told before the page set the
call up, or while no socket held it, is not lost.

Signalling is GStreamer's WebRTC signalling protocol. The helper's
`webrtcsink` runs the call's signalling server, on 127.0.0.1 at a port
chosen per call; the page reaches it only through
`/api/voice/call/signalling?call=<id>&call_token=<token>`, which the
bridge accepts with the user's login, not from another site
(`Sec-Fetch-Site`), and for the current call's token only, and proxies
message by message. The parameter is not `token`, the generated login
token's (which only page openings use). A refused signalling is answered
403 before the upgrade, or closed 4004 when the call ended meanwhile;
with `ROAMGATE_VOICE_DEBUG` the bridge says why. The page uses
gstwebrtc-api.

Pairing never takes a producer by position. The helper's `webrtcsink`
registers as the producer with meta `{"call": <id>, "role": "replies"}`,
and the page consumes only that one. The page publishes its microphone as
a producer with meta `{"call": <id>, "role": "microphone"}` and tells its
peer id on the voice socket (`call_microphone`, from the owning socket
only); the helper points `webrtcsrc` at that id. A new id (the page's
signalling socket came back) makes `webrtcsrc` again. A `listen` with
`"call": <id>` hears the call's microphone instead of the socket's audio;
the helper reports how much came (`audio` events, 16 kHz mono S16LE
bytes), which times pauses and stalls on the server as the socket's audio
does, except that a stalled call microphone keeps the session on its
socket, which is alive: the page is told (`stalled`), ends the utterance
when the microphone's leg is down, and the bridge ends it 20 s later
otherwise. The listener keeps the 500 ms before a session starts, so a
word that overtakes the `listen` request is heard.

The microphone's leg comes back when the helper ends its session without
making a new one, or reports that its microphone failed (`call_error`):
the page publishes it again and tells its new peer id, five times within a
minute at most, listening on the socket after that. The helper does not
report as failures the errors its microphone pipeline posts while it is
replaced or stopped.

Media is Opus over UDP. The helper's ICE agents use the machine's IPv4
addresses and 127.0.0.1, ports 40000 to 40999, no STUN or TURN, no TCP.
The bridge rewrites the helper's host candidates on 127.0.0.1 to
`call_ice_address` on their way to the page: Tailscale's userspace
networking forwards UDP to the machine's Tailscale address to 127.0.0.1
on the same port. A leg whose ICE connection fails, or stays disconnected
4 s, gets a new session on the same signalling; a lost signalling socket
is opened again, with both legs. Media lost meanwhile is not sent again.
A signalling that never opened is tried six times (about 7 s, 15 s at
most): the page then ends the call (`call_audio` off), says so, and the
chat goes on without it, as with a helper that cannot make calls.

Replies asked for during the call (`POST /api/voice/speak` with `call`)
go into the mix and answer where they are in it (`start_ms`,
`duration_ms`) and where the mix was then (`now_ms`); the page times
their end from that, the playout's delay, the received jitter buffer, the
output's latency (`AudioContext.outputLatency`) and a 300 ms margin, and
only then releases the listener's hold; `call_hush` drops the voice still
queued. At each reply's end the page traces its level as received, the
microphone's level meanwhile and the browser's `echoReturnLoss` and
`echoReturnLossEnhancement` (`reply heard: ...`): how much of the reply
the echo canceller kept out of what the helper hears. In loudspeaker mode
(`web/src/webrtcCall.ts`, `CallMode`) the page opens the microphone with
none of the browser's processing and says `"echo": "here"` in
`call_microphone`; the helper then puts the microphone through
`voice/helper/src/echo.rs`: `webrtcdsp`, its far end the call's mix as it
goes to `webrtcsink`, copied in a probe into `webrtcechoprobe`, both pushed
on the helper's own pads with timestamps of one clock (the mix 60 ms
ahead of when it goes out, the microphone when it comes in). The helper also
holds the listener while the call's music is on and not silent, as during
a reply. The page sends sentences
into the mix only while it hears the replies' leg; otherwise, and with a
helper or a browser that cannot make the call, each sentence plays in the
page and the microphone streams on the voice socket, from the call's own
microphone (already open, its echo canceller settled). Once the call is
over, or its capture ended (a device gone), each listening opens a
capture of its own again and closes it at its end. A listening that
starts while the call is still being made goes on the socket at once,
rather than waiting for the call's answer. Publishing the microphone
again closes the producer before only after letting it go, so its
`closed` event, which gstwebrtc-api sends at once, is not taken for the
signalling ending it: only a close the page did not make publishes it
again.

### Calls carried by the Android app

Chrome on Android gives a page silence from its microphone once the
screen is off; the Roamgate Android app (`net.ts.roamgate`) keeps it in a
microphone foreground service. A call started in the web UI on a phone
that has the app is carried by the app (`web/src/androidApp.ts`,
`web/src/webrtcCall.ts`'s `handOff`, `server/src/http/voice-socket.ts`,
`server/src/http/call-handoff.ts`):

1. **Knowing the app.** The app's Trusted Web Activity opens the server at
   `/?roamgate_app=<versionCode>`; Chrome also gives such a page the
   referrer `android-app://net.ts.roamgate`. The page keeps that in
   localStorage (shared by the Trusted Web Activity and Chrome's tabs) and
   strips the parameter. Only an Android browser that noted the app offers
   a handoff; three handoffs in a row the app does not take forget it
   until its next launch.
2. **Handing off.** Once its call is set up, the page (the call's owner)
   sends `{"op": "call_handoff", "call": 7}` and gets `{"event":
   "call_handoff", "call": 7, "handoff": "<token>", "expires_ms":
   60000}`: 256 random bits, single use, valid 60 s and only while that
   call lasts; a newer one voids the one before. The page opens
   `intent://<host>/call/7?handoff=<token>#Intent;scheme=https;package=net.ts.roamgate;action=android.intent.action.VIEW;end`.
   The package is named, so only the app takes it; without the app
   nothing opens. The parameter is `handoff`, never `token` (URL login).
   A browser opening `/call/<id>` itself gets the web app, the parameter
   ignored. Should Chrome not open the app by itself (no user gesture
   left), the call's controls offer "Move to the Roamgate app".
   In the app's own WebView, which exposes the JavaScript bridge
   `window.RoamgateApp` with a `handOff` function, the app is taken as
   installed (no launch parameter or referrer needed): once the call is set
   up the page sends the same `call_handoff` and calls
   `window.RoamgateApp.handOff("7", "<token>")` with only the call id and
   the token, no intent URL and no "Move to the Roamgate app" button. A
   bridge that throws leaves the call in the page, which says so.
3. **Redeeming.** The app posts `{"handoff": "<token>"}` to `POST
   /api/voice/call/handoff`, before the login gate: the token is the
   credential. 200 answers `{"call": 7, "carrier": "<carrier token>"}`
   with a new login cookie (`herdr_auth`, as a password login gives); an
   unknown, used or expired token answers 410, ten failures from one
   address within 10 minutes 429, another site's request 403. A new
   carrier replaces the one before, which gets `call_audio` with an
   `error`.
4. **Carrying.** On its own `/api/voice/ws` the app sends `{"op":
   "call_carry", "call": 7, "carrier": "<carrier token>", "legs":
   ["microphone"]}` (legs: `microphone`, `replies`), answered `{"event":
   "call_carry", "call": 7, "ok": true, "legs": [...], "restarts": 0,
   "waiting": false, "replies_peer": "<peer id>"}`. `replies_peer` is the
   peer id of the helper's replies producer (meta `{"call": 7, "role":
   "replies"}`), null while it has not registered; a producer learned
   later, or a new one (a restarted helper's), is told on the carrying
   socket as `{"event": "call_replies_peer", "call": 7, "peer": "<peer
   id>"}`. The bridge learns it from the handoff on with a peer of its own
   on the call's signalling server: `setPeerStatus` with the `listener`
   role (meta `{"call": 7, "role": "roamgate"}`), `list`, then
   `peerStatusChanged`; it is opened again on a restarted helper's new
   server, or 1 s after its server closed. The carrier token opens the
   call's signalling (`call_token`) as the page's does, as many times as
   the app needs: its `webrtcsink` (microphone producer) and its
   `webrtcsrc` (replies consumer, `startSession` with `replies_peer`) each
   open their own socket, with the login cookie. Each signalling socket is
   proxied to its own connection to the helper's server, which implements
   the whole protocol (`setPeerStatus` with roles and meta, `list`,
   `startSession`, `endSession`, `peer` messages), so producer and consumer
   messages reach the right peer whichever socket they come on. The app
   publishes its microphone as `{"call": 7, "role": "microphone"}`, telling
   its peer id with `call_microphone` on the carrying socket (`"echo":
   "here"` when it plays nothing itself or cancels no echo); the helper's
   `webrtcsrc` consumes that producer by id.
   The page's own `call_microphone` is refused meanwhile. The carrying
   socket also gets `call_restarted`, `call_music` and the call's end, and
   may send `call_ice` (logged as the app's).
5. **The page meanwhile.** It is told `{"event": "call_carrier", "call":
   7, "state": "joined", "legs": [...], "heard": false}` (again with
   `heard: true` once the helper listens to the app's microphone, and on
   a `call_resume`). It closes its microphone and producer for a carried
   microphone, stops consuming and playing the replies for carried
   replies, and lets the screen wake lock go. It still runs the
   conversation: its listenings use `listen` with `call` and hear the
   app's microphone, and replies go into the mix (`POST
   /api/voice/speak` with `call`). The call's controls say "In the
   Roamgate app".
6. **Controls.** Hang-up from the page ends the call and tells the app
   (`call_audio` with `error`); the app's hang-up, `{"op": "call_audio",
   "on": false, "call": 7}` on the carrying socket, ends it and tells the
   page "Hung up in the Roamgate app". The app tells its outputs with
   `{"op": "call_output_state", "current": "speaker", "outputs": [{"id":
   "speaker", "kind": "speaker", "label": "Loudspeaker"}]}` (`kind` one
   of `speaker`, `earpiece`, `bluetooth`, `bluetooth-music`, `wired`,
   `usb`; 16 at most; `bluetooth-music`, `{"id": "music:<device>",
   "label": "<headset> (music)"}`, only while an A2DP or LE audio device
   is connected, plays the replies and the music on that headset's media
   profile at full quality, with the phone's microphone, the helper
   cancelling the echo as on the loudspeaker);
   the page shows them on its output button and sends a choice as
   `{"op": "call_output", "call": 7, "output": "<id>"}`, which the app
   gets as `{"event": "call_output", ...}`.
   Mute is the page's voice chat Mute (the companion still speaks,
   nothing is listened to), shared with the app. The page reports each
   change for its call as `{"op": "call_mute_state", "call": 7, "muted":
   true}` (from its socket owning the call; it starts unmuted), and the
   carrying socket gets each one as `{"event": "call_mute", "call": 7,
   "muted": true}`, plus once right after the `call_carry` answer with
   the state then. The app's Mute (its ongoing-call notification, or
   Android's: a Bluetooth headset, the car) is `{"op": "call_mute",
   "call": 7, "muted": false}` on the carrying socket; the page gets it
   as the same `call_mute` event and applies it as its own Mute button,
   then reports the new state, which the app gets back. A Mute the page
   already has changes and sends nothing; with no voice chat running it,
   the page reports its state again so the app shows what is. `muted`
   must be a boolean; ops for another call, an ended one, or from a
   socket that does not own or carry the call are ignored.
7. **Giving it back.** `{"op": "call_carry_end"}`, a newer carrier, an
   app that never sends `call_carry`, or a carrying socket gone for
   DETACHED_MS (20 s; `call_carry` again on a new socket within it keeps
   the call) tells the page `{"event": "call_carrier", "call": 7,
   "state": "left", "why": "..."}`: the app's signalling closes and the
   page opens its microphone and consumes the replies again. An app that
   has not joined 15 s after the handoff leaves the call in the page,
   which says so.

The app carries the microphone first: Android freezes a Chrome that
plays nothing in the background, and the conversation runs in the page,
so the page keeps playing the replies while the app holds the
microphone (the helper cancels their echo, `"echo": "here"`).

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

The control socket is reached through a relay the tunnel runs as its remote
command (`python3`, inline, see `server/src/bridge/herdr-relay.ts`). Herdr
reads a new control connection without blocking and sleeps 100 ms when the
request is not there yet; through a plain `-L` forward it never is, since sshd
connects when the channel opens and the request follows a round trip later.
The relay listens on `~/.cache/roamgate/herdr-relay-<token>.sock`, reads the
request line, then connects to Herdr and writes it, so calls answer in a few
milliseconds instead of 100. It prints a ready line before the tunnel counts as
ready and exits with the session. A host where it does not start (no
`python3`, ssh connected but the command failed) gets the direct forward for
the rest of the runtime; `ROAMGATE_DISABLE_HERDR_RELAY=1` always forwards
directly.
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

Each Unix-host SSH profile runtime owns two OpenSSH connections. Connection A is
the tunnel above and carries only Herdr's control and render sockets. Connection
B is a command master (`ssh -M -S <runtime dir>/m.ctl -N`) started alongside the
tunnel, kept across tunnel reconnects, and stopped before the runtime directory
is removed. Stopping sends `-O stop`, so new commands log in on their own, and
gives commands in flight over the master up to ten seconds before killing it.
A master that exits after it was ready is started again ten seconds
later, or at the next tunnel start if that comes first, each time it exits. A
master that never became ready is not retried before the next tunnel start.
`ROAMGATE_DISABLE_SSH_MASTER=1` turns connection B off; the legacy CLI
connection and Windows-host profiles never have one, and the Windows stdio
bridges keep one connection each outside the session limit.

Host commands built by `sshCommandArgv` (Git, files, search, worktrees, hooks,
uploads, the remote HOME probe) add `-S <socket>` while the master of a runtime
reaching that destination listens. `-S` overrides the fixed `ControlPath=none`,
which a later `-o ControlPath=` cannot, and `ControlMaster=no` keeps commands
clients: no user `ssh_config` socket is ever used, and OpenSSH itself falls back
to a cold login when the socket is missing, stale, or refuses a session. The
masters are registered per runtime, so stopping one profile never stops another
profile's master on the same host. The shared process helpers, file search
and uploads allow eight concurrent sessions per destination, multiplexed or
cold, below sshd's default `MaxSessions 10`. Further commands queue, at most 64
per destination; the wait counts against the command's own timeout (60 seconds
without one) and ends when an upload's request is aborted. A multiplexed
command that exits 255 after its master died (`-O check` fails) may still be
running remotely, so only read-only commands built with `sshReadCommandArgv`
and run through the process helpers (Git status, file listing and reads, agent
session reads, workspace path checks, the HOME probe) are rerun once cold. File search streams its
output itself and is not rerun. Every other command, including worktree, hook,
upload, write, delete, and Git actions, reports that failure instead of risking
a second run. A 255 from a live master is the remote command's status.

Commands run in one of two lanes. Interactive work, the default, is what the
user waits on. Background work (the Git status refresh, and requests the
browser marks background) holds at most five of the eight sessions, so three
always stay free for the user, and waits behind every queued interactive
command: a freed session goes to the oldest interactive waiter first. Its own
queue holds at most 64 commands; past that a background command is shed at
once. The RPC log treats that error as expected, a shed Git status read keeps
the previous status like any transport failure, and the next round asks again.


At startup, orphaned command masters are stopped only in private, user-owned
runtime directories whose recorded Roamgate owner process is gone. A failed
exit request retains the directory and socket for a later cleanup attempt.

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

| Endpoint               | Required header                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Updates                | `x-roamgate-update: 1` (legacy `x-herdr-gui-update: 1` is accepted; the new header wins) |
| Web Push subscriptions | `x-roamgate-push: 1`, JSON body                                                          |
| Instance settings      | `x-roamgate-settings`, JSON body                                                         |

Login bodies are limited to 16 KiB (`413`). Headers never replace login.
