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
  token valid only while the turn runs, read from a temporary mode-0600 config
  file rather than process arguments. MCP tool calls run serially. Interrupted
  Claude Code turns are stopped without replay and their CLI context is cleared,
  because a session pointer cannot prove whether an MCP operation completed.
  The user reviews action receipts before sending a new question.
  A chat that changes driver starts
  afresh, and input sent during a Claude Code turn waits as a follow-up.
- **Tools** are defined in `server/src/assistant/tools.ts` and run through
  `callWorkspaceTool` against the turn's approved scope. Pi's built-in tools,
  extensions, skills, and project instructions are disabled, and workspace
  evidence is treated as untrusted.
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
agents there use the existing login and no port listens. An agent signs with
a plain name, can edit only its own comments and cannot post on GitLab. The
user's discussion comments reach a review's agent as a prompt typed into its
Herdr pane (`agent.prompt`), a few seconds after they are written: a burst
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
session. Each delivery looks the session up (`agent.list`, with the panes
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
asking in both modes. It stays in the
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

## Voice helper

The bridge runs the voice helper (`voice/helper`) as a child process and
talks to it in frames (`voice/helper/src/frames.rs`,
`server/src/voice/voice-helper.ts`): a little-endian u32 length, a kind
byte (0 for JSON, 1 for a listening session's audio), then the payload,
16 MiB at most. A length of 0 or past 16 MiB, or another kind, is output
that is not frames: the bridge logs its first 200 bytes, escaped, and
restarts the helper at once.

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
model, the helper's listener keeps one voice: from the speaker's reference
recordings (`speaker_reference`), heard first in a session of their own
that is stopped at once, or else from the first 2 s of voice it hears
after a `new_speaker` listening (or after its first listening, when it
knows no voice yet). The helper logs which, so a voice taken from music or
someone else shows. The listener counts the voice the gate's speaker check
takes in, as the gate does, so it knows when a learnt voice is taken.

The listener's final is Parakeet's text, except when the helper also has
Whisper's model: a final that reads as English at least as much as in the
conversation's language (Lingua's confidence), when that language is
another one (the language of the last sentence spoken, or of the last
final), is heard by Whisper's language identification, on the audio the
transcriber got; when Whisper hears the conversation's language more than
English, its reading in that language is the final (`reread.rs`).
Parakeet drifts to English on some speech in other languages, never the
other way.

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
