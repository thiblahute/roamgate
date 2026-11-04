# Activity log

When enabled, the bridge records coarse, timestamped activity per connection:
which workspace (and pane) had the user's attention, from which device, and
what state the agents were in. It records nothing from terminals: no output,
no input, no keystrokes. Recording is off by default; see
[the settings](./DEPLOYMENT.md#activity-log).

The log is a local file, `activity.sqlite` in Roamgate's data directory
(`~/.config/roamgate`, `%APPDATA%\roamgate` on Windows). Events read back in the
shapes of [`activity.schema.json`](./activity.schema.json) (`$defs`: `Event`,
`EventKind`, `Workspace`, `Repo`, `AgentState`, `ActivityPage`,
`RecordingGap`, `Status`). Read it with the [timeline](#timeline) in the web
UI or with [`roamgate activity`](#command-line).

## What is recorded

- **Agent states** (`agent.state`), from Herdr's per-pane status events:
  `working`, `idle`, `blocked`, `unknown`. Herdr's `done` (finished, not yet
  seen) is recorded as `idle`. A state is recorded when it changes, not again
  while it holds. The bridge's periodic `pane.list` catches changes it missed;
  a listing never overrides an event newer than it. An agent whose pane closes
  or whose process ends goes to `unknown`, once; an agent never seen in a
  known state is not recorded. After a connection gap every agent's state is recorded
  again. `agent.session_id` is Herdr's session id (a session file's name for
  agents that keep sessions as files). `agent.task` is the session title, and
  only with `record_agent_titles`. A Claude that conversation mode runs in a
  pane is recorded in the state conversation mode knows (working only while
  a turn runs; background tasks alone leave it idle), never Herdr's: Herdr's
  Claude integration claims the pane when the headless claude starts, and
  Herdr's state for it no longer follows.
- **Attention spans** (`workspace.focus` and `workspace.blur`). Every focus
  gets a blur with a `reason`:
  - `switch`: another workspace or pane, another connection, or none;
  - `hidden`: the page was hidden or lost the focus;
  - `idle`: no input for `idle_seconds`;
  - `disconnect`: the browser's socket closed, or the connection stopped being
    ready;
  - `timeout`: no presence report for 150 seconds;
  - `recorder_stop`: the bridge stopped, or died (see below).

  A span still open when read has `open: true`. Only focus and blur events
  carry a `source`. Spans from browsers carry `source: "browser"` and the
  `client`. Herdr's own TUI focus is recorded too,
  as spans with `source: "herdr"` and no client: a low-confidence signal, since
  Herdr cannot tell whether anyone looks at its TUI. These change only with the
  focused workspace, and run whether or not anyone is attached.
- **The UI in front of the user** (`ui.visibility`): `visible` is true while a
  page is visible and has the focus (visible AND focused), per client.
- **Idle and back** (`session.idle`, `session.active`), per client.
  `session.idle` is dated at the threshold and carries `idle_after_seconds`.
- **Gaps**: the periods a connection was not ready, and those the recorder was
  not running (no connection), so that "nothing happened" can be told from "not
  recorded".

No heartbeat events are stored.

### Causes

`workspace.focus`, `workspace.blur`, `ui.visibility` and `session.active`
carry a `cause`, what made them happen, and `input_age_ms`, the page's input
age when it reported them (null when the page had no input since it loaded,
and on every event the recorder writes on its own).

| `cause`            | Meaning                                                                                          | Sign of a person |
| ------------------ | ------------------------------------------------------------------------------------------------ | ---------------- |
| `user_input`       | A key, pointer, wheel or touch in the page within 5 s before                                     | yes              |
| `user_focus`       | The page came to the front without input in it, after input since it loaded                      | yes              |
| `page_load`        | The page loaded or reloaded and has had no input since                                           | no               |
| `reconnect`        | The page's socket to the bridge is new (bridge restart, network drop) and no input came after it | no               |
| `follow_herdr`     | The page's view moved without input, following Herdr's focus (shared navigation)                 | no               |
| `app`              | The page's view moved without input, Roamgate itself moved it                                    | no               |
| `herdr_event`      | Herdr's focus event: someone at its TUI, or an agent through its CLI                             | yes              |
| `herdr_listing`    | Herdr's focus found changed in a listing, without an event (a browser focusing its pane)         | no               |
| `recorder_start`   | The focus Herdr had when the recorder started                                                    | no               |
| `connection_ready` | The focus Herdr had when the connection came (back) up                                           | no               |

Every `workspace.focus` has one: a browser span opens only with `user_input`
or `user_focus` (see [Presence](#presence)), a Herdr span with one of the
last four. A blur has the cause of the change that ended it when its reason is
`switch` or `hidden`, null otherwise (the reason says why). A `ui.visibility`
from a page's report has the report's cause; the `visible: false` ones the
recorder writes itself (timeout, disconnect, recorder stop) have none.
`session.active` is `user_input`. Agent states and `session.idle` have none.

Rows written before causes were recorded have none. Readers (the timeline,
`roamgate activity`, the time report's DayInput) give the ones written within
10 seconds of their recorder session's start the cause of that start: a browser
focus or a visible `ui.visibility` reads as `reconnect`, a Herdr focus as
`recorder_start`. The log itself is not rewritten.

## Ids and ordering

Event ids are a zero-padded sequence, never reused: they are the order of the
log, and resume cursors are ids, never times. A `ts` is not monotonic in id
order: a `timeout` blur is dated at the last presence report, and an `idle`
blur and `session.idle` at the last input plus `idle_seconds`, so a later id
can carry an earlier `ts`. Place spans by `ts`; use ids for order and ties.

Gaps read back as `RecordingGap`: `connection_id` null when the whole recorder
was down, `end` null while the gap is open. `excluded` is never set in the log,
which records excluded connections as usual; it is for exports to other
tools.

## Presence

Each open page reports to its connection with the `activity.presence` RPC:

```json
{
  "client_id": "4b0f9c6e-...",
  "client_kind": "desktop",
  "workspace_id": "w2",
  "tab_id": "w2:t1",
  "pane_id": "w2:p1",
  "visible": true,
  "focused": true,
  "input_age_ms": 12000,
  "cause": "user_input"
}
```

`client_id` is a random id the browser keeps in local storage; `client_kind`
is `phone` on mobile browsers, else `desktop`. `pane_id` is null on a phone
showing another view than the pane. `input_age_ms` is how long ago the last key,
pointer, wheel or touch event was, never what it was, and null until the page
has had one since it loaded; bringing the page to the front counts as input
once it has. `cause` is why the page reports: `user_input`, `user_focus`,
`page_load` (no input since it loaded), `follow_herdr` or `app` (its view moved
without input), or `repeat` (the minute report, the idle threshold). The reply
is `{"recording": bool, "idle_seconds": int, "attention": bool}`; a page stops
reporting once `recording` is false, and reports its next input at once when
`attention` is false.

Only a person opens a span. The bridge counts a page's input only when it came
after the page's first report on its socket (a load, a reload, or a reconnect
to a restarted bridge) and after its view last moved without input: until
then the page's reports are recorded as `ui.visibility` with that cause, and
open nothing. A view that moves without input ends the running span (`switch`
with the cause `follow_herdr` or `app`) and opens none until the next input.

A page reports each change of where it looks, of visibility and focus, the
moment it becomes idle, and input after idle. While it is visible, focused and
not idle, it reports again every 60 seconds. The bridge stamps every report
with its own clock. Reading (visible and focused, no input) counts as attention
until `idle_seconds`. A span whose reports stop ends with `timeout` 150 seconds
after the last one, dated at that last report.

## Workspaces

`workspace_id` in events is a stable key: a hash of the connection and the
workspace's checkout path, so it survives Herdr restarts (Herdr's ids do not).
The path is Herdr's worktree checkout, else the directory of the workspace's
first pane when first seen; a workspace with neither is keyed by its name.
Workspaces sharing a path share the key. Each workspace keeps its name, path,
repository, and Herdr's current id as `herdr_workspace_id`. The repository
(`repo`) is read with git on the connection's host, read-only, when the
workspace is listed and again every 10 minutes: `root` (a linked worktree's
main checkout), `is_worktree`, the `branch` checked out (null when detached) and
`remote_url`, the URL of the branch's remote (else `origin`, else the first
remote) with any user name and password of an http(s) URL left out.

## Subjects

A workspace's `subject` is the user's grouping of it, by folder only, never by
repository (a worktree is not grouped with its main checkout):

1. **A group of the Workspaces tree** (`source: "explicit"`): the group nodes
   above the workspace's node, top first. A workspace nested under another
   workspace is not in a group by that. Ids are `tree:` and the group node's id,
   so they survive renames.
2. **Else a folder under a root** (`source: "directory"`): the first directory
   level under an `activity.subject_roots` entry, so with the root
   `~/devel/clients`, `~/devel/clients/sequence/cps-184` belongs to `sequence`,
   with the groups `clients` and `sequence`. A root under `~` matches that
   folder in any user's home, on every connection. The deepest root wins. Ids
   are `dir:`, the root as configured, `/` and the folder.

`label` is the nearest group and `groups` the chain from the top-level one.
Subjects are computed when the log is read, so a new root or group applies to
past days too. Roamgate keeps no other mapping: where a workspace's time is
reported is the [time-report provider](./time-report.md)'s, corrected from the
timeline.

## Recorder sessions and retention

Each bridge run is a recorder session, stamped alive every 60 seconds. A clean
stop ends every open span (`recorder_stop`) and gap. On start, whatever a
previous run left open (it crashed or was killed) is ended at its last alive
stamp, and the time since the previous run ended is recorded as a recorder gap.

Once a day the bridge deletes events, gaps, sessions and unreferenced
workspaces older than `retention_days`, then returns freed space to the file
system a bounded amount at a time.

## Timeline

The bridge-global RPC `bridge.activity.timeline` (`{"from": "YYYY-MM-DD",
"to": "YYYY-MM-DD"}`, both included, at most 92 days; either alone means that
day, neither means today) returns `{"recording": false}` while the bridge does
not record, else the days of the range. A day runs from `day_start` to
`day_start` the next day, in the bridge's local time. Times are ISO 8601 with
the offset; durations are milliseconds. Each day has:

- `focus`: the attention spans clipped to the day, with `workspace_id`,
  `connection_id`, `pane_id`, `source` (`browser`, `phone` or `herdr`),
  `client_id`, the blur `reason` (null while `open`) and the focus `cause`. A span still open ends
  now (`open: true`), or at the recorder's last alive stamp when the recorder
  is not running.
- `attention`: who had the attention, without overlaps. At each instant the
  most recently started browser or phone span wins. Herdr's TUI spans only
  fill the time no browser or phone span covers, and only within
  `idle_seconds` of a sign of a person, since they run whether or not anyone
  looks: Herdr reports no attached client nor input time, and its output
  events cannot tell typing from a program writing. A sign is a browser or
  phone span a person opened (while it runs, and `idle_seconds` after it ends
  unless it ended as `idle` or with the recorder), input after idle or a page
  the user brought to the front, or a focus change in Herdr's TUI (a Herdr
  span opened by `herdr_event`, or ended with `switch` to one). Only the
  [causes](#causes) marked as signs count: a page loading, reloading or
  reconnecting, a view following Herdr or moved by Roamgate, Herdr's focus
  found in a listing, and what the recorder or a connection starts with are
  none. The rest of a Herdr span, and a browser span no person opened (in old
  logs), is in `focus` but not in `attention`.
- `idle`: per client, from `session.idle` to the client's next sign of life
  (`session.active`, a visibility change, or a new focus).
- `agents`: lanes per pane and agent, with the `working`, `blocked`, `idle` and
  `unknown` stretches between consecutive `agent.state` events. A lane starts
  from the last state before the range; connection and recorder gaps cut it;
  an agent's last `unknown` (its pane closed) ends the lane.
- `gaps`: `RecordingGap`s clipped to the day, including, while the recorder is
  not running, one from its last stamp (`reason: "recorder"`, `end: null`).
- `totals`: `attended_ms` (the `attention` segments), `idle_ms`,
  `unrecorded_ms` (recorder gaps), and per workspace `attended_ms` split into
  `browser_ms`, `phone_ms` and `herdr_ms` (Herdr's TUI within the attention
  above), plus `working_ms` and `blocked_ms`:
  the time at least one of its agents was in that state.

  `subjects` totals the same per subject (`subject_id` and `label` null for
  the workspaces with none), with `workspace_ids`; its `working_ms` and
  `blocked_ms` count an instant once however many of its workspaces' agents
  were in that state.

`workspaces` lists the workspaces the days refer to, with name, connection,
path, Herdr's current id and `subject`, and `recorder_running` says whether
open spans end now.

## Command line

`roamgate activity` reads `activity.sqlite` read-only, so it works without the
server running:

```sh
roamgate activity today [--by workspace|subject] [--json]
roamgate activity day 2026-11-02 [--by workspace|subject] [--json]
roamgate activity range 2026-10-26 2026-11-01 [--by workspace|subject] [--json]
roamgate activity events [--after ID] [--from T] [--to T] [--connection ID]
                         [--workspace ID] [--kind K[,K...]] [--limit N]
                         [--json | --ndjson]
roamgate activity workspaces [--from T] [--to T] [--connection ID] [--json]
roamgate activity status [--json]
```

- `today`, `day` and `range` print attended time (and how much of it came from
  Herdr's TUI) and agent working and blocked time per workspace, or per
  [subject](#subjects) with `--by subject`; `--json` prints the
  [timeline](#timeline), with both.
- `events` prints events in id order. `--json` prints an `ActivityPage`; when
  more events match, `next_cursor` is the last id, to pass to `--after`.
  `--ndjson` prints one `Event` per line. `--from` and `--to` take dates (day
  boundaries per `day_start`) or ISO 8601 times. `--limit` defaults to 1000, at
  most 5000.
- `workspaces` prints `{"workspaces": [Workspace]}` with `--json`: those with
  events in the range, with their subjects.
- `status` prints a `Status`: whether the log is recording (enabled and the
  recorder stamped alive in the last 150 seconds), the last alive stamp, each
  connection's state, and today's `RecordingGap`s.

Connections in `exclude.connections` are left out of everything but `status`.
Exit codes: 0 on success, 2 for invalid arguments, 1 otherwise. With `--json`
or `--ndjson`, errors are printed on stderr as `{"error": "message"}`.
